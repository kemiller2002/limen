/// Reading a guest's built assemblies into `InterpreterFrame` facts.
///
/// The I/O half of `wasm-check`, and deliberately thin: it opens files with
/// System.Reflection.Metadata (part of the shared framework, so no new
/// dependency, and free of reflection, so it survives trimming) and records
/// what the metadata says. Every decision is made by `InterpreterFrame.check`.
module Limen.Core.GuestAssemblies

open System
open System.IO
open System.Reflection
open System.Reflection.Metadata
open System.Reflection.Metadata.Ecma335
open System.Reflection.PortableExecutable
open Limen.Core.InterpreterFrame

/// Full type names as `wasm-check` keys them: `Namespace.Type`, nested types
/// as `Namespace.Outer/Nested`. A reference and the definition it resolves to
/// produce the same key, which is how value types are matched across
/// assemblies (type forwarding included) without loading anything.
module private InterpreterFrameNames =

    let private join (ns: string) (name: string) =
        if String.IsNullOrEmpty ns then name else ns + "." + name

    let rec ofDefinition (reader: MetadataReader) (handle: TypeDefinitionHandle) =
        let definition = reader.GetTypeDefinition handle
        let name = reader.GetString definition.Name
        let declaring = definition.GetDeclaringType()

        if declaring.IsNil then
            join (reader.GetString definition.Namespace) name
        else
            ofDefinition reader declaring + "/" + name

    let rec ofReference (reader: MetadataReader) (handle: TypeReferenceHandle) =
        let reference = reader.GetTypeReference handle
        let name = reader.GetString reference.Name
        let scope = reference.ResolutionScope

        if not scope.IsNil && scope.Kind = HandleKind.TypeReference then
            ofReference reader (TypeReferenceHandle.op_Explicit scope) + "/" + name
        else
            join (reader.GetString reference.Namespace) name

/// Signature decoding straight into `TypeShape`. Value type versus class comes
/// from the signature itself (VALUETYPE versus CLASS), so no type has to be
/// resolved to classify it.
let private shapes =
    { new ISignatureTypeProvider<TypeShape, unit> with
        member _.GetPrimitiveType code =
            match code with
            | PrimitiveTypeCode.Boolean
            | PrimitiveTypeCode.Byte
            | PrimitiveTypeCode.SByte -> Primitive 1
            | PrimitiveTypeCode.Char
            | PrimitiveTypeCode.Int16
            | PrimitiveTypeCode.UInt16 -> Primitive 2
            | PrimitiveTypeCode.Int32
            | PrimitiveTypeCode.UInt32
            | PrimitiveTypeCode.Single -> Primitive 4
            | PrimitiveTypeCode.Int64
            | PrimitiveTypeCode.UInt64
            | PrimitiveTypeCode.Double -> Primitive 8
            | PrimitiveTypeCode.IntPtr
            | PrimitiveTypeCode.UIntPtr -> Pointer
            // A TypedReference is a byref plus a type handle.
            | PrimitiveTypeCode.TypedReference -> Primitive 8
            | PrimitiveTypeCode.Void -> Primitive 0
            | _ -> ObjectReference

        member _.GetTypeFromDefinition(reader, handle, rawTypeKind) =
            if rawTypeKind = byte SignatureTypeKind.ValueType then
                ValueType(InterpreterFrameNames.ofDefinition reader handle, [])
            else
                ObjectReference

        member _.GetTypeFromReference(reader, handle, rawTypeKind) =
            if rawTypeKind = byte SignatureTypeKind.ValueType then
                ValueType(InterpreterFrameNames.ofReference reader handle, [])
            else
                ObjectReference

        member this.GetTypeFromSpecification(reader, context, handle, _) =
            reader.GetTypeSpecification(handle).DecodeSignature(this, context)

        member _.GetSZArrayType _ = ObjectReference
        member _.GetArrayType(_, _) = ObjectReference
        member _.GetByReferenceType _ = Pointer
        member _.GetPointerType _ = Pointer
        member _.GetFunctionPointerType _ = Pointer

        member _.GetGenericInstantiation(generic, arguments) =
            match generic with
            | ValueType (name, _) -> ValueType(name, List.ofSeq arguments)
            | other -> other

        member _.GetGenericTypeParameter(_, index) = TypeParameter index
        member _.GetGenericMethodParameter(_, index) = MethodParameter index
        member _.GetModifiedType(_, unmodified, _) = unmodified
        member _.GetPinnedType elementType = elementType }

let private isValueTypeDefinition (reader: MetadataReader) (definition: TypeDefinition) =
    let baseName =
        let handle = definition.BaseType

        if handle.IsNil then
            ""
        else
            match handle.Kind with
            | HandleKind.TypeReference -> InterpreterFrameNames.ofReference reader (TypeReferenceHandle.op_Explicit handle)
            | HandleKind.TypeDefinition -> InterpreterFrameNames.ofDefinition reader (TypeDefinitionHandle.op_Explicit handle)
            | _ -> ""

    baseName = "System.ValueType" || baseName = "System.Enum"

