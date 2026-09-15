/// End-to-end lifecycle tests against a real temporary repository.
///
/// The planner tests prove the decisions; these prove that executing those
/// decisions actually produces the files, and that reading them back gives the
/// state the tool claimed. They use the disk deliberately — an in-memory pass
/// would not catch a path joined wrongly or a directory never created.
module Limen.Core.Tests.LifecycleTests

open System.IO
open Xunit
open Limen.Core
open Limen.Core.Types

let private newRepository () =
    let root = Path.Combine(Path.GetTempPath(), "limen-lifecycle-" + System.Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory root |> ignore
    Directory.CreateDirectory(Path.Combine(root, "src", "engine")) |> ignore
    Directory.CreateDirectory(Path.Combine(root, "src", "kernel")) |> ignore
    File.WriteAllText(Path.Combine(root, "src", "engine", "domain.ts"), "export const add = (a: number, b: number) => a + b;\n")
    File.WriteAllText(Path.Combine(root, "src", "kernel", "bridge.ts"), "export const mount = () => document.body;\n")
    root

/// A stable fingerprint of everything in the repository.
let private fingerprint root =
    Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
    |> Seq.sort
    |> Seq.map (fun file ->
        Path.GetRelativePath(root, file) + ":" + Hashing.sha256OfString (File.ReadAllText file))
    |> String.concat "\n"

[<Fact>]
let ``init installs, and a second init changes nothing at all`` () =
    let root = newRepository ()

    let first = Operations.initialize root "1.0.0" false
    Assert.Empty first.Plan.Conflicts
    Assert.True(File.Exists(Path.Combine(root, Paths.manifest)))
    Assert.True(File.Exists(Path.Combine(root, Paths.configuration)))
    Assert.True(File.Exists(Path.Combine(root, Paths.workflow)))

    let after = fingerprint root
    let second = Operations.initialize root "1.0.0" false

    Assert.True(Plan.isNoOp second.Plan, sprintf "second init planned %A" second.Plan.Changes)
    Assert.Equal(after, fingerprint root)

[<Fact>]
let ``a dry run writes absolutely nothing`` () =
    let root = newRepository ()
    let before = fingerprint root

    let result = Operations.initialize root "1.0.0" true

    Assert.NotEmpty result.Plan.Changes
    Assert.True(result.Execution.IsNone)
    Assert.Equal(before, fingerprint root)
    Assert.False(File.Exists(Path.Combine(root, Paths.manifest)))

[<Fact>]
let ``a fresh installation verifies, strictly`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore

    let snapshot = Operations.inspectRepository root
    let verification = Operations.verify true "1.0.0" snapshot

    Assert.True(verification.Ok, sprintf "expected strict verification to pass, got %A" verification.Problems)

[<Fact>]
let ``verification fails when engine code reaches for the browser`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore

    File.WriteAllText(Path.Combine(root, "src", "engine", "leak.ts"), "export const t = () => document.title;\n")

    let verification = Operations.verify false "1.0.0" (Operations.inspectRepository root)

    Assert.False verification.Ok

    Assert.Contains(
        verification.Problems,
        fun problem ->
            match problem with
            | BoundaryViolation (path, _) -> path.EndsWith "leak.ts"
            | _ -> false
    )

[<Fact>]
let ``the kernel side may use the browser freely`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore

    File.WriteAllText(
        Path.Combine(root, "src", "kernel", "more.ts"),
        "export const s = () => window.localStorage.getItem(\"k\");\n"
    )

    Assert.True((Operations.verify false "1.0.0" (Operations.inspectRepository root)).Ok)

[<Fact>]
let ``a deleted managed file is reported and then repaired`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore
    File.Delete(Path.Combine(root, Paths.workflow))

    let broken = Operations.verify false "1.0.0" (Operations.inspectRepository root)
    Assert.False broken.Ok

    Operations.initialize root "1.0.0" false |> ignore

    Assert.True(File.Exists(Path.Combine(root, Paths.workflow)))
    Assert.True((Operations.verify false "1.0.0" (Operations.inspectRepository root)).Ok)

[<Fact>]
let ``doctor explains a damaged installation`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore
    File.WriteAllText(Path.Combine(root, Paths.manifest), "{ this is not json")

    let findings = Operations.diagnose "1.0.0" (Operations.inspectRepository root)

    Assert.True(Diagnose.hasErrors findings)
    Assert.Contains(findings, (fun finding -> finding.Code = "LIMEN002"))
    Assert.All(findings, (fun finding -> Assert.True(finding.Remedy.IsSome, finding.Code + " has no remedy")))

[<Fact>]
let ``doctor reports an absent boundary directory as information, not failure`` () =
    let root = Path.Combine(Path.GetTempPath(), "limen-bare-" + System.Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory root |> ignore
    Operations.initialize root "1.0.0" false |> ignore

    let findings = Operations.diagnose "1.0.0" (Operations.inspectRepository root)

    Assert.Contains(findings, (fun finding -> finding.Code = "LIMEN010"))
    Assert.DoesNotContain(findings, (fun finding -> finding.Code = "LIMEN010" && finding.Severity = Severity.Error))

[<Fact>]
let ``a user's configuration edits survive an upgrade`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore

    let custom = """{"configurationVersion":1,"boundary":{"engine":["app/core"],"kernel":["app/web"]}}"""
    File.WriteAllText(Path.Combine(root, Paths.configuration), custom)

    let result = Operations.performUpgrade root "2.0.0" false

    Assert.Empty result.Plan.Conflicts
    Assert.Equal(custom, File.ReadAllText(Path.Combine(root, Paths.configuration)))

[<Fact>]
let ``upgrade records the new version`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore
    Operations.performUpgrade root "2.0.0" false |> ignore

    match Operations.inspectRepository root |> Inspect.manifest with
    | Some (Ok manifest) -> Assert.Equal("2.0.0", manifest.InstalledVersion)
    | other -> failwithf "expected a readable manifest, got %A" other

[<Fact>]
let ``an out-of-date installation is reported as upgrade required`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore

    match Operations.getInstallationState "2.0.0" (Operations.inspectRepository root) with
    | UpgradeRequired (InstalledVersion installed, AvailableVersion available) ->
        Assert.Equal("1.0.0", installed)
        Assert.Equal("2.0.0", available)
    | other -> failwithf "expected UpgradeRequired, got %A" other

[<Fact>]
let ``strict verification fails on version drift but ordinary verification does not`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore
    let snapshot = Operations.inspectRepository root

    Assert.True((Operations.verify false "2.0.0" snapshot).Ok)
    Assert.False((Operations.verify true "2.0.0" snapshot).Ok)

[<Fact>]
let ``status never modifies the repository`` () =
    let root = newRepository ()
    Operations.initialize root "1.0.0" false |> ignore
    let before = fingerprint root

    Operations.getStatus "1.0.0" (Operations.inspectRepository root) |> ignore
    Operations.verify true "1.0.0" (Operations.inspectRepository root) |> ignore
    Operations.diagnose "1.0.0" (Operations.inspectRepository root) |> ignore

    Assert.Equal(before, fingerprint root)

[<Fact>]
let ``init works in a directory that is not a git repository`` () =
    let root = Path.Combine(Path.GetTempPath(), "limen-nogit-" + System.Guid.NewGuid().ToString("N"))
    Directory.CreateDirectory root |> ignore

    let result = Operations.initialize root "1.0.0" false

    Assert.Empty result.Plan.Conflicts
    Assert.True(File.Exists(Path.Combine(root, Paths.manifest)))
