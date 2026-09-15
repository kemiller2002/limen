/// Turning results into output.
///
/// Two renderings of the same values: one for people, one for machines. They
/// are built from the same typed records, so they cannot disagree about what
/// happened — only about how much detail they show.
///
/// The JSON shapes here are public interface. Each carries a `schemaVersion`
/// so a consumer can tell a change from a surprise.
module Limen.Cli.Render

open Limen.Core
open Limen.Core.Types
open Limen.Core.Json

[<Literal>]
let outputSchemaVersion = 1

/// The file a problem is about, where it has one.
let problemPath (problem: InstallationProblem) =
    match problem with
    | ManifestMissing
    | ManifestUnreadable _
    | ManifestSchemaUnsupported _ -> Some Paths.manifest
    | ConfigurationMissing path
    | ConfigurationUnreadable (path, _) -> Some path
    | ConfigurationVersionUnsupported _ -> Some Paths.configuration
    | ManagedArtifactMissing path
    | ManagedArtifactModified path
    | BoundaryViolation (path, _)
    | ConfiguredPathMissing path -> Some path
    | InstalledVersionOutdated _ -> None

/// One problem, rendered through `doctor`'s explanation so that every command
/// describes the same problem the same way.
let problemToJson (problem: InstallationProblem) =
    let finding = Diagnose.explain problem

    JObject
        [ "code", JString finding.Code
          "severity", JString(Severity.toString finding.Severity)
          "title", JString finding.Title
          "detail", JString finding.Detail
          "path",
          (match problemPath problem with
           | Some path -> JString path
           | None -> JNull)
          "remedy",
          (match finding.Remedy with
           | Some remedy -> JString remedy
           | None -> JNull) ]

let findingToJson (finding: Diagnosis) =
    JObject
        [ "code", JString finding.Code
          "severity", JString(Severity.toString finding.Severity)
          "title", JString finding.Title
          "detail", JString finding.Detail
          "remedy",
          (match finding.Remedy with
           | Some remedy -> JString remedy
           | None -> JNull) ]

let stateName (state: InstallationState) =
    match state with
    | NotInstalled -> "not-installed"
    | Installed _ -> "installed"
    | UpgradeRequired _ -> "upgrade-required"
    | Invalid _ -> "invalid"

let private installedVersionOf (state: InstallationState) =
    match state with
    | Installed (InstalledVersion version)
    | UpgradeRequired (InstalledVersion version, _) -> Some version
    | NotInstalled
    | Invalid _ -> None

let private availableVersionOf (state: InstallationState) =
    match state with
    | UpgradeRequired (_, AvailableVersion version) -> Some version
    | _ -> None

let private optionalString value =
    match value with
    | Some text -> JString text
    | None -> JNull

let private optionalInt value =
    match value with
    | Some number -> JInt number
    | None -> JNull

let verificationToJson (verification: VerificationResult) =
    JObject
        [ "ok", JBool verification.Ok
          "strict", JBool verification.Strict
          "problems", verification.Problems |> List.map problemToJson |> JArray ]

// ------------------------------------------------------------------ status --

let statusToJson (report: StatusReport) =
    JObject
        [ "schemaVersion", JInt outputSchemaVersion
          "command", JString "status"
          "tool", JString report.Tool
          "package", JString report.Package
          "cliVersion", JString report.CliVersion
          "state", JString(stateName report.State)
          "installedVersion", optionalString (installedVersionOf report.State)
          "availableVersion", optionalString (availableVersionOf report.State)
          "configurationVersion", optionalInt report.ConfigurationVersion
          "managedArtifacts", JInt report.ManagedArtifactCount
          "verification",
          (match report.Verification with
           | Some verification -> verificationToJson verification
           | None -> JNull) ]

let private field name value = sprintf "  %-22s %s" (name + ":") value

