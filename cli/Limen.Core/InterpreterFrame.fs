/// `wasm-check`: the .NET WebAssembly interpreter's per-method frame limit.
///
/// A .NET guest running in the browser on the Mono interpreter refuses to run a
/// method whose interpreter frame reaches 65,535 bytes. It throws
/// `InvalidProgramException: ... locals size too big` the first time the
/// method is called. CoreCLR, where unit tests run, has no such limit, so the
/// failure is invisible until the WebAssembly build starts in a browser.
///
/// This module is the pure half of the check: metadata facts in, findings out.
/// It reads nothing. `GuestAssemblies` turns built assemblies into the facts.
///
/// The model (dotnet/runtime release/10.0, src/mono/mono/mini/interp/):
///   * transform.c `generate()` (line 9807): if `td->total_locals_size >=
///     G_MAXUINT16`, the method is compiled once more with optimization on and
///     inlining off; if that also overflows, it throws "locals size too big".
///   * At tier 0 (the first call) `interp_method_compute_offsets` (line 4662)
///     gives every argument and every IL local its own slot, with no reuse:
///     8 bytes (MINT_STACK_SLOT_SIZE = sizeof(stackval), interp-internals.h)
///     for a reference, a primitive or an enum, and `mono_type_size` aligned to
///     8 for any other value type. The arguments are aligned to 16
///     (MINT_STACK_ALIGNMENT), then the IL locals follow, then the total is
///     aligned to 16 again.
/// Measured against the runtime, this gave the exact boundary of the locals
/// area for every method checked, including the Causa `View.project` that
/// failed (101,480 bytes) and the one that started (57,984).
module Limen.Core.InterpreterFrame

open Limen.Core.Types

// --------------------------------------------------------------- constants --

/// `MINT_STACK_SLOT_SIZE`, `sizeof(stackval)`: the smallest interpreter
/// variable slot, and the unit every slot is rounded up to.
[<Literal>]
let StackSlotBytes = 8

/// `MINT_STACK_ALIGNMENT` (16): the argument area and the whole tier-0 locals
/// area are each aligned to it.
[<Literal>]
let FrameAlignmentBytes = 16

/// `G_MAXUINT16`. transform.c `generate()` (release/10.0 line 9807) fails a
/// method when `td->total_locals_size >= G_MAXUINT16`: variable offsets are
/// 16-bit operands in the compacted interpreter code.
[<Literal>]
let LocalsSizeLimitBytes = 65535

/// Half of the limit. A warning here leaves room to grow: Causa's projection
/// gained about 1,600 IL locals (12,800 bytes) per feature commit.
[<Literal>]
let WarningThresholdBytes = 32768

/// Pointer size inside a value type's layout on browser-wasm (wasm32).
[<Literal>]
let PointerBytes = 4

/// Deepest value-type nesting followed before a type is reported unresolved.
[<Literal>]
let private MaximumNestingDepth = 32

// ------------------------------------------------------------------- facts --

/// A type as it appears in a signature, reduced to what decides its size.
type TypeShape =
    /// A primitive of the given size in bytes (bool 1 ... int64/double 8).
    | Primitive of bytes: int
    /// A class, interface, string, array or object: one pointer.
    | ObjectReference
    /// A native integer, unmanaged pointer, function pointer or managed byref:
    /// one pointer.
    | Pointer
    /// A value type by full name (`Namespace.Outer/Nested`), with its generic
    /// arguments when it is an instantiation.
    | ValueType of name: string * arguments: TypeShape list
    /// The i-th generic parameter of the enclosing type.
    | TypeParameter of index: int
    /// The i-th generic parameter of the enclosing method.
    | MethodParameter of index: int

/// One instance field of a value type.
type FieldFact =
    { Shape: TypeShape
      /// The explicit `FieldOffset`, when the type has explicit layout.
      ExplicitOffset: int option }

/// A value type's definition: enough to compute its wasm32 size.
type StructFact =
    { Name: string
      Fields: FieldFact list
      /// `ClassLayout.Size` when it is set (a fixed-size buffer, for example).
      DeclaredSize: int option }

