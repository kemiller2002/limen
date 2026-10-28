/// `wasm-check`: the .NET WebAssembly interpreter's per-method frame limit.
///
/// The pure core is tested against figures measured on the real Mono
/// WebAssembly interpreter (runtime pack 10.0.13, jiterpreter off,
/// MONO_INTERPRETER_OPTIONS=-ssa,-bblocks and defaults): the R5 commits of
/// kemiller2002/indy-init-rehearsal-005 and the controlled examples in
/// cli/tests/InterpreterFrame.Examples. A "boundary" below is the offset of
/// the first execution-stack variable the interpreter printed under
/// MONO_VERBOSE_METHOD, which is where its tier-0 locals area ends.
module Limen.Core.Tests.InterpreterFrameTests

open System.IO
open Xunit
open Limen.Core
open Limen.Core.Types
open Limen.Core.InterpreterFrame

let private methodWith (arguments: TypeShape list) (locals: TypeShape list) =
    { Assembly = "Guest.dll"
      DeclaringType = "Guest.View"
      Name = "project"
      Arguments = arguments
      Locals = locals
      ILBytes = 0 }

let private references count = List.replicate count ObjectReference

let private frameOf (structs: Map<string, StructFact>) arguments locals =
    (estimate structs (methodWith arguments locals)).FrameBytes

let private frame arguments locals = frameOf wellKnownStructs arguments locals

let private reportOf (methods: MethodFact list) =
    check
        10
        { Scanned = [ "Guest.dll" ]
          References = []
          Structs = Map.empty
          Methods = methods
          Problems = [] }

let private codes (report: FrameReport) =
    report.Findings |> List.map (fun finding -> finding.Code)

let private decimal = ValueType("System.Decimal", [])

let private decimals4 = ValueType("System.ValueTuple`4", List.replicate 4 decimal)

/// The struct examples' locals as the shell read them: three references, the
/// spilled ValueTuple<decimal x4> values, and six decimals.
let private structShapes tuples =
    references 3 @ List.replicate tuples decimals4 @ List.replicate 6 decimal

// ------------------------------------------------------------- the limit --

[<Fact>]
let ``the thresholds are the runtime's`` () =
    // transform.c: `if (td->total_locals_size >= G_MAXUINT16)`.
    Assert.Equal(65535, LocalsSizeLimitBytes)
    Assert.Equal(32768, WarningThresholdBytes)
    // sizeof(stackval), MINT_STACK_SLOT_SIZE.
    Assert.Equal(8, StackSlotBytes)

[<Theory>]
// Controlled examples: boundary printed by the interpreter.
[<InlineData(1, 297, 2400)>] // Small.project
[<InlineData(1, 7956, 63664)>] // LargeNear.project
[<InlineData(2, 6300, 50416)>] // GeneratedMatchNear.project
// R5 View.project: e02d000, ec6407b, and 80a0476, whose last local ends at
// 101,480 before transform.c aligns the total to 16.
[<InlineData(1, 7246, 57984)>]
[<InlineData(1, 8838, 70720)>]
[<InlineData(1, 12683, 101488)>]
let ``a reference local is one 8-byte slot after the arguments, aligned to 16`` (arguments: int) (locals: int) (boundary: int) =
    Assert.Equal(boundary, frame (references arguments) (references locals))

[<Fact>]
let ``R5: e02d000 starts, ec6407b fails, exactly as the interpreter decided`` () =
    let started = reportOf [ methodWith (references 1) (references 7246) ]
    let failed = reportOf [ methodWith (references 1) (references 8838) ]

    Assert.False(hasErrors started)
    Assert.Equal<string list>([ "LIMEN031" ], codes started)
    Assert.True(hasErrors failed)
    Assert.Equal<string list>([ "LIMEN030" ], codes failed)

[<Theory>]
[<InlineData(4092, "")>] // 32,752 bytes
[<InlineData(4093, "LIMEN031")>] // 32,760, aligned to 32,768
[<InlineData(8188, "LIMEN031")>] // 65,520
[<InlineData(8189, "LIMEN030")>] // 65,528, aligned to 65,536
let ``the error starts where the interpreter's limit does, the warning at half`` (locals: int) (expected: string) =
    let report = reportOf [ methodWith (references 1) (references locals) ]
    Assert.Equal<string list>((if expected = "" then [] else [ expected ]), codes report)

[<Fact>]
let ``every finding names the method, the figure, the source and the remedy`` () =
    let report = reportOf [ methodWith (references 1) (references 9000) ]
    let finding = List.exactlyOne report.Findings

    Assert.Contains("Guest.View::project", finding.Detail)
    Assert.Contains("72,016 bytes", finding.Detail)
    Assert.Contains("transform.c", finding.Detail)
    Assert.Contains("locals size too big", finding.Detail)
    Assert.Contains("NoInlining", finding.Remedy.Value)
    Assert.Contains("Split the method per area", finding.Remedy.Value)

