/// Determining installation state, and verifying it.
///
/// Two questions are kept apart on purpose:
///
///   * *Is Limen installed correctly?* — about the tool's own files.
///   * *Does this repository honour the boundary?* — about the user's code.
///
/// Collapsing them would make `status` report a broken installation because
/// somebody wrote `document` in an engine file, which is a different problem
/// with a different fix. `verify` reports both, because a repository that fails
/// either is not in a good state.
module Limen.Core.State

open Limen.Core.Types
open Limen.Core.Inspect

/// Problems with the installation itself, independent of the user's code.
///
/// `strict` adds the checks that a healthy installation passes but a drifted
/// one does not: tool-owned files matching what the tool wrote, and configured
/// directories actually existing.
let installationProblems (strict: bool) (snapshot: RepositorySnapshot) =
    match manifest snapshot with
    | None -> [ ManifestMissing ]
    | Some (Error problem) -> [ problem ]
    | Some (Ok manifestValue) ->
        let configurationProblems =
            match configuration snapshot with
            | None -> [ ConfigurationMissing Paths.configuration ]
            | Some (Error problem) -> [ problem ]
            | Some (Ok _) -> []

        let artifactProblems =
            manifestValue.ManagedArtifacts
            |> List.collect (fun artifact ->
                match fileContent artifact.Path snapshot with
                | None -> [ ManagedArtifactMissing artifact.Path ]
                | Some content ->
                    // A locally modified tool-owned file is only a verification
                    // failure under --strict. By default it is the user's
                    // prerogative; `upgrade` is where it actually matters,
                    // because that is when the tool would overwrite it.
                    if strict
                       && artifact.Ownership = ToolOwned
                       && Hashing.sha256OfString content <> artifact.Sha256 then
                        [ ManagedArtifactModified artifact.Path ]
                    else
                        [])

        let missingPathProblems =
            if strict then
                snapshot.MissingConfiguredPaths |> List.map ConfiguredPathMissing
            else
                []

        configurationProblems @ artifactProblems @ missingPathProblems

/// The lifecycle state, as one of four mutually exclusive cases.
///
/// Note that `UpgradeRequired` is only reported for an otherwise healthy
/// installation: an installation that is both out of date and broken is
/// reported as broken, because that is what needs attention first.
let state (cliVersion: string) (snapshot: RepositorySnapshot) =
    match manifest snapshot with
    | None -> NotInstalled
    | Some (Error problem) -> Invalid [ problem ]
    | Some (Ok manifestValue) ->
        match installationProblems false snapshot with
        | [] ->
            if manifestValue.InstalledVersion <> cliVersion then
                UpgradeRequired(InstalledVersion manifestValue.InstalledVersion, AvailableVersion cliVersion)
            else
                Installed(InstalledVersion manifestValue.InstalledVersion)
        | problems -> Invalid problems

/// Why a declared boundary checks nothing, if it does.
///
/// An empty engine list, or engine paths that hold no source file, would make
/// every boundary rule vacuously true. That is not a pass: it is reported as
/// `BoundaryNotConfigured`, and the verdict becomes `NotConfigured`.
let private vacuity (declared: BoundaryConfig) (snapshot: RepositorySnapshot) =
    if List.isEmpty declared.Engine then
        [ BoundaryNotConfigured(sprintf "%s declares no engine path, so no engine code is checked" Paths.configuration) ]
    elif List.isEmpty snapshot.EngineFiles then
        [ BoundaryNotConfigured(
              sprintf "no engine source file was found under %s, so no engine code is checked" (String.concat ", " declared.Engine)
          ) ]
    else
        []

/// The verdict for a list of problems. Anything other than an unconfigured
/// boundary is a failure; an unconfigured boundary alone is `NotConfigured`;
/// a repository that declared no boundary, with a reason, is `NotApplicable`.
let verdictOf (declaration: BoundaryDeclaration option) (problems: InstallationProblem list) =
    let isNotConfigured =
        function
        | BoundaryNotConfigured _ -> true
        | _ -> false

    match List.partition isNotConfigured problems, declaration with
    | (_, _ :: _), _ -> Failed
    | (_ :: _, []), _ -> NotConfigured
    | ([], []), Some (NoBoundary rationale) -> NotApplicable rationale
    | ([], []), _ -> Passed

/// Verify the repository. Never writes anything.
///
/// Under `--strict` an out-of-date installation is also a failure, so that CI
/// fails when a repository drifts behind the tool rather than silently running
/// against an older contract.
let verify (strict: bool) (cliVersion: string) (snapshot: RepositorySnapshot) =
    let installation = installationProblems strict snapshot

    // Checking the boundary against a missing or unreadable configuration
    // would be checking against a guess. Report the configuration problem
    // and stop rather than emit violations the user cannot act on.
    let declaration =
        match configuration snapshot with
        | Some (Ok value) -> Some value.Boundary
        | _ -> None

    let boundary =
        match declaration with
        | Some (Declared declared) ->
            Boundary.check snapshot.EngineFiles snapshot.KernelFiles @ vacuity declared snapshot
        | Some (NoBoundary _)
        | None -> []

    let versionDrift =
        if not strict then
            []
        else
            match manifest snapshot with
            | Some (Ok manifestValue) when manifestValue.InstalledVersion <> cliVersion ->
                [ InstalledVersionOutdated(manifestValue.InstalledVersion, cliVersion) ]
            | _ -> []

    let problems = installation @ boundary @ versionDrift
    let verdict = verdictOf declaration problems

    { Ok = Verdict.isAcceptable verdict
      Strict = strict
      Verdict = verdict
      EngineFilesChecked = List.length snapshot.EngineFiles
      KernelFilesChecked = List.length snapshot.KernelFiles
      Problems = problems }
