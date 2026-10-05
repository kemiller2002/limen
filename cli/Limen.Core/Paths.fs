/// The canonical locations Limen owns inside a repository.
///
/// These strings are public interface: they appear in documentation, in the
/// manifest, and in every consumer's working tree. Changing one is a breaking
/// change and needs a migration, so they live in exactly one place.
module Limen.Core.Paths

open System

/// The shared Echelon Foundry root. Each tool owns one file inside it and must
/// not touch another tool's.
[<Literal>]
let echelonDirectory = ".echelon"

/// Limen's installation record.
[<Literal>]
let manifest = ".echelon/limen.json"

/// The user-owned boundary configuration.
[<Literal>]
let configuration = "limen.config.json"

/// The CI integration Limen registers.
[<Literal>]
let workflow = ".github/workflows/limen-verify.yml"

[<Literal>]
let workflowDirectory = ".github/workflows"

/// Manifest schema version this CLI writes and understands.
[<Literal>]
let supportedSchemaVersion = 1

/// Configuration version this CLI writes and understands.
[<Literal>]
let supportedConfigurationVersion = 1

/// The tool's own identity, as recorded in the manifest.
[<Literal>]
let toolName = "limen"

/// The npm package this CLI is distributed in, from 0.7.0 on.
[<Literal>]
let packageName = "@echelon-foundry/limen"

/// The npm package every release before 0.7.0 was published as. It is
/// deprecated, with 0.6.2 as its last version; nothing installs it any more,
/// but a 0.6.x installation records it and names it in its workflow, which is
/// why `upgrade` must recognize it (see `publishedAs`).
[<Literal>]
let legacyPackageName = "@echelon-foundry/typescript-wasm-kernel"

/// The package a given release was published under: before 0.7.0 the legacy
/// name, from 0.7.0 on `packageName`. A version that does not parse is treated
/// as current — this only chooses which name a remedy prints.
let publishedAs (version: string) =
    let leading =
        version.Split([| '.'; '-'; '+' |])
        |> Array.truncate 2
        |> Array.map (fun part ->
            match Int32.TryParse part with
            | true, value -> Some value
            | _ -> None)

    match leading with
    | [| Some 0; Some minor |] when minor < 7 -> legacyPackageName
    | _ -> packageName

/// Normalize a repository-relative path to the forward-slash form used in the
/// manifest, so a manifest written on Windows verifies on Linux.
let normalize (path: string) =
    path.Replace('\\', '/').TrimStart('/')

/// Reject anything that could escape the repository root.
///
/// Every path the tool writes passes through here. Absolute paths, drive
/// letters and `..` segments are refused rather than sanitized: a plan that
/// wants to write outside the repository is a bug, not something to correct
/// silently.
let isSafeRelative (path: string) =
    if String.IsNullOrWhiteSpace path then
        false
    else
        let normalized = normalize path

        let hasTraversal =
            normalized.Split('/')
            |> Array.exists (fun segment -> segment = ".." || segment = ".")

        not (IO.Path.IsPathRooted path)
        && not hasTraversal
        && not (normalized.Contains ':')
        && not (normalized.Contains '\000')