/// One method with a body.
type MethodFact =
    { Assembly: string
      /// `Namespace.Type` or `Namespace.Outer/Nested`.
      DeclaringType: string
      Name: string
      /// Every argument, including `this` for an instance method.
      Arguments: TypeShape list
      /// Every IL local, in declaration order.
      Locals: TypeShape list
      ILBytes: int }

// ----------------------------------------------------------------- sizing --

/// A size and an alignment, plus the names of any value types whose size
/// could not be resolved. When `Unresolved` is not empty, `Bytes` is a lower
/// bound.
type Layout =
    { Bytes: int
      Alignment: int
      Unresolved: Set<string> }

let private alignUp (value: int) (alignment: int) =
    if alignment <= 1 then value else (value + alignment - 1) / alignment * alignment

let private pointerLayout =
    { Bytes = PointerBytes
      Alignment = PointerBytes
      Unresolved = Set.empty }

/// A type whose size is unknown counts as one pointer — the smallest a slot
/// can be — and carries its name so the report can say the figure is a lower
/// bound rather than silently undercounting.
let private unresolvedLayout (name: string) =
    { pointerLayout with Unresolved = Set.singleton name }

let rec private substitute (arguments: TypeShape list) (shape: TypeShape) =
    match shape with
    | TypeParameter index when index < List.length arguments -> List.item index arguments
    | ValueType (name, inner) -> ValueType(name, inner |> List.map (substitute arguments))
    | other -> other

let private displayName (shape: TypeShape) =
    match shape with
    | ValueType (name, _) -> name
    | TypeParameter index -> sprintf "!%d (generic type parameter)" index
    | MethodParameter index -> sprintf "!!%d (generic method parameter)" index
    | Primitive bytes -> sprintf "primitive(%d)" bytes
    | ObjectReference -> "object"
    | Pointer -> "pointer"

/// The wasm32 size and alignment of a type, given the value types known.
let rec layoutOf (structs: Map<string, StructFact>) (depth: int) (shape: TypeShape) : Layout =
    match shape with
    | Primitive bytes ->
        { Bytes = bytes
          Alignment = max 1 (min bytes 8)
          Unresolved = Set.empty }
    | ObjectReference
    | Pointer -> pointerLayout
    // A generic parameter left open in a method body: the interpreter
    // compiles a separate instantiation per value-type argument, which can be
    // larger than a pointer. Its size is unknown here.
    | TypeParameter _
    | MethodParameter _ -> unresolvedLayout (displayName shape)
    | ValueType (name, arguments) ->
        match Map.tryFind name structs with
        | Some definition when depth < MaximumNestingDepth -> structLayout structs depth definition arguments
        | _ -> unresolvedLayout name

and private structLayout (structs: Map<string, StructFact>) (depth: int) (definition: StructFact) (arguments: TypeShape list) =
    let fields =
        definition.Fields
        |> List.map (fun field -> field, layoutOf structs (depth + 1) (substitute arguments field.Shape))

    let alignment =
        fields |> List.fold (fun acc (_, layout) -> max acc layout.Alignment) 1

    let unresolved =
        fields |> List.fold (fun acc (_, layout) -> Set.union acc layout.Unresolved) Set.empty

    let explicitLayout =
        fields |> List.exists (fun (field, _) -> field.ExplicitOffset.IsSome)

    let extent =
        if explicitLayout then
            fields
            |> List.fold
                (fun acc (field, layout) -> max acc (defaultArg field.ExplicitOffset 0 + layout.Bytes))
                0
        else
            fields
            |> List.fold (fun offset (_, layout) -> alignUp offset layout.Alignment + layout.Bytes) 0

    // An empty struct still occupies a byte.
    let natural = max 1 (alignUp extent alignment)

    { Bytes = max natural (defaultArg definition.DeclaredSize 0)
      Alignment = alignment
      Unresolved = unresolved }

/// The interpreter variable slot a type takes: its size rounded up to 8.
let slotBytes (structs: Map<string, StructFact>) (shape: TypeShape) =
    let layout = layoutOf structs 0 shape
    max StackSlotBytes (alignUp layout.Bytes StackSlotBytes), layout.Unresolved

