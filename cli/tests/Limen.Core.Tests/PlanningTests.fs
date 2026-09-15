module Limen.Core.Tests.PlanningTests

open System.IO
open Xunit
open Limen.Core
open Limen.Core.Types
open Limen.Core.Inspect

/// Build a snapshot directly, without touching a repository.
///
/// The planner is a pure function of a snapshot, so every situation below —
/// including ones that are awkward to create on disk, like a manifest that
/// disagrees with the files beside it — is just a value.
let private snapshotOf (files: (string * string) list) =
    // A real directory, so the planner's "does this directory already exist?"
    // question has a definite answer instead of depending on the test host.
    let root = Path.Combine(Path.GetTempPath(), "limen-tests")
    Directory.CreateDirectory root |> ignore

    let lookup = dict files

    let managed =
        files
        |> List.map (fun (path, content) ->
            path,
            { Path = path
              Exists = true
              Content = Some content })
        |> Map.ofList

    { Root = root
      ManifestText = (match lookup.TryGetValue Paths.manifest with
                      | true, value -> Some value
                      | _ -> None)
      ConfigurationText = (match lookup.TryGetValue Paths.configuration with
                           | true, value -> Some value
                           | _ -> None)
      ManagedFiles = managed
      EngineFiles = []
      KernelFiles = []
      MissingConfiguredPaths = [] }

let private workflowContent = Assets.workflow
let private configurationContent = Configuration.serialize Configuration.defaultConfiguration

/// A manifest describing a healthy installation at a given version.
let private manifestFor version =
    { SchemaVersion = Paths.supportedSchemaVersion
      Tool = Paths.toolName
      Package = Paths.packageName
      InstalledVersion = version
      ConfigurationVersion = Paths.supportedConfigurationVersion
      ManagedArtifacts =
        [ { Path = Paths.configuration
            Ownership = UserOwned
            Disposition = InstalledByTool
            Sha256 = Hashing.sha256OfString configurationContent }
          { Path = Paths.workflow
            Ownership = ToolOwned
            Disposition = InstalledByTool
            Sha256 = Hashing.sha256OfString workflowContent } ] }

/// An installed repository at `version`, optionally with edited files.
let private installed version extraFiles =
    snapshotOf (
        [ Paths.manifest, Manifest.serialize (manifestFor version)
          Paths.configuration, configurationContent
          Paths.workflow, workflowContent ]
        |> List.map (fun (path, content) ->
            match extraFiles |> List.tryFind (fun (p, _) -> p = path) with
            | Some (_, replacement) -> path, replacement
            | None -> path, content)
    )

let private planInit version snapshot =
    Planning.build Planning.Initialize version Migrations.shipped snapshot |> fst

let private planUpgrade version snapshot =
    Planning.build Planning.Upgrade version Migrations.shipped snapshot |> fst

// ------------------------------------------------------------------- init ---

[<Fact>]
let ``init on an empty repository plans the whole installation`` () =
    let plan = planInit "1.0.0" (snapshotOf [])

    Assert.Empty plan.Conflicts
    Assert.Contains(plan.Changes, (fun change -> PlannedChange.path change = Paths.configuration))
    Assert.Contains(plan.Changes, (fun change -> PlannedChange.path change = Paths.workflow))
    Assert.Contains(plan.Changes, (fun change -> match change with WriteManifest _ -> true | _ -> false))

[<Fact>]
let ``init on an already installed repository plans nothing`` () =
    // This is the idempotency guarantee, expressed where it is cheapest to
    // check: the plan for the second run is empty.
    let plan = planInit "1.0.0" (installed "1.0.0" [])

    Assert.True(Plan.isNoOp plan, sprintf "expected no changes, got %A" plan.Changes)

[<Fact>]
let ``init restores a file that was deleted`` () =
    let snapshot =
        snapshotOf
            [ Paths.manifest, Manifest.serialize (manifestFor "1.0.0")
              Paths.configuration, configurationContent ]

    let plan = planInit "1.0.0" snapshot

    Assert.Contains(
        plan.Changes,
        fun change ->
            match change with
            | CreateFile (path, _, _) -> path = Paths.workflow
            | _ -> false
    )

[<Fact>]
let ``init never overwrites a file that was there before Limen`` () =
    let snapshot = snapshotOf [ Paths.workflow, "# mine, written long before Limen" ]
    let plan = planInit "1.0.0" snapshot

    Assert.DoesNotContain(
        plan.Changes,
        fun change ->
            match change with
            | UpdateManagedFile (path, _, _) -> path = Paths.workflow
            | _ -> false
    )

[<Fact>]
let ``a pre-existing file is recorded as preserved rather than installed`` () =
    let snapshot = snapshotOf [ Paths.workflow, "# mine" ]
    let _, manifest = Planning.build Planning.Initialize "1.0.0" Migrations.shipped snapshot

    match manifest |> Option.bind (Manifest.tryFindArtifact Paths.workflow) with
    | Some artifact -> Assert.Equal(PreservedExisting, artifact.Disposition)
    | None -> failwith "expected the adopted file to be recorded"

[<Fact>]
let ``init does not block on a locally edited tool-owned file`` () =
    let snapshot = installed "1.0.0" [ Paths.workflow, workflowContent + "\n# my pin\n" ]
    let plan = planInit "1.0.0" snapshot

    Assert.Empty plan.Conflicts

[<Fact>]
let ``init leaves a user-owned configuration alone`` () =
    let custom = """{"configurationVersion":1,"boundary":{"engine":["app/core"],"kernel":["app/web"]}}"""
    let snapshot = installed "1.0.0" [ Paths.configuration, custom ]
    let plan = planInit "1.0.0" snapshot

    Assert.DoesNotContain(
        plan.Changes,
        fun change -> PlannedChange.path change = Paths.configuration
    )