let statusToText (report: StatusReport) (verbose: bool) =
    let stateLine =
        match report.State with
        | NotInstalled -> "not installed"
        | Installed (InstalledVersion version) -> sprintf "installed (%s)" version
        | UpgradeRequired (InstalledVersion installed, AvailableVersion available) ->
            sprintf "installed (%s) — %s available" installed available
        | Invalid problems -> sprintf "invalid (%d problem(s))" (List.length problems)

    let verificationLine =
        match report.Verification with
        | Some verification when verification.Ok -> "passed"
        | Some verification -> sprintf "failed (%d problem(s))" (List.length verification.Problems)
        | None -> "not run"

    let lines =
        [ sprintf "Limen (%s)" report.Package
          ""
          field "CLI version" report.CliVersion
          field
              "Installed version"
              (installedVersionOf report.State |> Option.defaultValue "—")
          field
              "Configuration"
              (match report.ConfigurationVersion with
               | Some version -> sprintf "version %d" version
               | None -> "missing")
          field "Installation" stateLine
          field "Managed artifacts" (string report.ManagedArtifactCount)
          field "Verification" verificationLine
          field
              "Upgrade"
              (match availableVersionOf report.State with
               | Some version -> sprintf "%s available" version
               | None -> "up to date") ]

    let detail =
        match report.Verification with
        | Some verification when verbose && not verification.Ok ->
            ""
            :: (verification.Problems
                |> List.map (fun problem ->
                    let finding = Diagnose.explain problem
                    sprintf "  %s %s: %s" finding.Code (Severity.toString finding.Severity) finding.Detail))
        | _ -> []

    String.concat "\n" (lines @ detail)

// ------------------------------------------------------------------ verify --

let verifyToJson (verification: VerificationResult) =
    JObject
        [ "schemaVersion", JInt outputSchemaVersion
          "command", JString "verify"
          "ok", JBool verification.Ok
          "strict", JBool verification.Strict
          "problems", verification.Problems |> List.map problemToJson |> JArray ]

let verifyToText (verification: VerificationResult) (verbose: bool) =
    if verification.Ok then
        let mode = if verification.Strict then " (strict)" else ""
        sprintf "Limen verification passed%s." mode
    else
        let header =
            sprintf "Limen verification failed: %d problem(s)." (List.length verification.Problems)

        let details =
            verification.Problems
            |> List.collect (fun problem ->
                let finding = Diagnose.explain problem

                [ sprintf "  %s  %s" finding.Code finding.Detail
                  // Under --verbose the remedy comes too, so a failing CI log
                  // says what to do rather than only what is wrong.
                  if verbose then
                      match finding.Remedy with
                      | Some remedy -> sprintf "            fix: %s" remedy
                      | None -> () ])

        String.concat "\n" (header :: "" :: details)

// ------------------------------------------------------------------ doctor --

let doctorToJson (findings: Diagnosis list) =
    JObject
        [ "schemaVersion", JInt outputSchemaVersion
          "command", JString "doctor"
          "ok", JBool(not (Diagnose.hasErrors findings))
          "errors",
          JInt(
              findings
              |> List.filter (fun f -> f.Severity = Severity.Error)
              |> List.length
          )
          "warnings",
          JInt(
              findings
              |> List.filter (fun f -> f.Severity = Severity.Warning)
              |> List.length
          )
          "findings", findings |> List.map findingToJson |> JArray ]

let doctorToText (findings: Diagnosis list) =
    if List.isEmpty findings then
        "Limen found nothing to report."
    else
        findings
        |> List.map (fun finding ->
            let remedy =
                match finding.Remedy with
                | Some remedy -> sprintf "\n      fix: %s" remedy
                | None -> ""

            sprintf
                "%-11s %s  %s\n      %s%s"
                (Severity.toString finding.Severity)
                finding.Code
                finding.Title
                finding.Detail
                remedy)
        |> String.concat "\n\n"

// --------------------------------------------------------- init / upgrade --