/// Value types the CLI can size without the framework's own assemblies, in
/// their browser-wasm (wasm32) layout. A definition read from an assembly
/// always replaces one of these.
let wellKnownStructs: Map<string, StructFact> =
    let field shape = { Shape = shape; ExplicitOffset = None }

    let definition name shapes =
        name,
        { Name = name
          Fields = shapes |> List.map field
          DeclaredSize = None }

    let parameters count = List.init count TypeParameter

    [ definition "System.Boolean" [ Primitive 1 ]
      definition "System.Byte" [ Primitive 1 ]
      definition "System.SByte" [ Primitive 1 ]
      definition "System.Char" [ Primitive 2 ]
      definition "System.Int16" [ Primitive 2 ]
      definition "System.UInt16" [ Primitive 2 ]
      definition "System.Int32" [ Primitive 4 ]
      definition "System.UInt32" [ Primitive 4 ]
      definition "System.Single" [ Primitive 4 ]
      definition "System.Int64" [ Primitive 8 ]
      definition "System.UInt64" [ Primitive 8 ]
      definition "System.Double" [ Primitive 8 ]
      definition "System.IntPtr" [ Pointer ]
      definition "System.UIntPtr" [ Pointer ]
      definition "System.Half" [ Primitive 2 ]
      definition "System.Int128" [ Primitive 8; Primitive 8 ]
      definition "System.UInt128" [ Primitive 8; Primitive 8 ]
      definition "System.Decimal" [ Primitive 4; Primitive 4; Primitive 8 ]
      definition "System.Guid" ([ Primitive 4; Primitive 2; Primitive 2 ] @ List.replicate 8 (Primitive 1))
      definition "System.DateTime" [ Primitive 8 ]
      definition "System.TimeSpan" [ Primitive 8 ]
      definition "System.DateTimeOffset" [ ValueType("System.DateTime", []); Primitive 2 ]
      definition "System.DateOnly" [ Primitive 4 ]
      definition "System.TimeOnly" [ Primitive 8 ]
      definition "System.Index" [ Primitive 4 ]
      definition "System.Range" [ ValueType("System.Index", []); ValueType("System.Index", []) ]
      definition "System.RuntimeTypeHandle" [ Pointer ]
      definition "System.RuntimeMethodHandle" [ Pointer ]
      definition "System.RuntimeFieldHandle" [ Pointer ]
      definition "System.Threading.CancellationToken" [ ObjectReference ]
      definition "System.Threading.Tasks.ValueTask" [ ObjectReference; Primitive 2; Primitive 1 ]
      definition "System.Threading.Tasks.ValueTask`1" [ ObjectReference; TypeParameter 0; Primitive 2; Primitive 1 ]
      definition "System.Nullable`1" [ Primitive 1; TypeParameter 0 ]
      definition "System.Span`1" [ Pointer; Primitive 4 ]
      definition "System.ReadOnlySpan`1" [ Pointer; Primitive 4 ]
      definition "System.Memory`1" [ ObjectReference; Primitive 4; Primitive 4 ]
      definition "System.ReadOnlyMemory`1" [ ObjectReference; Primitive 4; Primitive 4 ]
      definition "System.ArraySegment`1" [ ObjectReference; Primitive 4; Primitive 4 ]
      definition "System.Collections.Generic.KeyValuePair`2" (parameters 2)
      definition "System.Collections.Generic.List`1/Enumerator" [ ObjectReference; Primitive 4; Primitive 4; TypeParameter 0 ]
      definition
          "System.Collections.Generic.Dictionary`2/Enumerator"
          [ ObjectReference
            Primitive 4
            Primitive 4
            ValueType("System.Collections.Generic.KeyValuePair`2", parameters 2)
            Primitive 4 ]
      definition "System.Collections.Immutable.ImmutableArray`1" [ ObjectReference ]
      for arity in 1..8 do
          definition (sprintf "System.ValueTuple`%d" arity) (parameters arity) ]
    |> Map.ofList

// --------------------------------------------------------------- estimate --

/// The estimated tier-0 interpreter frame of one method.
type FrameEstimate =
    { Method: MethodFact
      /// The tier-0 locals area in bytes: arguments aligned to 16, plus IL
      /// locals, aligned to 16. A lower bound when `Unresolved` is not empty.
      FrameBytes: int
      /// Locals whose slot is larger than 8 bytes (value types).
      WideLocals: int
      Unresolved: string list }

