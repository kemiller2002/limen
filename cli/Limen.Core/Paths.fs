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

/// The npm package this CLI is distributed in. The product is named Limen; the
/// package deliberately kept its original name so no consumer had to migrate.
[<Literal>]
let packageName = "@echelon-foundry/typescript-wasm-kernel"

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
