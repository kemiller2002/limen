/// `verify` never passes vacuously.
///
/// A repository whose configuration checks no engine code used to report
/// "passed (strict)". It now gets the verdict `not-configured` and exit code 8,
/// unless it declares — with a rationale — that it has no Limen boundary, which
/// is the verdict `not-applicable` and exit code 0.
module Limen.Core.Tests.VerdictTests

open System.IO
open Xunit
open Limen.Core
open Limen.Core.Types

let private repositoryWith (configuration: string) (files: (string * string) list) =
    let root = Path.Combine(Path.GetTempPath(), "limen-verdict-" + System.Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory root |> ignore
    Operations.initialize root "1.0.0" false |> ignore
    File.WriteAllText(Path.Combine(root, Paths.configuration), configuration)

    for (path, content) in files do
        let full = Path.Combine(root, path)
        Directory.CreateDirectory(Path.GetDirectoryName full) |> ignore
        File.WriteAllText(full, content)

    root

let private verify strict root =
    Operations.verify strict "1.0.0" (Operations.inspectRepository root)

let private isNotConfigured =
    function
    | BoundaryNotConfigured _ -> true
    | _ -> false

[<Theory>]
[<InlineData(false)>]
[<InlineData(true)>]
let ``an empty boundary is not configured, not passed`` (strict: bool) =
    let root = repositoryWith """{"configurationVersion":1,"boundary":{"engine":[],"kernel":[]}}""" []

    let result = verify strict root

    Assert.Equal(NotConfigured, result.Verdict)
    Assert.False result.Ok
    Assert.Contains(result.Problems, isNotConfigured)
    Assert.Equal(0, result.EngineFilesChecked)

[<Fact>]
let ``engine paths that hold no source are not configured`` () =
    let root =
        repositoryWith """{"configurationVersion":1,"boundary":{"engine":["src/engine"],"kernel":["src/kernel"]}}""" [ "src/engine/README.md", "nothing yet"; "src/kernel/k.ts", "export const k = 1;" ]

    Assert.Equal(NotConfigured, (verify false root).Verdict)

[<Theory>]
[<InlineData(false)>]
[<InlineData(true)>]
let ``a declared absence of boundary, with a rationale, is not applicable and acceptable`` (strict: bool) =
    let root =
        repositoryWith
            """{"configurationVersion":1,"boundary":{"notApplicable":{"rationale":"Documentation site; no browser application."}}}"""
            []

    let result = verify strict root

    Assert.Equal(NotApplicable "Documentation site; no browser application.", result.Verdict)
    Assert.True(result.Ok, sprintf "%A" result.Problems)
    Assert.Empty result.Problems

[<Theory>]
[<InlineData("""{"configurationVersion":1,"boundary":{"notApplicable":{"rationale":"   "}}}""")>]
[<InlineData("""{"configurationVersion":1,"boundary":{"notApplicable":{}}}""")>]
[<InlineData("""{"configurationVersion":1,"boundary":{"engine":["src/engine"],"kernel":[],"notApplicable":{"rationale":"both"}}}""")>]
let ``an absence of boundary needs a reason and cannot be combined with a boundary`` (configuration: string) =
    let root = repositoryWith configuration []

    let result = verify false root

    Assert.Equal(Failed, result.Verdict)

    Assert.Contains(
        result.Problems,
        fun problem ->
            match problem with
            | ConfigurationUnreadable _ -> true
            | _ -> false
    )

[<Fact>]
let ``a configured boundary with engine code passes and counts what it checked`` () =
    let root =
        repositoryWith
            """{"configurationVersion":1,"boundary":{"engine":["src/engine","src/rules.ts"],"kernel":["src/kernel"]}}"""
            [ "src/engine/domain.ts", "export const add = (a: number, b: number) => a + b;"
              "src/rules.ts", "export const rule = 1;"
              "src/kernel/bridge.ts", "export const mount = () => document.body;" ]

    let result = verify true root

    Assert.Equal(Passed, result.Verdict)
    Assert.Equal(2, result.EngineFilesChecked)
    Assert.Equal(1, result.KernelFilesChecked)

[<Fact>]
let ``a single configured file is checked like a directory`` () =
    let root =
        repositoryWith
            """{"configurationVersion":1,"boundary":{"engine":["src/rules.ts"],"kernel":[]}}"""
            [ "src/rules.ts", "export const leak = () => localStorage.getItem(\"k\");" ]

    Assert.Equal(Failed, (verify false root).Verdict)

[<Fact>]
let ``any other problem outranks an unconfigured boundary`` () =
    Assert.Equal(Failed, State.verdictOf None [ BoundaryNotConfigured "x"; ManifestMissing ])
    Assert.Equal(NotConfigured, State.verdictOf None [ BoundaryNotConfigured "x" ])
    Assert.Equal(Passed, State.verdictOf None [])

[<Fact>]
let ``the not-applicable declaration round-trips through serialization`` () =
    let configuration =
        { ConfigurationVersion = 1
          Boundary = NoBoundary "No browser application." }

    match Configuration.parse Paths.configuration (Configuration.serialize configuration) with
    | Ok parsed -> Assert.Equal(configuration, parsed)
    | Error problem -> failwithf "expected a round trip, got %A" problem

[<Fact>]
let ``doctor explains an unconfigured boundary with a remedy`` () =
    let root = repositoryWith """{"configurationVersion":1,"boundary":{"engine":[],"kernel":[]}}""" []

    let findings = Operations.diagnose "1.0.0" (Operations.inspectRepository root)

    let finding = findings |> List.find (fun finding -> finding.Code = "LIMEN012")
    Assert.Equal(Severity.Error, finding.Severity)
    Assert.Contains("notApplicable", finding.Remedy.Value)

[<Fact>]
let ``verify exits 8 when not configured, 0 when not applicable, 3 when failed`` () =
    let notConfigured = repositoryWith """{"configurationVersion":1,"boundary":{"engine":[],"kernel":[]}}""" []

    let notApplicable =
        repositoryWith """{"configurationVersion":1,"boundary":{"notApplicable":{"rationale":"No browser application."}}}""" []

    let failed =
        repositoryWith
            """{"configurationVersion":1,"boundary":{"engine":["src/engine"],"kernel":[]}}"""
            [ "src/engine/leak.ts", "export const t = () => document.title;" ]

    let run root = Limen.Cli.Program.run [ "--root"; root; "--json"; "verify" ]

    Assert.Equal(ExitCodes.boundaryNotConfigured, run notConfigured)
    Assert.Equal(ExitCodes.success, run notApplicable)
    Assert.Equal(ExitCodes.verificationFailed, run failed)
