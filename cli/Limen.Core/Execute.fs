/// Applying a plan.
///
/// This is the only module that writes. It executes a plan it is given and
/// makes no decisions of its own — if a change is not in the plan it does not
/// happen, which is what makes `--dry-run` a truthful preview rather than a
/// best guess.
///
/// Each file is written to a temporary file beside its destination and then
/// moved into place, so a failure mid-write cannot leave a half-written file
/// where a complete one used to be. Across several files the operation is not
/// transactional; instead a failure stops immediately and reports exactly which
/// changes were applied before it, so the state is always knowable.
module Limen.Core.Execute

open System.IO
open Limen.Core.Types

type ExecutionOutcome =
    { Applied: PlannedChange list
      Failure: (PlannedChange * string) option }

let private writeFileAtomically (root: string) (relativePath: string) (content: string) =
    let fullPath = Path.Combine(root, relativePath)
    let directory = Path.GetDirectoryName fullPath

    if not (System.String.IsNullOrEmpty directory) then
        Directory.CreateDirectory directory |> ignore

    // Same directory as the destination, so the move is a rename rather than a
    // cross-device copy that could fail half-way.
    let temporary = fullPath + ".limen-tmp"
    File.WriteAllText(temporary, content)
    File.Move(temporary, fullPath, true)

let private apply (root: string) (change: PlannedChange) =
    match change with
    | CreateDirectory path -> Directory.CreateDirectory(Path.Combine(root, path)) |> ignore
    | CreateFile (path, content, _) -> writeFileAtomically root path content
    | UpdateManagedFile (path, content, _) -> writeFileAtomically root path content
    | UpdateConfiguration (path, content) -> writeFileAtomically root path content
    | RegisterIntegration (_, path, content) -> writeFileAtomically root path content
    | RunMigration _ ->
        // A migration transforms the configuration value during planning. The
        // resulting content reaches disk through the configuration change that
        // accompanies it, so there is nothing to do here.
        ()
    | WriteManifest manifest -> writeFileAtomically root Paths.manifest (Manifest.serialize manifest)

/// Run a plan, stopping at the first failure.
///
/// Refuses outright to execute a plan carrying conflicts: a conflict means the
/// tool decided it must not proceed, and executing anyway would make that
/// decision meaningless.
let run (root: string) (plan: Plan) =
    if not (Plan.isExecutable plan) then
        { Applied = []
          Failure = None }
    else
        let applied = ResizeArray()
        let mutable failure = None

        for change in plan.Changes do
            if failure.IsNone then
                try
                    apply root change
                    applied.Add change
                with error ->
                    failure <- Some(change, error.Message)

        { Applied = List.ofSeq applied
          Failure = failure }
