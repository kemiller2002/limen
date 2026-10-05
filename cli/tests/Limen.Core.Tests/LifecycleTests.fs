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

// --- Consumers installed before the package rename (0.7.0) -------------------
//
// Every release before 0.7.0 was published as Paths.legacyPackageName, wrote
// that name into .echelon/limen.json and invoked it from the workflow. These
// tests stand up such an installation on disk exactly as that release left it
// and prove `upgrade` moves it to the new name without any special-case code:
// the managed workflow is regenerated from the template because the manifest
// records the hash of the legacy copy, and the manifest is rewritten with the
// current package identity.

/// The workflow 0.5.0 through 0.6.2 installed: the legacy name, unpinned.
let private legacyUnpinnedWorkflow =
    """# Installed and maintained by Limen (@echelon-foundry/typescript-wasm-kernel).
# Edit freely — once changed, `limen upgrade` will stop rewriting it and will
# tell you what the current tool-owned version would have been.
name: Limen verify

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  limen-verify:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Verify the Limen boundary
        run: npx --yes @echelon-foundry/typescript-wasm-kernel verify --strict
"""

/// The pinned workflow as tagged at v0.7.0 before the rename (never published,
/// but a repository initialized from a source build has it): the legacy name,
/// pinned to the recorded version.
let private legacyPinnedWorkflow =
    Assets.workflow.Replace(Paths.packageName, Paths.legacyPackageName)

/// Make `root` look exactly like a repository a pre-rename release installed:
/// the given legacy workflow, and a manifest naming the legacy package that
/// records that workflow's hash as the copy the tool wrote.
let private installedBeforeRename (installedVersion: string) (workflow: string) =
    let root = newRepository ()
    Operations.initialize root installedVersion false |> ignore
    File.WriteAllText(Path.Combine(root, Paths.workflow), workflow)

    let manifest =
        match Operations.inspectRepository root |> Inspect.manifest with
        | Some (Ok manifest) -> manifest
        | other -> failwithf "expected a readable manifest, got %A" other

    let legacy =
        { manifest with
            Package = Paths.legacyPackageName
            ManagedArtifacts =
                manifest.ManagedArtifacts
                |> List.map (fun artifact ->
                    if artifact.Path = Paths.workflow then
                        { artifact with Sha256 = Hashing.sha256OfString workflow }
                    else
                        artifact) }

    File.WriteAllText(Path.Combine(root, Paths.manifest), Manifest.serialize legacy)
    root

let private assertMigratedToCurrentName root =
    let workflow = File.ReadAllText(Path.Combine(root, Paths.workflow))
    Assert.Equal(Assets.workflow, workflow)
    Assert.DoesNotContain(Paths.legacyPackageName, workflow)
    Assert.Contains("npx --yes \"@echelon-foundry/limen@${{ steps.limen.outputs.version }}\" verify --strict", workflow)

    let manifestText = File.ReadAllText(Path.Combine(root, Paths.manifest))
    Assert.DoesNotContain(Paths.legacyPackageName, manifestText)

    match Operations.inspectRepository root |> Inspect.manifest with
    | Some (Ok manifest) ->
        Assert.Equal("@echelon-foundry/limen", manifest.Package)
        Assert.Equal("0.7.0", manifest.InstalledVersion)

        let recorded = manifest |> Manifest.tryFindArtifact Paths.workflow |> Option.get
        Assert.Equal(Hashing.sha256OfString Assets.workflow, recorded.Sha256)
        Assert.Equal(InstalledByTool, recorded.Disposition)
    | other -> failwithf "expected a readable manifest, got %A" other

    let verification = Operations.verify true "0.7.0" (Operations.inspectRepository root)
    Assert.True(verification.Ok, sprintf "expected strict verification to pass after the rename upgrade, got %A" verification.Problems)

[<Fact>]
let ``the package is published as echelon-foundry/limen, and the workflow pins it`` () =
    Assert.Equal("@echelon-foundry/limen", Paths.packageName)
    Assert.Equal("@echelon-foundry/typescript-wasm-kernel", Paths.legacyPackageName)
    Assert.DoesNotContain(Paths.legacyPackageName, Assets.workflow)
    Assert.Contains("npx --yes \"@echelon-foundry/limen@${{ steps.limen.outputs.version }}\" verify --strict", Assets.workflow)

[<Fact>]
let ``upgrade moves a 0.6.x installation's unpinned legacy-name workflow to the pinned new name`` () =
    let root = installedBeforeRename "0.6.2" legacyUnpinnedWorkflow

    let dryRun = Operations.performUpgrade root "0.7.0" true
    Assert.Empty dryRun.Plan.Conflicts

    Assert.Contains(
        dryRun.Plan.Changes,
        fun change ->
            match change with
            | UpdateManagedFile (path, content, _) -> path = Paths.workflow && content = Assets.workflow
            | _ -> false
    )

    Assert.Contains(
        dryRun.Plan.Changes,
        fun change ->
            match change with
            | WriteManifest manifest -> manifest.Package = Paths.packageName
            | _ -> false
    )

    let result = Operations.performUpgrade root "0.7.0" false
    Assert.Empty result.Plan.Conflicts
    assertMigratedToCurrentName root

    // And it is now settled: a second upgrade has nothing to do.
    Assert.True(Plan.isNoOp (Operations.performUpgrade root "0.7.0" false).Plan)

[<Fact>]
let ``upgrade moves a pinned legacy-name workflow to the pinned new name`` () =
    let root = installedBeforeRename "0.7.0" legacyPinnedWorkflow

    let result = Operations.performUpgrade root "0.7.0" false

    Assert.Empty result.Plan.Conflicts
    assertMigratedToCurrentName root

[<Fact>]
let ``an edited legacy-name workflow is not guessed at: upgrade stops and writes nothing`` () =
    let root = installedBeforeRename "0.6.2" legacyUnpinnedWorkflow
    File.AppendAllText(Path.Combine(root, Paths.workflow), "\n# my own step\n")
    let before = fingerprint root

    let result = Operations.performUpgrade root "0.7.0" false

    Assert.Contains(result.Plan.Conflicts, fun conflict -> conflict.Path = Paths.workflow)
    Assert.Empty result.Plan.Changes
    Assert.Equal(before, fingerprint root)

[<Fact>]
let ``a pre-rename version is pinned under the legacy package name in the LIMEN011 remedy`` () =
    Assert.Equal(Paths.legacyPackageName, Paths.publishedAs "0.6.2")
    Assert.Equal(Paths.legacyPackageName, Paths.publishedAs "0.5.0")
    Assert.Equal(Paths.packageName, Paths.publishedAs "0.7.0")
    Assert.Equal(Paths.packageName, Paths.publishedAs "0.10.0")
    Assert.Equal(Paths.packageName, Paths.publishedAs "1.0.0")

    let remedy =
        (Diagnose.explain (InstalledVersionOutdated("0.6.2", "0.7.0"))).Remedy |> Option.defaultValue ""

    Assert.Contains("npx --yes @echelon-foundry/limen@0.7.0 upgrade", remedy)
    Assert.Contains("npx --yes @echelon-foundry/typescript-wasm-kernel@0.6.2 verify --strict", remedy)