// ---------------------------------------------------------------- upgrade ---

[<Fact>]
let ``upgrading from an older version rewrites only the manifest`` () =
    let plan = planUpgrade "2.0.0" (installed "1.0.0" [])

    Assert.Empty plan.Conflicts
    Assert.All(plan.Changes, (fun change -> Assert.True(match change with WriteManifest _ -> true | _ -> false)))

[<Fact>]
let ``upgrading from several versions back still succeeds`` () =
    let plan = planUpgrade "9.9.9" (installed "0.1.0" [])
    Assert.Empty plan.Conflicts
    Assert.NotEmpty plan.Changes

[<Fact>]
let ``upgrading to the same version does nothing`` () =
    Assert.True(Plan.isNoOp(planUpgrade "1.0.0" (installed "1.0.0" [])))

[<Fact>]
let ``a user's customization does not block an unrelated upgrade`` () =
    // The tool's own copy of the file has not changed, so the whole difference
    // is the user's edit. Blocking here would freeze the repository forever.
    let snapshot = installed "1.0.0" [ Paths.workflow, workflowContent + "\n# my pin\n" ]
    let plan = planUpgrade "2.0.0" snapshot

    Assert.Empty plan.Conflicts

[<Fact>]
let ``a customization survives the upgrade that steps over it`` () =
    let edited = workflowContent + "\n# my pin\n"
    let snapshot = installed "1.0.0" [ Paths.workflow, edited ]
    let plan = planUpgrade "2.0.0" snapshot

    Assert.DoesNotContain(plan.Changes, (fun change -> PlannedChange.path change = Paths.workflow))

[<Fact>]
let ``upgrade is blocked when both the tool and the user changed a file`` () =
    // Simulated by a manifest whose recorded hash matches neither the file on
    // disk nor the tool's current copy — which is exactly what a real release
    // that changed the file would produce.
    let stale =
        { manifestFor "1.0.0" with
            ManagedArtifacts =
                manifestFor "1.0.0"
                |> fun m ->
                    m.ManagedArtifacts
                    |> List.map (fun artifact ->
                        if artifact.Path = Paths.workflow then
                            { artifact with Sha256 = String.replicate 64 "0" }
                        else
                            artifact) }

    let snapshot =
        snapshotOf
            [ Paths.manifest, Manifest.serialize stale
              Paths.configuration, configurationContent
              Paths.workflow, workflowContent + "\n# my pin\n" ]

    let plan = planUpgrade "2.0.0" snapshot

    Assert.NotEmpty plan.Conflicts
    Assert.Empty plan.Changes

[<Fact>]
let ``a blocked plan describes no work at all`` () =
    // A reader must not be able to mistake a refused plan for a partial one.
    let snapshot =
        snapshotOf
            [ Paths.manifest,
              Manifest.serialize
                  { manifestFor "1.0.0" with
                      ManagedArtifacts =
                          [ { Path = Paths.workflow
                              Ownership = ToolOwned
                              Disposition = InstalledByTool
                              Sha256 = String.replicate 64 "0" } ] }
              Paths.workflow, "edited" ]

    let plan = planUpgrade "2.0.0" snapshot

    Assert.False(Plan.isExecutable plan)
    Assert.Empty plan.Changes

[<Fact>]
let ``a damaged manifest produces a conflict-free plan that reinstalls`` () =
    let snapshot = snapshotOf [ Paths.manifest, "{ broken" ]
    let plan = planInit "1.0.0" snapshot

    Assert.Empty plan.Conflicts
    Assert.NotEmpty plan.Changes

// -------------------------------------------------------------- migrations ---

let private migration from into precondition =
    { Migrations.From = from
      Migrations.To = into
      Migrations.Description = sprintf "%d to %d" from into
      Migrations.Precondition = precondition
      Migrations.Apply = fun configuration -> { configuration with ConfigurationVersion = into } }

[<Fact>]
let ``a migration chain runs in order`` () =
    let registry =
        [ migration 1 2 (fun _ -> Ok())
          migration 2 3 (fun _ -> Ok()) ]

    match Migrations.plan registry 1 3 with
    | Ok chain ->
        Assert.Equal<int list>([ 1; 2 ], chain |> List.map (fun m -> m.From))
    | Error reason -> failwithf "expected a chain, got %s" reason

[<Fact>]
let ``a missing link stops the chain rather than skipping it`` () =
    let registry = [ migration 1 2 (fun _ -> Ok()) ]

    match Migrations.plan registry 1 3 with
    | Error _ -> ()
    | Ok chain -> failwithf "expected no chain, got %d steps" (List.length chain)

[<Fact>]
let ``a failed precondition stops the run and changes nothing`` () =
    let registry =
        [ migration 1 2 (fun _ -> Ok())
          migration 2 3 (fun _ -> Error "the repository still uses the old layout") ]

    match Migrations.plan registry 1 3 with
    | Ok chain ->
        match Migrations.run chain Configuration.defaultConfiguration with
        | Error reason -> Assert.Contains("old layout", reason)
        | Ok _ -> failwith "expected the precondition to stop the run"
    | Error reason -> failwithf "expected a chain, got %s" reason

[<Fact>]
let ``a configuration newer than the target cannot be migrated backwards`` () =
    match Migrations.plan [] 5 1 with
    | Error reason -> Assert.Contains("newer", reason)
    | Ok _ -> failwith "expected a refusal"

[<Fact>]
let ``the shipped registry is empty because only one version has existed`` () =
    Assert.Empty Migrations.shipped
