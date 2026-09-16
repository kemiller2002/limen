/// Deciding what should change.
///
/// Every function here is pure: it takes a snapshot and returns a plan. Nothing
/// is written, nothing is created, and running the planner twice on the same
/// snapshot gives the same answer. `--dry-run` is not a separate path through
/// the code — it is this planner, without the execution step that follows it.
module Limen.Core.Planning

open Limen.Core.Types
open Limen.Core.Inspect

/// Why the plan is being built. The two intents differ in exactly one respect:
/// what to do about a tool-owned file a human has edited.
type Intent =
    /// Bring the repository into a valid installed state. Leaves local edits
    /// alone and lets `verify --strict` report them.
    | Initialize
    /// Move an existing installation to this version. Refuses to proceed while
    /// a local edit would be overwritten.
    | Upgrade

/// The outcome of considering one managed file: what to do, and what the
/// manifest should say afterwards.
type private Decision =
    { Change: PlannedChange option
      Artifact: ManagedArtifact
      Conflict: Conflict option }

/// Decide about one file.
///
/// The rule that matters: the manifest's hash records what the tool itself last
/// wrote or adopted. It changes only when the tool writes the file. That is
/// what lets a later run tell "the user edited this" from "the tool's copy
/// moved on".
let private decide
    (intent: Intent)
    (snapshot: RepositorySnapshot)
    (recorded: ManagedArtifact option)
    (path: string)
    (desiredContent: string)
    (ownership: Ownership)
    =
    let desiredHash = Hashing.sha256OfString desiredContent
    let actual = fileContent path snapshot

    let preserved hash disposition =
        { Path = path
          Ownership = ownership
          Disposition = disposition
          Sha256 = hash }

    match actual with
    | None ->
        // Absent, whether or not it was ever installed. Creating it is how a
        // deleted file gets repaired.
        { Change = Some(CreateFile(path, desiredContent, ownership))
          Artifact = preserved desiredHash InstalledByTool
          Conflict = None }

    | Some existing ->
        let existingHash = Hashing.sha256OfString existing

        if existingHash = desiredHash then
            // Already exactly what the tool wants. Nothing to do, and the
            // manifest can state that plainly.
            { Change = None
              Artifact = preserved desiredHash InstalledByTool
              Conflict = None }
        else
            match recorded with
            | Some previous when previous.Disposition = PreservedExisting ->
                // The tool adopted this file rather than writing it. It is not
                // the tool's to change, now or ever.
                { Change = None
                  Artifact = { previous with Ownership = ownership }
                  Conflict = None }

            | Some previous when previous.Sha256 = existingHash ->
                // Untouched since the tool wrote it, and the tool's copy has
                // moved on. Safe to update.
                { Change = Some(UpdateManagedFile(path, desiredContent, ownership))
                  Artifact = preserved desiredHash InstalledByTool
                  Conflict = None }

            | Some previous when previous.Sha256 = desiredHash ->
                // The tool's copy has *not* changed since it was installed, so
                // the whole difference is the user's edit. There is nothing to
                // update, and blocking here would freeze the repository: a
                // single customization would stop every future upgrade,
                // including ones that touch entirely different files.
                { Change = None
                  Artifact = previous
                  Conflict = None }

            | Some previous ->
                // Both moved: the user edited the file *and* the tool's copy
                // changed. This is the case that must never be resolved by
                // guessing.
                match intent with
                | Initialize ->
                    { Change = None
                      Artifact = previous
                      Conflict = None }
                | Upgrade ->
                    { Change = None
                      Artifact = previous
                      Conflict =
                        Some
                            { Path = path
                              Reason =
                                "the file has been edited since Limen wrote it, and this version of the tool would replace it"
                              Remedy =
                                sprintf
                                    "keep your version and Limen will stop updating this file, or delete %s and run upgrade again to take the tool's version"
                                    path } }

            | None ->
                // Present, never recorded: it was here before Limen. Adopt it
                // without touching it.
                { Change = None
                  Artifact = preserved existingHash PreservedExisting
                  Conflict = None }

