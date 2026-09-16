/// `doctor`: explaining what is wrong.
///
/// `verify` answers yes or no. `doctor` answers why, and what to do about it.
/// The severities matter: treating every deviation as an error teaches people
/// to ignore the output, so a repository that has simply not written any engine
/// code yet reports information, not failure.
module Limen.Core.Diagnose

open Limen.Core.Types
open Limen.Core.Inspect

let private diagnosis severity code title detail remedy =
    { Severity = severity
      Code = code
      Title = title
      Detail = detail
      Remedy = remedy }

/// Explain one problem.
let explain (problem: InstallationProblem) =
    match problem with
    | ManifestMissing ->
        diagnosis
            Severity.Error
            "LIMEN001"
            "Limen is not installed in this repository"
            (sprintf "No installation manifest was found at %s." Paths.manifest)
            (Some "Run `npx @echelon-foundry/typescript-wasm-kernel init`.")

    | ManifestUnreadable detail ->
        diagnosis
            Severity.Error
            "LIMEN002"
            "The installation manifest cannot be read"
            (sprintf "%s could not be parsed: %s" Paths.manifest detail)
            (Some(
                sprintf
                    "The manifest is written by the tool and is not meant to be edited. Restore it from version control, or delete %s and run `init` to rebuild it."
                    Paths.manifest
            ))

    | ManifestSchemaUnsupported (found, supported) ->
        diagnosis
            Severity.Error
            "LIMEN003"
            "The installation manifest is a newer format than this CLI understands"
            (sprintf "The manifest declares schema version %d; this CLI supports version %d." found supported)
            (Some "Upgrade the CLI: `npx @echelon-foundry/typescript-wasm-kernel@latest status`.")

    | ConfigurationMissing path ->
        diagnosis
            Severity.Error
            "LIMEN004"
            "The Limen configuration is missing"
            (sprintf "%s does not exist, so the boundary this repository intends cannot be known." path)
            (Some "Run `init` to recreate it with defaults, then edit it to match your layout.")

    | ConfigurationUnreadable (path, detail) ->
        diagnosis
            Severity.Error
            "LIMEN005"
            "The Limen configuration cannot be read"
            (sprintf "%s could not be parsed: %s" path detail)
            (Some "Fix the JSON syntax. This file is yours to edit; the tool will not rewrite it.")

    | ConfigurationVersionUnsupported (found, supported) ->
        diagnosis
            Severity.Error
            "LIMEN006"
            "The configuration is newer than this CLI understands"
            (sprintf "The configuration declares version %d; this CLI supports version %d." found supported)
            (Some "Upgrade the CLI. An older tool must not guess at a newer configuration.")

    | ManagedArtifactMissing path ->
        diagnosis
            Severity.Error
            "LIMEN007"
            "A file Limen installed is missing"
            (sprintf "%s is recorded in the manifest but is not on disk." path)
            (Some "Run `init` to restore it. Nothing you own will be overwritten.")

    | ManagedArtifactModified path ->
        diagnosis
            Severity.Warning
            "LIMEN008"
            "A tool-owned file has been edited locally"
            (sprintf "%s differs from the copy Limen wrote." path)
            (Some(
                sprintf
                    "That is allowed — but `upgrade` will stop rather than overwrite your edit. To take the tool's version instead, delete %s and run `init`."
                    path
            ))

    | BoundaryViolation (path, reason) ->
        diagnosis
            Severity.Error
            "LIMEN009"
            "The Limen boundary is broken"
            (sprintf "%s: %s" path reason)
            (Some
                "Application meaning belongs in the engine and browser access belongs in the kernel. Move the code across the boundary rather than widening it.")

    | ConfiguredPathMissing path ->
        diagnosis
            Severity.Information
            "LIMEN010"
            "A configured boundary directory does not exist yet"
            (sprintf "%s is named in %s but is not present." path Paths.configuration)
            (Some(
                sprintf
                    "Create it when you write that side of the boundary, or remove it from %s if your layout differs."
                    Paths.configuration
            ))

    | InstalledVersionOutdated (installed, available) ->
        diagnosis
            Severity.Warning
            "LIMEN011"
            "The installation is older than the CLI"
            (sprintf "This repository was initialized by version %s; the CLI running is %s." installed available)
            (Some "Run `npx @echelon-foundry/typescript-wasm-kernel upgrade`.")

/// Environment checks that are about the machine rather than the repository.
let private environment (root: string) =
    let repositoryIsGit =
        System.IO.Directory.Exists(System.IO.Path.Combine(root, ".git"))
        || System.IO.File.Exists(System.IO.Path.Combine(root, ".git"))

    let writable =
        try
            let probe = System.IO.Path.Combine(root, ".limen-write-probe")
            System.IO.File.WriteAllText(probe, "")
            System.IO.File.Delete probe
            true
        with _ ->
            false

    [ if not repositoryIsGit then
          diagnosis
              Severity.Information
              "LIMEN020"
              "This directory is not a git repository"
              (sprintf "No .git was found at or above %s, so Limen treated this directory as the repository root." root)
              (Some "If that is not what you meant, run the command from inside your repository.")
      if not writable then
          diagnosis
              Severity.Error
              "LIMEN021"
              "The repository is not writable"
              (sprintf "Limen could not create a file in %s." root)
              (Some "Check permissions. `status`, `verify` and `doctor` still work read-only.") ]

/// Every finding for a repository, most serious first.
///
/// Doctor always runs the strict checks: its job is to tell you everything that
/// might matter, not to decide which of it should fail a build.
let diagnose (cliVersion: string) (snapshot: RepositorySnapshot) =
    let verification = State.verify true cliVersion snapshot

    let order severity =
        match severity with
        | Severity.Error -> 0
        | Severity.Warning -> 1
        | Severity.Information -> 2

    (verification.Problems |> List.map explain) @ environment snapshot.Root
    |> List.sortBy (fun finding -> order finding.Severity)

let hasErrors findings =
    findings |> List.exists (fun finding -> finding.Severity = Severity.Error)