let estimate (structs: Map<string, StructFact>) (methodFact: MethodFact) =
    let argumentSlots = methodFact.Arguments |> List.map (slotBytes structs)
    let localSlots = methodFact.Locals |> List.map (slotBytes structs)
    let slots = argumentSlots @ localSlots

    // transform.c `interp_method_compute_offsets`: arguments, aligned to 16,
    // then the IL locals, aligned to 16.
    let total =
        alignUp (argumentSlots |> List.sumBy fst) FrameAlignmentBytes
        + (localSlots |> List.sumBy fst)

    let wide =
        localSlots |> List.filter (fun (bytes, _) -> bytes > StackSlotBytes) |> List.length

    { Method = methodFact
      FrameBytes = alignUp total FrameAlignmentBytes
      WideLocals = wide
      Unresolved = slots |> List.fold (fun acc (_, names) -> Set.union acc names) Set.empty |> Set.toList }

// ---------------------------------------------------------------- findings --

/// Something that stopped an input from being read.
type InputProblem =
    /// A `.wasm` file: Webcil-wrapped, as the WebAssembly SDK ships assemblies.
    | WebcilInput of path: string
    | NotAnAssembly of path: string * reason: string
    | InputMissing of path: string

/// Everything the reading shell found.
type ScanInput =
    { Scanned: string list
      References: string list
      Structs: Map<string, StructFact>
      Methods: MethodFact list
      Problems: InputProblem list }

/// The result of `wasm-check`.
type FrameReport =
    { Assemblies: string list
      References: string list
      MethodsScanned: int
      /// The largest frames, largest first.
      Largest: FrameEstimate list
      Findings: Diagnosis list }

let qualifiedName (methodFact: MethodFact) =
    sprintf "%s::%s" methodFact.DeclaringType methodFact.Name

let private thousands (value: int) =
    value.ToString("N0", System.Globalization.CultureInfo.InvariantCulture)

let private lowerBoundNote (estimateValue: FrameEstimate) =
    match estimateValue.Unresolved with
    | [] -> ""
    | names ->
        sprintf
            " This is a lower bound: the size of %s could not be resolved (pass --reference with the assembly that defines it)."
            (names |> List.truncate 5 |> String.concat ", ")

let private remedy =
    "Split the method per area into separate top-level functions, each projecting one part, and mark the small helpers it calls [<MethodImpl(MethodImplOptions.NoInlining)>]: in Release the F# compiler inlines them and every inlined temporary becomes its own IL local, which the interpreter never reuses at the first call. Re-run `limen wasm-check`, then confirm with a startup smoke of the WebAssembly build."

let private describe (estimateValue: FrameEstimate) =
    let methodFact = estimateValue.Method

    sprintf
        "%s in %s: estimated tier-0 interpreter frame %s bytes (%d argument(s) + %d IL local(s)%s, %s IL bytes)."
        (qualifiedName methodFact)
        methodFact.Assembly
        (thousands estimateValue.FrameBytes)
        (List.length methodFact.Arguments)
        (List.length methodFact.Locals)
        (if estimateValue.WideLocals > 0 then
             sprintf ", %d of them value types wider than 8 bytes" estimateValue.WideLocals
         else
             "")
        (thousands methodFact.ILBytes)

let private overLimit (estimateValue: FrameEstimate) =
    { Severity = Severity.Error
      Code = "LIMEN030"
      Title = "A method exceeds the .NET WebAssembly interpreter's locals limit"
      Detail =
        sprintf
            "%s The Mono interpreter refuses a method whose frame reaches %s bytes (G_MAXUINT16, dotnet/runtime src/mono/mono/mini/interp/transform.c). It throws InvalidProgramException \"locals size too big\" the first time the method is called, unless one retry with optimization on and inlining off happens to fit; that retry fitted none of the measured cases.%s"
            (describe estimateValue)
            (thousands LocalsSizeLimitBytes)
            (lowerBoundNote estimateValue)
      Remedy = Some remedy }

let private nearLimit (estimateValue: FrameEstimate) =
    { Severity = Severity.Warning
      Code = "LIMEN031"
      Title = "A method is past half of the .NET WebAssembly interpreter's locals limit"
      Detail =
        sprintf
            "%s The limit is %s bytes; this warning starts at %s. Methods that grow by a few features at a time cross the limit without a source-size signal.%s"
            (describe estimateValue)
            (thousands LocalsSizeLimitBytes)
            (thousands WarningThresholdBytes)
            (lowerBoundNote estimateValue)
      Remedy = Some remedy }