// Directories are deliberately absent from plans. Writing a file creates its
// parent directories, so a `CreateDirectory` change would describe work that
// happens anyway — and deciding whether one was needed meant asking the
// filesystem from inside the planner, which would have made the planner's
// answer depend on something the snapshot does not record.

/// Build the plan for `init` or `upgrade`.
///
/// The configuration is user-owned, so its desired content is whatever is
/// already there; only a repository without one gets the default.
let build (intent: Intent) (cliVersion: string) (registry: Migrations.Migration list) (snapshot: RepositorySnapshot) =
    let existingManifest =
        match manifest snapshot with
        | Some (Ok value) -> Some value
        | _ -> None

    let recordedFor path =
        existingManifest |> Option.bind (Manifest.tryFindArtifact path)

    let currentConfiguration =
        match configuration snapshot with
        | Some (Ok value) -> Some value
        | _ -> None

    // Migrations run on the configuration value before anything is written, so
    // a failed precondition costs nothing.
    let migrationOutcome =
        match currentConfiguration with
        | None -> Ok([], Configuration.defaultConfiguration)
        | Some existing ->
            match Migrations.plan registry existing.ConfigurationVersion Paths.supportedConfigurationVersion with
            | Error reason -> Error reason
            | Ok chain ->
                match Migrations.run chain existing with
                | Error reason -> Error reason
                | Ok migrated -> Ok(chain, migrated)

    match migrationOutcome with
    | Error reason ->
        { Changes = []
          Conflicts =
            [ { Path = Paths.configuration
                Reason = reason
                Remedy = "upgrade to a newer release of the CLI, or correct the configuration by hand" } ] },
        existingManifest

    | Ok (chain, targetConfiguration) ->
        let configurationDesired =
            // Only a migration may rewrite a user-owned configuration. Absent
            // one, the file on disk is authoritative and is left untouched.
            match currentConfiguration, chain with
            | Some _, [] ->
                snapshot.ConfigurationText
                |> Option.defaultValue (Configuration.serialize targetConfiguration)
            | _ -> Configuration.serialize targetConfiguration

        let configurationDecision =
            decide intent snapshot (recordedFor Paths.configuration) Paths.configuration configurationDesired UserOwned

        let assetDecisions =
            Assets.managed
            |> List.map (fun (path, content, ownership) ->
                decide intent snapshot (recordedFor path) path content ownership)

        let decisions = configurationDecision :: assetDecisions

        let artifacts = decisions |> List.map (fun decision -> decision.Artifact)
        let conflicts = decisions |> List.choose (fun decision -> decision.Conflict)
        let fileChanges = decisions |> List.choose (fun decision -> decision.Change)

        let migrationChanges =
            chain
            |> List.map (fun migration -> RunMigration(migration.From, migration.To))

        let newManifest =
            { SchemaVersion = Paths.supportedSchemaVersion
              Tool = Paths.toolName
              Package = Paths.packageName
              InstalledVersion = cliVersion
              ConfigurationVersion = Paths.supportedConfigurationVersion
              ManagedArtifacts = artifacts |> List.sortBy (fun artifact -> artifact.Path) }

        let manifestChange =
            // Rewriting an identical manifest would make `init` report work it
            // did not do, and would break the idempotency guarantee.
            match existingManifest with
            | Some previous when Manifest.serialize previous = Manifest.serialize newManifest -> []
            | _ -> [ WriteManifest newManifest ]

        let changes =
            if List.isEmpty conflicts then
                migrationChanges @ fileChanges @ manifestChange
            else
                // A plan that cannot be executed should not also describe work,
                // or a reader might think part of it ran.
                []

        { Changes = changes; Conflicts = conflicts }, Some newManifest

/// Reject any plan that would write outside the repository.
///
/// Nothing in the shipped asset list can do this; the check exists because the
/// planner's inputs include paths read from a manifest on disk, which is
/// repository content and therefore not trusted.
let validate (plan: Plan) =
    plan.Changes
    |> List.map PlannedChange.path
    |> List.filter (fun path -> path <> "")
    |> List.filter (fun path -> not (Paths.isSafeRelative path))
    |> List.map (fun path ->
        { Path = path
          Reason = "the plan would write outside the repository"
          Remedy = "this is a bug in Limen or a corrupted manifest; report it with the manifest contents" })