[<Fact>]
let ``the largest methods are listed largest first`` () =
    let named name count =
        { methodWith (references 1) (references count) with Name = name }

    let report = reportOf [ named "a" 10; named "b" 300; named "c" 20 ]

    Assert.Equal<string list>(
        [ "Guest.View::b"; "Guest.View::c"; "Guest.View::a" ],
        report.Largest |> List.map (fun e -> qualifiedName e.Method)
    )

// ------------------------------------------------------------ value types --

[<Fact>]
let ``a value type is its wasm32 size rounded up to 8`` () =
    let slot shape = fst (slotBytes wellKnownStructs shape)

    Assert.Equal(64, slot decimals4)
    Assert.Equal(16, slot (ValueType("System.Guid", [])))
    // int64 then a reference (4 bytes on wasm32): 12, aligned to 8.
    Assert.Equal(16, slot (ValueType("System.Collections.Generic.KeyValuePair`2", [ Primitive 8; ObjectReference ])))
    // bool, padding to the decimal's 8-byte alignment, then 16 bytes.
    Assert.Equal(24, slot (ValueType("System.Nullable`1", [ ValueType("System.Decimal", []) ])))
    // Anything smaller than a slot still takes one.
    Assert.Equal(8, slot (ValueType("System.ValueTuple`2", [ Primitive 1; Primitive 2 ])))

[<Fact>]
let ``StructLocals: sized from fields it fails, as the interpreter did; counted at 8 bytes it would have passed`` () =
    // Measured: StructLocals.project failed with "locals size too big";
    // StructLocalsNear.project ran, its boundary at 62,544.
    let structLocals = methodWith (references 1) (structShapes 1134)
    let structLocalsNear = methodWith (references 1) (structShapes 975)

    Assert.Equal(72720, (estimate wellKnownStructs structLocals).FrameBytes)
    Assert.Equal(62544, (estimate wellKnownStructs structLocalsNear).FrameBytes)
    Assert.Equal<string list>([ "LIMEN030" ], codes (reportOf [ structLocals ]))
    Assert.Equal<string list>([ "LIMEN031" ], codes (reportOf [ structLocalsNear ]))
    // The naive count the report warned about: a false negative.
    Assert.True(frame (references 1) (references 1143) < WarningThresholdBytes)

[<Fact>]
let ``a value type defined by the guest is sized from its fields, generic arguments substituted`` () =
    let field shape =
        { Shape = shape
          ExplicitOffset = None }

    let structs =
        wellKnownStructs
        |> Map.add
            "Guest.Pair`2"
            { Name = "Guest.Pair`2"
              Fields = [ field (TypeParameter 0); field (TypeParameter 1); field (Primitive 4) ]
              DeclaredSize = None }
        |> Map.add
            "Guest.Kind"
            { Name = "Guest.Kind"
              Fields = [ field (Primitive 4) ]
              DeclaredSize = None }
        |> Map.add
            "Guest.Overlay"
            { Name = "Guest.Overlay"
              Fields =
                [ { Shape = Primitive 8; ExplicitOffset = Some 0 }
                  { Shape = Primitive 4; ExplicitOffset = Some 0 } ]
              DeclaredSize = None }
        |> Map.add
            "Guest.Buffer"
            { Name = "Guest.Buffer"
              Fields = [ field (Primitive 1) ]
              DeclaredSize = Some 100 }

    let slot shape = fst (slotBytes structs shape)

    // Pair<decimal, Guid>: 16 + 16 + 4, aligned to 8.
    Assert.Equal(40, slot (ValueType("Guest.Pair`2", [ ValueType("System.Decimal", []); ValueType("System.Guid", []) ])))
    Assert.Equal(8, slot (ValueType("Guest.Kind", [])))
    Assert.Equal(8, slot (ValueType("Guest.Overlay", [])))
    Assert.Equal(104, slot (ValueType("Guest.Buffer", [])))

[<Fact>]
let ``a value type that cannot be resolved is a lower bound, never a silent 8`` () =
    let unknown = ValueType("Elsewhere.Big", [])
    let report = reportOf [ methodWith (references 1) (List.replicate 9000 unknown) ]
    let estimateValue = List.exactlyOne report.Largest

    Assert.Equal<string list>([ "Elsewhere.Big" ], estimateValue.Unresolved)
    Assert.Equal<string list>([ "LIMEN030"; "LIMEN032" ], codes report)
    Assert.Contains("lower bound", report.Findings.Head.Detail)
    Assert.Contains("Elsewhere.Big", report.Findings.[1].Detail)

[<Fact>]
let ``an open generic parameter is reported on the method but not as a missing assembly`` () =
    let report = reportOf [ methodWith [ MethodParameter 0 ] (references 2) ]

    Assert.NotEmpty((List.exactlyOne report.Largest).Unresolved)
    Assert.Empty(report.Findings)

// ------------------------------------------------------------------ inputs --