let private structsOf (reader: MetadataReader) =
    [ for handle in reader.TypeDefinitions do
          let definition = reader.GetTypeDefinition handle

          if isValueTypeDefinition reader definition then
              let explicitLayout =
                  definition.Attributes &&& TypeAttributes.LayoutMask = TypeAttributes.ExplicitLayout

              let fields =
                  [ for fieldHandle in definition.GetFields() do
                        let field = reader.GetFieldDefinition fieldHandle

                        if field.Attributes &&& FieldAttributes.Static <> FieldAttributes.Static then
                            let offset = field.GetOffset()

                            { Shape = field.DecodeSignature(shapes, ())
                              ExplicitOffset = if explicitLayout && offset >= 0 then Some offset else None } ]

              let layout = definition.GetLayout()
              let name = InterpreterFrameNames.ofDefinition reader handle

              yield
                  name,
                  { Name = name
                    Fields = fields
                    DeclaredSize = if layout.Size > 0 then Some layout.Size else None } ]

let private methodsOf (assemblyName: string) (pe: PEReader) (reader: MetadataReader) =
    [ for typeHandle in reader.TypeDefinitions do
          let definition = reader.GetTypeDefinition typeHandle
          let typeName = InterpreterFrameNames.ofDefinition reader typeHandle
          let declaringIsValueType = isValueTypeDefinition reader definition

          for methodHandle in definition.GetMethods() do
              let methodDefinition = reader.GetMethodDefinition methodHandle

              if methodDefinition.RelativeVirtualAddress <> 0 then
                  let body = pe.GetMethodBody methodDefinition.RelativeVirtualAddress
                  let signature = methodDefinition.DecodeSignature(shapes, ())

                  let self =
                      let header = signature.Header

                      if header.IsInstance then
                          // `this` is a managed pointer for a value type's
                          // instance method, a reference otherwise: one slot.
                          [ (if declaringIsValueType then Pointer else ObjectReference) ]
                      else
                          []

                  let locals =
                      if body.LocalSignature.IsNil then
                          []
                      else
                          reader
                              .GetStandaloneSignature(body.LocalSignature)
                              .DecodeLocalSignature(shapes, ())
                          |> List.ofSeq

                  yield
                      { Assembly = assemblyName
                        DeclaringType = typeName
                        Name = reader.GetString methodDefinition.Name
                        Arguments = self @ List.ofSeq signature.ParameterTypes
                        Locals = locals
                        ILBytes = body.Size } ]

type private Loaded =
    | Read of path: string * structs: (string * StructFact) list * methods: MethodFact list
    | Skipped of InputProblem

/// Read one file. `withMethods` is false for a reference assembly, which only
/// contributes value-type definitions.
let private load (withMethods: bool) (path: string) =
    if path.EndsWith(".wasm", StringComparison.OrdinalIgnoreCase) then
        Skipped(WebcilInput path)
    else
        try
            use stream = File.OpenRead path
            use pe = new PEReader(stream)

            if not pe.HasMetadata then
                Skipped(NotAnAssembly(path, "no .NET metadata"))
            else
                let reader = pe.GetMetadataReader()
                let name = Path.GetFileName path

                Read(
                    path,
                    structsOf reader,
                    (if withMethods then methodsOf name pe reader else [])
                )
        with error ->
            Skipped(NotAnAssembly(path, error.Message))

/// Framework assemblies in a guest's output are read for value-type
/// definitions but not checked: they are the runtime's, not the guest's.
let isFrameworkAssembly (fileName: string) =
    let name = Path.GetFileNameWithoutExtension fileName

    name.StartsWith("System.", StringComparison.Ordinal)
    || name.StartsWith("Microsoft.", StringComparison.Ordinal)
    || name = "System"
    || name = "mscorlib"
    || name = "netstandard"
    || name = "WindowsBase"

let private assembliesIn (directory: string) =
    Directory.GetFiles(directory, "*.dll") |> Array.sort |> List.ofArray

let private nugetRoot () =
    match Environment.GetEnvironmentVariable "NUGET_PACKAGES" with
    | value when not (String.IsNullOrWhiteSpace value) -> value
    | _ -> Path.Combine(Environment.GetFolderPath Environment.SpecialFolder.UserProfile, ".nuget", "packages")

