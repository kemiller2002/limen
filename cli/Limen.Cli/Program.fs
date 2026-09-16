/// The entry point.
///
/// Thin on purpose: parse, dispatch to `Limen.Core`, render, choose an exit
/// code. No lifecycle decision is made in this file.
///
/// Two rules are enforced here and nowhere else:
///   * under `--json`, stdout carries valid JSON and nothing else — every
///     message for a human goes to stderr;
///   * no exception reaches the runtime, because an unhandled exception's exit
///     code and stack trace would become the tool's public contract by accident.
module Limen.Cli.Program

open System
open System.Reflection
open Limen.Core
open Limen.Core.Types
open Limen.Cli

/// The one authoritative version.
///
/// It comes from the assembly, which the build stamps from package.json. There
/// is deliberately no version constant in the source: two places to change is
/// one place to forget.
let cliVersion () =
    let informational =
        Assembly.GetEntryAssembly()
        |> Option.ofObj
        |> Option.bind (fun assembly ->
            assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            |> Option.ofObj)
        |> Option.map (fun attribute -> attribute.InformationalVersion)

    match informational with
    | Some value when not (String.IsNullOrWhiteSpace value) ->
        // The SDK appends "+<commit>" when source link is enabled.
        match value.IndexOf '+' with
        | -1 -> value
        | index -> value.Substring(0, index)
    | _ -> "0.0.0"

let private out (text: string) = Console.Out.WriteLine text
let private err (text: string) = Console.Error.WriteLine text

let private emit (json: bool) (jsonValue: Json.Value) (text: string) =
    if json then out (Json.render jsonValue) else out text

/// Resolve the repository to act on.
let private resolveRoot (root: string option) =
    match root with
    | Some explicitPath -> IO.Path.GetFullPath explicitPath
    | None -> Operations.findRepositoryRoot (IO.Directory.GetCurrentDirectory())

let private statusExitCode (state: InstallationState) =
    match state with
    | Installed _
    | UpgradeRequired _ -> ExitCodes.success
    | NotInstalled
    | Invalid _ -> ExitCodes.incompatibleInstallation

let private runStatus (options: Args.StatusOptions) =
    let root = resolveRoot options.Global.Root
    let snapshot = Operations.inspectRepository root
    let report = Operations.getStatus (cliVersion ()) snapshot

    emit
        options.Global.Json
        (Render.statusToJson report)
        (Render.statusToText report options.Global.Verbose)

    statusExitCode report.State

let private runVerify (options: Args.VerifyOptions) =
    let root = resolveRoot options.Global.Root
    let snapshot = Operations.inspectRepository root
    let verification = Operations.verify options.Strict (cliVersion ()) snapshot

    emit
        options.Global.Json
        (Render.verifyToJson verification)
        (Render.verifyToText verification options.Global.Verbose)

    if verification.Ok then
        ExitCodes.success
    else
        ExitCodes.verificationFailed

let private runDoctor (options: Args.DoctorOptions) =
    let root = resolveRoot options.Global.Root
    let snapshot = Operations.inspectRepository root
    let findings = Operations.diagnose (cliVersion ()) snapshot

    emit options.Global.Json (Render.doctorToJson findings) (Render.doctorToText findings)

    if Diagnose.hasErrors findings then
        ExitCodes.verificationFailed
    else
        ExitCodes.success

/// Exit code for `init` and `upgrade`.
///
/// `--check` turns "something would change" into a failure, which is what makes
/// it usable as a CI gate.
let private lifecycleExitCode (check: bool) (result: Operations.LifecycleResult) =
    if not (List.isEmpty result.Plan.Conflicts) then
        ExitCodes.migrationBlocked
    elif result.Execution |> Option.bind (fun execution -> execution.Failure) |> Option.isSome then
        ExitCodes.internalFailure
    elif check && not (List.isEmpty result.Plan.Changes) then
        ExitCodes.verificationFailed
    else
        ExitCodes.success

let private runInit (options: Args.InitOptions) =
    let root = resolveRoot options.Global.Root
    let result = Operations.initialize root (cliVersion ()) options.DryRun

    emit
        options.Global.Json
        (Render.lifecycleToJson "init" options.DryRun result)
        (Render.lifecycleToText "init" options.DryRun options.Global.Verbose result)

    lifecycleExitCode options.Check result

let private runUpgrade (options: Args.UpgradeOptions) =
    let root = resolveRoot options.Global.Root
    let snapshot = Operations.inspectRepository root

    // Upgrading something that was never installed is not an upgrade. Saying so
    // is more useful than silently performing an installation the user did not
    // ask for.
    match Operations.getInstallationState (cliVersion ()) snapshot with
    | NotInstalled ->
        if options.Global.Json then
            out (
                Json.render (
                    Json.JObject
                        [ "schemaVersion", Json.JInt Render.outputSchemaVersion
                          "command", Json.JString "upgrade"
                          "dryRun", Json.JBool options.DryRun
                          "applied", Json.JBool false
                          "changed", Json.JBool false
                          "state", Json.JString "not-installed"
                          "changes", Json.JArray []
                          "conflicts", Json.JArray []
                          "failure", Json.JNull
                          "verification", Json.JNull ]
                )
            )
        else
            err "Limen is not installed in this repository. Run `init` first."

        ExitCodes.incompatibleInstallation

    | _ ->
        let result = Operations.performUpgrade root (cliVersion ()) options.DryRun

        emit
            options.Global.Json
            (Render.lifecycleToJson "upgrade" options.DryRun result)
            (Render.lifecycleToText "upgrade" options.DryRun options.Global.Verbose result)

        lifecycleExitCode options.Check result

let run (argv: string list) =
    match Args.parse argv with
    | Error error ->
        err ("limen: " + Args.describeError error)
        err "Run `limen --help` for usage."
        ExitCodes.invalidArguments

    | Ok command ->
        match command with
        | Args.Help topic ->
            out (Help.forTopic topic)
            ExitCodes.success
        | Args.Version ->
            out (Help.versionLine (cliVersion ()))
            ExitCodes.success
        | Args.Status options -> runStatus options
        | Args.Verify options -> runVerify options
        | Args.Doctor options -> runDoctor options
        | Args.Init options -> runInit options
        | Args.Upgrade options -> runUpgrade options

[<EntryPoint>]
let main argv =
    try
        run (List.ofArray argv)
    with error ->
        // Anything that reaches here is a bug. Report it on stderr so `--json`
        // stdout stays parseable, and return the documented code rather than
        // whatever the runtime would have chosen.
        Console.Error.WriteLine("limen: internal failure: " + error.Message)
        ExitCodes.internalFailure