[<Fact>]
let ``checking nothing is an error, not a pass`` () =
    let report =
        check
            10
            { Scanned = []
              References = []
              Structs = Map.empty
              Methods = []
              Problems = [ InputMissing "bin/Release/net10.0" ] }

    Assert.True(hasErrors report)
    Assert.Contains("LIMEN034", codes report)

[<Fact>]
let ``a Webcil file is skipped with a pointer to the .dll build output`` () =
    let report =
        check
            10
            { Scanned = [ "Guest.dll" ]
              References = []
              Structs = Map.empty
              Methods = []
              Problems = [ WebcilInput "_framework/Guest.wasm" ] }

    Assert.False(hasErrors report)
    let finding = List.exactlyOne report.Findings
    Assert.Equal("LIMEN033", finding.Code)
    Assert.Contains(".dll", finding.Remedy.Value)

// ------------------------------------------------------- reading metadata --

/// Read by the shell test below: its signature is fixed by the source, whatever
/// the configuration the tests are built in.
type Probe() =
    member _.Measure(pair: struct (int * int64), amount: decimal, label: string) = label, pair, amount

[<Fact>]
let ``the shell reads arguments, this and value types from a real assembly`` () =
    let path = typeof<Probe>.Assembly.Location
    let input = GuestAssemblies.read [ path ] []

    Assert.Equal<string list>([ path ], input.Scanned)

    let measure =
        input.Methods
        |> List.find (fun m -> m.DeclaringType.EndsWith "InterpreterFrameTests/Probe" && m.Name = "Measure")

    Assert.Equal<TypeShape list>(
        [ ObjectReference
          ValueType("System.ValueTuple`2", [ Primitive 4; Primitive 8 ])
          ValueType("System.Decimal", [])
          ObjectReference ],
        measure.Arguments
    )

    // this (8) + ValueTuple<int, int64> (16) + decimal (16) + string (8):
    // the argument area alone, whatever locals the build configuration adds.
    Assert.Equal(48, (estimate wellKnownStructs { measure with Locals = [] }).FrameBytes)

[<Fact>]
let ``the shell reports missing and Webcil inputs instead of guessing`` () =
    let directory = Path.Combine(Path.GetTempPath(), "limen-wasm-check-" + System.Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory directory |> ignore

    try
        let wasm = Path.Combine(directory, "Guest.wasm")
        File.WriteAllBytes(wasm, [| 0uy; 97uy; 115uy; 109uy |])
        let missing = Path.Combine(directory, "absent")
        let input = GuestAssemblies.read [ wasm; missing ] []

        Assert.Empty(input.Scanned)
        Assert.Contains(WebcilInput wasm, input.Problems)
        Assert.Contains(InputMissing missing, input.Problems)
        Assert.True(hasErrors (check 10 input))
    finally
        Directory.Delete(directory, true)

[<Fact>]
let ``framework assemblies in an output directory are references, not checked`` () =
    Assert.True(GuestAssemblies.isFrameworkAssembly "System.Private.CoreLib.dll")
    Assert.True(GuestAssemblies.isFrameworkAssembly "Microsoft.FSharp.Whatever.dll")
    Assert.False(GuestAssemblies.isFrameworkAssembly "FSharp.Core.dll")
    Assert.False(GuestAssemblies.isFrameworkAssembly "Causa.App.dll")

// ------------------------------------------------------ controlled examples --

/// The controlled examples (cli/tests/InterpreterFrame.Examples, built by .NET
/// SDK 10.0.402, F# 10) as the shell read them, and what the interpreter did
/// when each was called. `tuples` > 0 marks a struct example: its locals are
/// three references, that many ValueTuple<decimal x4> and six decimals.
/// Otherwise every local is a reference.
let controlledExamples: obj[] list =
    [ [| "Small.project"; 1; 297; 0; false |]
      [| "Large.project"; 1; 12852; 0; true |]
      [| "LargeNear.project"; 1; 7956; 0; false |]
      [| "LargeEdge.project"; 1; 8505; 0; true |]
      [| "Split.area00"; 1; 0; 0; false |]
      [| "Nested.project$cont@206"; 2; 15300; 0; true |]
      [| "Closures.project"; 1; 10081; 0; true |]
      [| "GeneratedMatch.project"; 2; 10080; 0; true |]
      [| "GeneratedMatchNear.project"; 2; 6300; 0; false |]
      [| "GeneratedMatchEdge.project"; 2; 8316; 0; true |]
      [| "StructLocals.project"; 1; 0; 1134; true |]
      [| "StructLocalsNear.project"; 1; 0; 975; false |] ]

[<Theory>]
[<MemberData(nameof controlledExamples)>]
let ``each controlled example is classified exactly as the interpreter decided`` (name: string) (arguments: int) (locals: int) (tuples: int) (failed: bool) =
    let shapes =
        if tuples > 0 then structShapes tuples else references locals

    let methodFact =
        { methodWith (references arguments) shapes with Name = name }

    Assert.Equal(failed, hasErrors (reportOf [ methodFact ]))