/// Package assemblies a build output depends on but does not copy (a library
/// build leaves FSharp.Core in the NuGet cache), found through the output's
/// `*.deps.json`: each package library's runtime assets under the cache.
let packageAssemblies (directory: string) =
    let root = nugetRoot ()

    let fromDeps (depsFile: string) =
        match Json.tryParse (File.ReadAllText depsFile) with
        | Error _ -> []
        | Ok document ->
            use document = document
            let rootElement = document.RootElement

            let packagePaths =
                match Json.tryProperty "libraries" rootElement with
                | Some libraries ->
                    [ for library in libraries.EnumerateObject() do
                          match Json.tryProperty "type" library.Value |> Option.bind Json.tryString,
                                Json.tryProperty "path" library.Value |> Option.bind Json.tryString with
                          | Some "package", Some packagePath -> yield library.Name, packagePath
                          | _ -> () ]
                    |> Map.ofList
                | None -> Map.empty

            match Json.tryProperty "targets" rootElement with
            | None -> []
            | Some targets ->
                [ for target in targets.EnumerateObject() do
                      for library in target.Value.EnumerateObject() do
                          match Map.tryFind library.Name packagePaths, Json.tryProperty "runtime" library.Value with
                          | Some packagePath, Some runtime ->
                              for asset in runtime.EnumerateObject() do
                                  let file = Path.Combine(root, packagePath, asset.Name)

                                  if File.Exists file then
                                      yield file
                          | _ -> () ]

    if Directory.Exists directory then
        Directory.GetFiles(directory, "*.deps.json")
        |> List.ofArray
        |> List.collect (fun depsFile ->
            try
                fromDeps depsFile
            with _ ->
                [])
        |> List.distinct
    else
        []

/// The default framework references: the newest browser-wasm runtime pack in
/// the NuGet cache, which is the runtime a Limen guest actually runs on. Its
/// `lib/<tfm>` directory holds the framework assemblies and `native` holds
/// System.Private.CoreLib, where DateTime, Decimal and the like are defined.
/// Empty when no pack is cached.
let defaultRuntimePack () =
    let root = nugetRoot ()

    let pack = Path.Combine(root, "microsoft.netcore.app.runtime.mono.browser-wasm")

    if not (Directory.Exists pack) then
        []
    else
        Directory.GetDirectories pack
        |> Array.choose (fun versionDirectory ->
            match Version.TryParse(Path.GetFileName(versionDirectory).Split('-').[0]) with
            | true, version -> Some(version, versionDirectory)
            | _ -> None)
        |> Array.sortByDescending fst
        |> Array.tryPick (fun (_, versionDirectory) ->
            let runtime = Path.Combine(versionDirectory, "runtimes", "browser-wasm")
            let lib = Path.Combine(runtime, "lib")
            let native = Path.Combine(runtime, "native")

            if Directory.Exists lib then
                Directory.GetDirectories lib
                |> Array.sortDescending
                |> Array.tryHead
                |> Option.map (fun framework -> [ framework; native ] |> List.filter Directory.Exists)
            else
                None)
        |> Option.defaultValue []

/// Read every input and reference. `inputs` are files or directories; a
/// directory contributes its top-level `.dll` files, framework assemblies as
/// references only, and the package assemblies its `*.deps.json` names as
/// references.
let read (inputs: string list) (references: string list) : ScanInput =
    let expanded =
        inputs
        |> List.collect (fun input ->
            if Directory.Exists input then
                assembliesIn input
                |> List.map (fun path -> (not (isFrameworkAssembly path)), path)
            elif File.Exists input then
                [ true, input ]
            else
                [ false, input ])

    let missing =
        inputs
        |> List.filter (fun input -> not (Directory.Exists input || File.Exists input))
        |> List.map InputMissing

    let checkedFiles =
        expanded |> List.filter fst |> List.map snd

    let packages =
        inputs
        |> List.collect (fun input ->
            if Directory.Exists input then packageAssemblies input
            elif File.Exists input then packageAssemblies (Path.GetDirectoryName(Path.GetFullPath input))
            else [])
        |> List.distinct

    let referenceFiles =
        (expanded |> List.filter (fun (scan, path) -> not scan && File.Exists path) |> List.map snd)
        @ packages
        @ (references
           |> List.collect (fun reference ->
               if Directory.Exists reference then assembliesIn reference
               elif File.Exists reference then [ reference ]
               else []))

    let checkedLoads = checkedFiles |> List.map (load true)
    let referenceLoads = referenceFiles |> List.map (load false)

    // Definitions from the checked assemblies win over references, which win
    // over the built-in table: the closer to the guest, the more authoritative.
    let structs =
        (referenceLoads @ checkedLoads)
        |> List.collect (function
            | Read (_, structs, _) -> structs
            | Skipped _ -> [])
        |> Map.ofList

    { Scanned =
        checkedLoads
        |> List.choose (function
            | Read (path, _, _) -> Some path
            | Skipped _ -> None)
      References = references @ packages
      Structs = structs
      Methods =
        checkedLoads
        |> List.collect (function
            | Read (_, _, methods) -> methods
            | Skipped _ -> [])
      Problems =
        missing
        @ (checkedLoads
           |> List.choose (function
               | Skipped problem -> Some problem
               | Read _ -> None)) }