let private changeKind (change: PlannedChange) =
    match change with
    | CreateDirectory _ -> "create-directory"
    | CreateFile _ -> "create-file"
    | UpdateManagedFile _ -> "update-managed-file"
    | UpdateConfiguration _ -> "update-configuration"
    | RegisterIntegration _ -> "register-integration"
    | RunMigration _ -> "run-migration"
    | WriteManifest _ -> "write-manifest"

let private changeToJson (change: PlannedChange) =
    JObject
        [ "kind", JString(changeKind change)
          "path",
          (match PlannedChange.path change with
           | "" -> JNull
           | path -> JString path)
          "description", JString(PlannedChange.describe change) ]

let private conflictToJson (conflict: Conflict) =
    JObject
        [ "path", JString conflict.Path
          "reason", JString conflict.Reason
          "remedy", JString conflict.Remedy ]

let lifecycleToJson (command: string) (dryRun: bool) (result: Operations.LifecycleResult) =
    JObject
        [ "schemaVersion", JInt outputSchemaVersion
          "command", JString command
          "dryRun", JBool dryRun
          "applied", JBool result.Execution.IsSome
          "changed",
          JBool(
              match result.Execution with
              | Some execution -> not (List.isEmpty execution.Applied)
              | None -> false
          )
          "state", JString(stateName result.State)
          "changes", result.Plan.Changes |> List.map changeToJson |> JArray
          "conflicts", result.Plan.Conflicts |> List.map conflictToJson |> JArray
          "failure",
          (match result.Execution |> Option.bind (fun execution -> execution.Failure) with
           | Some (change, message) ->
               JObject
                   [ "change", JString(PlannedChange.describe change)
                     "message", JString message ]
           | None -> JNull)
          "verification",
          (match result.Verification with
           | Some verification -> verificationToJson verification
           | None -> JNull) ]

let lifecycleToText (command: string) (dryRun: bool) (verbose: bool) (result: Operations.LifecycleResult) =
    let conflicts =
        result.Plan.Conflicts
        |> List.map (fun conflict ->
            sprintf "  %s\n      %s\n      fix: %s" conflict.Path conflict.Reason conflict.Remedy)

    if not (List.isEmpty conflicts) then
        String.concat
            "\n"
            (sprintf "Limen %s stopped. Nothing was changed." command
             :: ""
             :: conflicts)
    elif List.isEmpty result.Plan.Changes then
        sprintf "Limen %s: nothing to do — the repository is already up to date." command
    elif dryRun then
        let header =
            sprintf "Limen %s would make %d change(s):" command (List.length result.Plan.Changes)

        String.concat
            "\n"
            (header
             :: ""
             :: (result.Plan.Changes
                 |> List.map (fun change -> "  " + PlannedChange.describe change)))
    else
        let applied =
            match result.Execution with
            | Some execution -> execution.Applied
            | None -> []

        let failure =
            match result.Execution |> Option.bind (fun execution -> execution.Failure) with
            | Some (change, message) ->
                [ ""
                  sprintf "FAILED while it was about to %s: %s" (PlannedChange.describe change) message
                  sprintf "%d change(s) above were applied; the rest were not." (List.length applied) ]
            | None -> []

        let verification =
            match result.Verification with
            | Some verification when verification.Ok -> [ ""; "Verification passed." ]
            | Some verification ->
                [ ""
                  sprintf "Verification failed: %d problem(s). Run `limen doctor`." (List.length verification.Problems)
                  if verbose then
                      yield!
                          verification.Problems
                          |> List.map (fun problem ->
                              let finding = Diagnose.explain problem
                              sprintf "  %s  %s" finding.Code finding.Detail) ]
            | None -> []

        String.concat
            "\n"
            ((sprintf "Limen %s made %d change(s):" command (List.length applied))
             :: ""
             :: (applied |> List.map (fun change -> "  " + PlannedChange.describe change))
             @ failure
             @ verification)