let private unresolvedSummary (estimates: FrameEstimate list) =
    let affected =
        estimates
        |> List.filter (fun e ->
            e.Unresolved
            |> List.exists (fun name -> not (name.StartsWith "!")))

    match affected with
    | [] -> []
    | _ ->
        let names =
            affected
            |> List.collect (fun e -> e.Unresolved)
            |> List.filter (fun name -> not (name.StartsWith "!"))
            |> List.countBy id
            |> List.sortByDescending snd
            |> List.map fst

        [ { Severity = Severity.Information
            Code = "LIMEN032"
            Title = "Some value-type sizes could not be resolved"
            Detail =
              sprintf
                  "%d method(s) have a local or argument of a value type defined in an assembly that was not read (%s%s). Each counts as 8 bytes, so those frames are lower bounds."
                  (List.length affected)
                  (names |> List.truncate 8 |> String.concat ", ")
                  (if List.length names > 8 then sprintf " and %d more" (List.length names - 8) else "")
            Remedy =
              Some
                  "Pass the directory holding those assemblies with --reference, for example the browser-wasm runtime pack (~/.nuget/packages/microsoft.netcore.app.runtime.mono.browser-wasm/<version>/runtimes/browser-wasm/lib/<tfm>)." } ]

let private inputFinding (problem: InputProblem) =
    match problem with
    | WebcilInput path ->
        { Severity = Severity.Warning
          Code = "LIMEN033"
          Title = "A WebAssembly-packaged assembly was skipped"
          Detail =
            sprintf
                "%s is a Webcil-wrapped assembly, as the .NET WebAssembly SDK ships them under _framework; it was not read."
                path
          Remedy = Some "Point wasm-check at the build output's .dll files instead (bin/<Configuration>/<tfm>/ or obj/), which hold the same IL." }
    | NotAnAssembly (path, reason) ->
        { Severity = Severity.Warning
          Code = "LIMEN033"
          Title = "An input could not be read as a .NET assembly"
          Detail = sprintf "%s: %s" path reason
          Remedy = Some "Pass the guest's built .dll files, or the directory that holds them." }
    | InputMissing path ->
        { Severity = Severity.Error
          Code = "LIMEN034"
          Title = "An input does not exist"
          Detail = sprintf "%s was named on the command line but is not on disk." path
          Remedy = Some "Build the guest first (dotnet build -c Release), then pass its output directory." }

let private nothingScanned =
    { Severity = Severity.Error
      Code = "LIMEN034"
      Title = "No guest assembly was checked"
      Detail = "None of the inputs produced a readable .NET assembly, so nothing was checked. A check that checks nothing is not a pass."
      Remedy = Some "Build the guest (dotnet build -c Release) and pass its .dll or its output directory." }

/// Decide the report from the facts. Pure.
let check (top: int) (input: ScanInput) : FrameReport =
    let structs =
        input.Structs
        |> Map.fold (fun acc name definition -> Map.add name definition acc) wellKnownStructs

    let estimates =
        input.Methods
        |> List.map (estimate structs)
        |> List.sortByDescending (fun e -> e.FrameBytes)

    let methodFindings =
        estimates
        |> List.choose (fun e ->
            if e.FrameBytes >= LocalsSizeLimitBytes then Some(overLimit e)
            elif e.FrameBytes >= WarningThresholdBytes then Some(nearLimit e)
            else None)

    let coverage =
        if List.isEmpty input.Scanned then [ nothingScanned ] else []

    let order severity =
        match severity with
        | Severity.Error -> 0
        | Severity.Warning -> 1
        | Severity.Information -> 2

    { Assemblies = input.Scanned
      References = input.References
      MethodsScanned = List.length input.Methods
      Largest = estimates |> List.truncate (max 0 top)
      Findings =
        coverage @ methodFindings @ (input.Problems |> List.map inputFinding) @ unresolvedSummary estimates
        |> List.sortBy (fun finding -> order finding.Severity) }

let hasErrors (report: FrameReport) =
    report.Findings |> List.exists (fun finding -> finding.Severity = Severity.Error)
