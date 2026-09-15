/// The public API of the Limen lifecycle.
///
/// Everything the CLI can do is a function here. The CLI itself only parses
/// arguments and renders results, so another F# program — ROS, an integration
/// assembly, a test — can drive the same lifecycle without synthesizing a
/// command line or scraping text output.
module Limen.Core.Operations

open Limen.Core.Types
open Limen.Core.Inspect

/// What happened when a plan was built and, possibly, run.
type LifecycleResult =
    { Plan: Plan
      /// `None` when the run was a dry run, or when conflicts stopped it.
      Execution: Execute.ExecutionOutcome option
      /// The state after the operation, re-read from disk rather than assumed.
      State: InstallationState
      Verification: VerificationResult option }

let inspectRepository (root: string) = Inspect.repository root

let findRepositoryRoot (startDirectory: string) = Inspect.findRoot startDirectory

let getInstallationState (cliVersion: string) (snapshot: RepositorySnapshot) = State.state cliVersion snapshot

let verify (strict: bool) (cliVersion: string) (snapshot: RepositorySnapshot) = State.verify strict cliVersion snapshot

let diagnose (cliVersion: string) (snapshot: RepositorySnapshot) = Diagnose.diagnose cliVersion snapshot

let getStatus (cliVersion: string) (snapshot: RepositorySnapshot) : StatusReport =
    let state = State.state cliVersion snapshot

    let configurationVersion =
        match configuration snapshot with
        | Some (Ok value) -> Some value.ConfigurationVersion
        | _ -> None

    let managedCount =
        match manifest snapshot with
        | Some (Ok value) -> List.length value.ManagedArtifacts
        | _ -> 0

    { Tool = Paths.toolName
      Package = Paths.packageName
      CliVersion = cliVersion
      State = state
      ConfigurationVersion = configurationVersion
      ManagedArtifactCount = managedCount
      // Verification is part of status because "installed" without "valid" is
      // the state people are actually asking about.
      Verification = Some(State.verify false cliVersion snapshot) }

let createInitializationPlan (cliVersion: string) (snapshot: RepositorySnapshot) =
    Planning.build Planning.Initialize cliVersion Migrations.shipped snapshot |> fst

let planUpgrade (cliVersion: string) (snapshot: RepositorySnapshot) =
    Planning.build Planning.Upgrade cliVersion Migrations.shipped snapshot |> fst

/// Shared body of `init` and `upgrade`.
///
/// The sequence is deliberate and is the same in both cases: inspect, plan,
/// validate the plan, execute, then re-inspect and verify. The final state is
/// read back from disk rather than predicted, so the tool cannot report a
/// success it did not achieve.
let private runLifecycle (intent: Planning.Intent) (root: string) (cliVersion: string) (dryRun: bool) =
    let snapshot = inspectRepository root
    let plan, _ = Planning.build intent cliVersion Migrations.shipped snapshot

    let pathConflicts = Planning.validate plan

    let plan =
        if List.isEmpty pathConflicts then
            plan
        else
            { Changes = []
              Conflicts = plan.Conflicts @ pathConflicts }

    if dryRun || not (Plan.isExecutable plan) then
        { Plan = plan
          Execution = None
          State = State.state cliVersion snapshot
          Verification = None }
    else
        let execution = Execute.run root plan
        let after = inspectRepository root

        { Plan = plan
          Execution = Some execution
          State = State.state cliVersion after
          Verification = Some(State.verify false cliVersion after) }

let initialize (root: string) (cliVersion: string) (dryRun: bool) =
    runLifecycle Planning.Initialize root cliVersion dryRun

let performUpgrade (root: string) (cliVersion: string) (dryRun: bool) =
    runLifecycle Planning.Upgrade root cliVersion dryRun
