namespace Limen.Site.Engine

open Limen.Contract.Core

module Engine =

    type EvidenceState =
        | Unverified
        | Passed
        | Failed

    type DeployScenario =
        | DeploySuccess
        | DeployNetworkFailure

    type DeploymentState =
        | NotStarted
        | InFlight of correlationId: string * scenario: DeployScenario
        | Deployed
        | DeploymentFailed of reason: string * retryable: bool
        | ReconciliationRequired

    type ReleaseState =
        { Tests: EvidenceState
          Security: EvidenceState
          Approved: bool
          Deployment: DeploymentState }

    type PolicyState =
        { LatestRequest: string option
          AcceptedResult: string option
          StartedA: bool
          StartedB: bool
          DeliveredA: bool
          DeliveredB: bool
          StaleDiscarded: int }

    type Placement =
        | Html
        | Css
        | Kernel
        | Engine
        | Effect
        | ProtocolChange

    type PlacementTask =
        { Prompt: string
          Answer: Placement
          Because: string }

    type TraceEntry =
        { Id: string
          Event: string
          Command: string
          From: string
          To: string
          Effect: string }

    type State =
        { Release: ReleaseState
          Policy: PolicyState
          TaskIndex: int
          Picked: Placement option
          Answered: int
          Correct: int
          Trace: TraceEntry list
          Sequence: int }

    type Command =
        | TestsPassed
        | TestsFailed
        | SecurityCleared
        | SecurityBlocked
        | ApproveRelease
        | BeginDeploy of scenario: DeployScenario * correlationId: string
        | InjectOutcomeUnknown
        | RecordDeploy of correlationId: string * outcome: EffectOutcome
        | ReconcileApplied
        | ReconcileNotApplied
        | ResetRelease
        | StartPolicyA
        | StartPolicyB
        | DeliverPolicyA
        | DeliverPolicyB
        | ResetPolicy
        | Pick of Placement
        | NextTask
        | ClearTrace

    type Step =
        { Command: string
          From: string
          To: string
          Effect: string }

    type TransitionResult =
        { State: State
          Effects: EffectRequest list
          Step: Step option }

    let placementTasks =
        [| { Prompt = "A POST timed out after dispatch. Decide whether an automatic retry is legal."
             Answer = Engine
             Because = "Retry policy is application meaning. The kernel reports OutcomeUnknown; only the engine can decide that reconciliation is required." }
           { Prompt = "Interpret HTTP 409 as an optimistic-concurrency conflict rather than a generic failure."
             Answer = Engine
             Because = "HTTP transport reports status. What 409 means to this application belongs in domain interpretation." }
           { Prompt = "Actually perform a same-origin HTTP request requested by the application."
             Answer = Effect
             Because = "The engine requests the effect. Limen performs browser I/O and returns classified evidence." }
           { Prompt = "Decide that /invoices/1042 means the InvoiceDetail state for invoice 1042."
             Answer = Engine
             Because = "Limen can report the browser location, but route meaning is application state and belongs in the engine." }
           { Prompt = "Carry a button click named submitInvoice across the DOM boundary."
             Answer = Kernel
             Because = "Turning browser interaction into a SemanticEvent is exactly Limen's mechanism job. The kernel does not interpret the event." }
           { Prompt = "Make a validation summary a labelled landmark with a heading."
             Answer = Html
             Because = "Document semantics and accessible structure belong in HTML. The engine may project the messages, but not the landmark structure." }
           { Prompt = "Increase spacing between a destructive action and its neighbors."
             Answer = Css
             Because = "Pure presentation belongs in CSS and never needs to cross the application boundary." }
           { Prompt = "Move browser history back after the user presses an in-app Back command."
             Answer = Effect
             Because = "The application decides to request navigation; the browser mechanism executes history.back through a Navigation effect." }
           { Prompt = "Read arbitrary clipboard contents so the engine can inspect what the user copied elsewhere."
             Answer = ProtocolChange
             Because = "Limen deliberately exposes clipboard write only. Clipboard read would require an explicit new capability and security review." }
           { Prompt = "Programmatically focus the first invalid field after a failed submit."
             Answer = ProtocolChange
             Because = "Focus control is not currently a Limen capability. Adding it is a protocol decision, not a hidden DOM escape." }
           { Prompt = "Compose an absolute share URL from the current browser origin and an application route."
             Answer = Engine
             Because = "The kernel supplies mechanical location evidence; deciding which route to share and how to compose it is application meaning." }
           { Prompt = "Write a draft to localStorage after the engine decides persistence is required."
             Answer = Effect
             Because = "Persistence intent is decided by the engine; browser storage access is performed only through Limen's Storage effect." } |]

    let initialState =
        { Release =
            { Tests = Unverified
              Security = Unverified
              Approved = false
              Deployment = NotStarted }
          Policy =
            { LatestRequest = None
              AcceptedResult = None
              StartedA = false
              StartedB = false
              DeliveredA = false
              DeliveredB = false
              StaleDiscarded = 0 }
          TaskIndex = 0
          Picked = None
          Answered = 0
          Correct = 0
          Trace = []
          Sequence = 0 }

    let private evidenceName = function
        | Unverified -> "Unverified"
        | Passed -> "Passed"
        | Failed -> "Failed"

    let private deploymentName = function
        | NotStarted -> "Not started"
        | InFlight _ -> "In flight"
        | Deployed -> "Deployed"
        | DeploymentFailed _ -> "Failed"
        | ReconciliationRequired -> "Outcome unknown"

    let private placementId = function
        | Html -> "html"
        | Css -> "css"
        | Kernel -> "kernel"
        | Engine -> "engine"
        | Effect -> "effect"
        | ProtocolChange -> "protocol"

    let private placementLabel = function
        | Html -> "HTML"
        | Css -> "CSS"
        | Kernel -> "Limen kernel"
        | Engine -> "F# engine"
        | Effect -> "Effect request"
        | ProtocolChange -> "Protocol change"

    let private parsePlacement = function
        | "html" -> Html
        | "css" -> Css
        | "kernel" -> Kernel
        | "engine" -> Engine
        | "effect" -> Effect
        | "protocol" -> ProtocolChange
        | other -> failwithf "Unknown placement '%s'." other

    let private deployScenarioName = function
        | DeploySuccess -> "success"
        | DeployNetworkFailure -> "network-failure"

    let private canChangeEvidence release =
        not release.Approved && release.Deployment = NotStarted

    let private canApprove release =
        release.Tests = Passed
        && release.Security = Passed
        && not release.Approved
        && release.Deployment = NotStarted

    let private canDeploy release =
        release.Approved && release.Deployment = NotStarted

    let private describeRelease release =
        $"tests={evidenceName release.Tests} security={evidenceName release.Security} approved={release.Approved} deploy={deploymentName release.Deployment}"

    let private describePolicy policy =
        let latest = policy.LatestRequest |> Option.defaultValue "none"
        let accepted = policy.AcceptedResult |> Option.defaultValue "none"
        $"latest={latest} accepted={accepted} stale={policy.StaleDiscarded}"

    let describe state =
        $"release[{describeRelease state.Release}] policy[{describePolicy state.Policy}]"

    let eventToCommand correlationId event =
        match event.Name with
        | "testsPass" -> TestsPassed
        | "testsFail" -> TestsFailed
        | "securityClear" -> SecurityCleared
        | "securityBlock" -> SecurityBlocked
        | "approveRelease" -> ApproveRelease
        | "deploySuccess" -> BeginDeploy(DeploySuccess, correlationId)
        | "injectOutcomeUnknown" -> InjectOutcomeUnknown
        | "deployNetworkFailure" -> BeginDeploy(DeployNetworkFailure, correlationId)
        | "reconcileApplied" -> ReconcileApplied
        | "reconcileNotApplied" -> ReconcileNotApplied
        | "resetRelease" -> ResetRelease
        | "startPolicyA" -> StartPolicyA
        | "startPolicyB" -> StartPolicyB
        | "deliverPolicyA" -> DeliverPolicyA
        | "deliverPolicyB" -> DeliverPolicyB
        | "resetPolicy" -> ResetPolicy
        | "nextTask" -> NextTask
        | "clearTrace" -> ClearTrace
        | "pick" -> Pick(parsePlacement (event.Key |> Option.defaultValue ""))
        | other -> failwithf "Unrecognized event '%s'." other

    let private httpGet (correlationId: string) (url: string) =
        EffectRequest.Http
            { CorrelationId = CorrelationId correlationId
              Method = HttpMethod.Get
              Url = url
              Headers = None
              Body = None
              TimeoutMs = 5000L }

    let private deploymentEffect scenario correlationId =
        match scenario with
        | DeploySuccess -> httpGet correlationId "./demo/deploy-applied.json"
        | DeployNetworkFailure -> httpGet correlationId "https://limen-demo-unreachable.invalid/deploy.json"

    let private commandName = function
        | TestsPassed -> "TestsPassed"
        | TestsFailed -> "TestsFailed"
        | SecurityCleared -> "SecurityCleared"
        | SecurityBlocked -> "SecurityBlocked"
        | ApproveRelease -> "ApproveRelease"
        | BeginDeploy(scenario, _) -> $"BeginDeploy({deployScenarioName scenario})"
        | InjectOutcomeUnknown -> "InjectOutcomeUnknown"
        | RecordDeploy _ -> "RecordDeploy"
        | ReconcileApplied -> "ReconcileApplied"
        | ReconcileNotApplied -> "ReconcileNotApplied"
        | ResetRelease -> "ResetRelease"
        | StartPolicyA -> "StartPolicyA"
        | StartPolicyB -> "StartPolicyB"
        | DeliverPolicyA -> "DeliverPolicyA"
        | DeliverPolicyB -> "DeliverPolicyB"
        | ResetPolicy -> "ResetPolicy"
        | Pick placement -> $"Pick({placementId placement})"
        | NextTask -> "NextTask"
        | ClearTrace -> "ClearTrace"

    let private noChange state =
        { State = state
          Effects = []
          Step = None }

    let private step state command next effect =
        { State = next
          Effects = []
          Step =
            Some
                { Command = commandName command
                  From = describe state
                  To = describe next
                  Effect = effect } }

    let private recordDeploymentOutcome release outcome =
        match outcome with
        | EffectOutcome.Success(status, _) when status >= 200L && status < 300L ->
            { release with Deployment = Deployed }
        | EffectOutcome.Success(status, _) ->
            { release with Deployment = DeploymentFailed($"Server responded {status}.", false) }
        | EffectOutcome.Failure(HttpFailureReason.Network, _) ->
            { release with Deployment = DeploymentFailed("No response was received. Retry is allowed only after the application classifies this as a pre-dispatch transport failure.", true) }
        | EffectOutcome.Failure(reason, status) ->
            let detail =
                match status with
                | Some code -> $"{Codec.wireHttpFailureReason reason}; server status {code}"
                | None -> Codec.wireHttpFailureReason reason

            { release with Deployment = DeploymentFailed(detail, false) }
        | EffectOutcome.Cancelled ->
            { release with Deployment = NotStarted }
        | EffectOutcome.OutcomeUnknown ->
            { release with Deployment = ReconciliationRequired }

    let transition state command =
        match command with
        | ClearTrace ->
            { State = { state with Trace = [] }
              Effects = []
              Step = None }

        | TestsPassed when canChangeEvidence state.Release ->
            step state command { state with Release = { state.Release with Tests = Passed } } "—"
        | TestsFailed when canChangeEvidence state.Release ->
            step state command { state with Release = { state.Release with Tests = Failed } } "—"
        | SecurityCleared when canChangeEvidence state.Release ->
            step state command { state with Release = { state.Release with Security = Passed } } "—"
        | SecurityBlocked when canChangeEvidence state.Release ->
            step state command { state with Release = { state.Release with Security = Failed } } "—"

        | ApproveRelease when canApprove state.Release ->
            step state command { state with Release = { state.Release with Approved = true } } "—"

        | BeginDeploy(scenario, correlationId) when canDeploy state.Release ->
            let next =
                { state with
                    Release =
                        { state.Release with
                            Deployment = InFlight(correlationId, scenario) } }

            let effect = deploymentEffect scenario correlationId
            { State = next
              Effects = [ effect ]
              Step =
                Some
                    { Command = commandName command
                      From = describe state
                      To = describe next
                      Effect =
                        match effect with
                        | EffectRequest.Http request -> $"Http GET {request.Url} ({request.TimeoutMs}ms)"
                        | EffectRequest.Storage _ -> "Storage"
                        | EffectRequest.Clipboard _ -> "Clipboard"
                        | EffectRequest.Navigation _ -> "Navigation"
                        | EffectRequest.Capability _ -> "Capability" } }

        | InjectOutcomeUnknown when canDeploy state.Release ->
            let next =
                { state with
                    Release =
                        { state.Release with
                            Deployment = ReconciliationRequired } }

            step state command next "demo evidence injection: OutcomeUnknown(timeout-after-dispatch)"

        | RecordDeploy(correlationId, outcome) ->
            match state.Release.Deployment with
            | InFlight(expected, _) when expected = correlationId ->
                let next =
                    { state with
                        Release = recordDeploymentOutcome state.Release outcome }

                step state command next "← classified effect result"
            | _ ->
                noChange state

        | ReconcileApplied when state.Release.Deployment = ReconciliationRequired ->
            step state command { state with Release = { state.Release with Deployment = Deployed } } "authoritative reconciliation"
        | ReconcileNotApplied when state.Release.Deployment = ReconciliationRequired ->
            step state command { state with Release = { state.Release with Deployment = NotStarted } } "authoritative reconciliation"

        | ResetRelease ->
            step state command { state with Release = initialState.Release } "—"

        | StartPolicyA when not state.Policy.StartedA ->
            let nextPolicy =
                { state.Policy with
                    LatestRequest = Some "policy-a"
                    AcceptedResult = None
                    StartedA = true }

            step state command { state with Policy = nextPolicy } "request policy-a"

        | StartPolicyB when state.Policy.StartedA && not state.Policy.StartedB ->
            let nextPolicy =
                { state.Policy with
                    LatestRequest = Some "policy-b"
                    AcceptedResult = None
                    StartedB = true }

            step state command { state with Policy = nextPolicy } "request policy-b"

        | DeliverPolicyA when state.Policy.StartedA && not state.Policy.DeliveredA ->
            let nextPolicy =
                if state.Policy.LatestRequest = Some "policy-a" then
                    { state.Policy with
                        AcceptedResult = Some "policy-a → Allowed"
                        DeliveredA = true }
                else
                    { state.Policy with
                        DeliveredA = true
                        StaleDiscarded = state.Policy.StaleDiscarded + 1 }

            let effect =
                if state.Policy.LatestRequest = Some "policy-a" then
                    "accepted current evidence"
                else
                    "discarded stale evidence"

            step state command { state with Policy = nextPolicy } effect

        | DeliverPolicyB when state.Policy.StartedB && not state.Policy.DeliveredB ->
            let nextPolicy =
                if state.Policy.LatestRequest = Some "policy-b" then
                    { state.Policy with
                        AcceptedResult = Some "policy-b → Review required"
                        DeliveredB = true }
                else
                    { state.Policy with
                        DeliveredB = true
                        StaleDiscarded = state.Policy.StaleDiscarded + 1 }

            let effect =
                if state.Policy.LatestRequest = Some "policy-b" then
                    "accepted current evidence"
                else
                    "discarded stale evidence"

            step state command { state with Policy = nextPolicy } effect

        | ResetPolicy ->
            step state command { state with Policy = initialState.Policy } "—"

        | Pick placement when Option.isNone state.Picked ->
            let task = placementTasks.[state.TaskIndex]
            let right = placement = task.Answer

            let next =
                { state with
                    Picked = Some placement
                    Answered = state.Answered + 1
                    Correct = state.Correct + if right then 1 else 0 }

            step state command next "—"

        | NextTask when Option.isSome state.Picked ->
            let next =
                { state with
                    TaskIndex = (state.TaskIndex + 1) % placementTasks.Length
                    Picked = None }

            step state command next "—"

        | _ ->
            noChange state

    let private evidenceTone = function
        | Unverified -> "warn"
        | Passed -> "ok"
        | Failed -> "bad"

    let private deploymentTone = function
        | Deployed -> "ok"
        | DeploymentFailed _
        | ReconciliationRequired -> "bad"
        | _ -> "warn"

    let private releaseObligations release =
        [ if release.Tests <> Passed then
              yield "tests", "Test evidence unresolved", if release.Tests = Failed then "bad" else "warn"
          if release.Security <> Passed then
              yield "security", "Security review unresolved", if release.Security = Failed then "bad" else "warn"
          if release.Tests = Passed && release.Security = Passed && not release.Approved then
              yield "approval", "Release approval required", "warn"
          match release.Deployment with
          | ReconciliationRequired ->
              yield "reconcile", "Deployment outcome is unknown. Reconcile authoritative state before retrying.", "bad"
          | DeploymentFailed(_, true) ->
              yield "retry", "Deployment failed in a retryable transport state.", "warn"
          | _ -> () ]

    let private releaseDecision release =
        match release.Deployment with
        | Deployed -> "Complete. The deployment is authoritative."
        | ReconciliationRequired -> "Blocked. The effect may already have happened; reconciliation is the only legal next step."
        | DeploymentFailed(reason, true) -> $"Retry may be allowed: {reason}"
        | DeploymentFailed(reason, false) -> $"Blocked on failure analysis: {reason}"
        | InFlight _ -> "Deployment is in flight. Await classified evidence."
        | NotStarted when canDeploy release -> "Approved and ready to deploy."
        | NotStarted when canApprove release -> "Evidence is complete. Approval is now the only release gate."
        | NotStarted -> "Release is not yet legal. Resolve the obligations below."

    let private policyStateText policy =
        match policy.LatestRequest, policy.AcceptedResult with
        | None, _ -> "No policy request has been made."
        | Some latest, None -> $"Waiting on {latest}. Older evidence must not overwrite it."
        | Some latest, Some accepted -> $"Latest request: {latest}. Accepted result: {accepted}."

    let private policyExplanation policy =
        if policy.StaleDiscarded > 0 then
            $"Discarded {policy.StaleDiscarded} stale result(s). The older response arrived, but correlation evidence proved it no longer described the current request."
        elif policy.StartedB then
            "Now deliver policy-a first. A callback-only design often lets that old response overwrite the newer request."
        elif policy.StartedA then
            "Start policy-b before delivering A. That creates the race."
        else
            "Start policy-a, then a newer policy-b, then deliver A before B."

    let project state =
        let release = state.Release
        let policy = state.Policy
        let task = placementTasks.[state.TaskIndex]
        let revealed = state.Picked.IsSome
        let right = state.Picked = Some task.Answer

        let obligations =
            releaseObligations release
            |> List.map (fun (id, text, tone) ->
                Map.ofList
                    [ "id", ViewPrimitive.Text id
                      "text", ViewPrimitive.Text text
                      "tone", ViewPrimitive.Text tone ])

        let trace =
            state.Trace
            |> List.map (fun entry ->
                Map.ofList
                    [ "id", ViewPrimitive.Text entry.Id
                      "event", ViewPrimitive.Text entry.Event
                      "command", ViewPrimitive.Text entry.Command
                      "from", ViewPrimitive.Text entry.From
                      "to", ViewPrimitive.Text entry.To
                      "effect", ViewPrimitive.Text entry.Effect ])

        let choices =
            [ Html; Css; Kernel; Engine; Effect; ProtocolChange ]
            |> List.map (fun placement ->
                Map.ofList
                    [ "id", ViewPrimitive.Text(placementId placement)
                      "label", ViewPrimitive.Text(placementLabel placement)
                      "pressed", ViewPrimitive.Flag(state.Picked = Some placement) ])

        let verdict =
            if not revealed then
                ""
            elif right then
                $"Correct — {task.Because}"
            else
                $"Not quite. {placementLabel task.Answer} — {task.Because}"

        Map.ofList
            [ "testsStatus", ViewValue.Text(evidenceName release.Tests)
              "testsTone", ViewValue.Text(evidenceTone release.Tests)
              "securityStatus", ViewValue.Text(evidenceName release.Security)
              "securityTone", ViewValue.Text(evidenceTone release.Security)
              "approvalStatus", ViewValue.Text(if release.Approved then "Approved" else "Not approved")
              "approvalTone", ViewValue.Text(if release.Approved then "ok" else "warn")
              "deploymentStatus", ViewValue.Text(deploymentName release.Deployment)
              "deploymentTone", ViewValue.Text(deploymentTone release.Deployment)
              "releaseDecision", ViewValue.Text(releaseDecision release)
              "releaseObligations", ViewValue.Items obligations
              "releaseHasObligations", ViewValue.Flag(not (List.isEmpty obligations))
              "releaseNoObligations", ViewValue.Flag(List.isEmpty obligations)
              "canChangeEvidence", ViewValue.Flag(canChangeEvidence release)
              "canApproveRelease", ViewValue.Flag(canApprove release)
              "canDeployRelease", ViewValue.Flag(canDeploy release)
              "evidenceDisabled", ViewValue.Flag(not (canChangeEvidence release))
              "approveDisabled", ViewValue.Flag(not (canApprove release))
              "deployDisabled", ViewValue.Flag(not (canDeploy release))
              "deploymentBusy", ViewValue.Flag(match release.Deployment with | InFlight _ -> true | _ -> false)
              "needsReleaseReconciliation", ViewValue.Flag(release.Deployment = ReconciliationRequired)
              "policyLatest", ViewValue.Text(policy.LatestRequest |> Option.defaultValue "none")
              "policyAccepted", ViewValue.Text(policy.AcceptedResult |> Option.defaultValue "none")
              "policyDiscarded", ViewValue.Number(float policy.StaleDiscarded)
              "policyStateText", ViewValue.Text(policyStateText policy)
              "policyExplanation", ViewValue.Text(policyExplanation policy)
              "canStartPolicyA", ViewValue.Flag(not policy.StartedA)
              "canStartPolicyB", ViewValue.Flag(policy.StartedA && not policy.StartedB)
              "canDeliverPolicyA", ViewValue.Flag(policy.StartedA && not policy.DeliveredA)
              "canDeliverPolicyB", ViewValue.Flag(policy.StartedB && not policy.DeliveredB)
              "startPolicyADisabled", ViewValue.Flag policy.StartedA
              "startPolicyBDisabled", ViewValue.Flag(not (policy.StartedA && not policy.StartedB))
              "deliverPolicyADisabled", ViewValue.Flag(not (policy.StartedA && not policy.DeliveredA))
              "deliverPolicyBDisabled", ViewValue.Flag(not (policy.StartedB && not policy.DeliveredB))
              "trace", ViewValue.Items trace
              "traceCount", ViewValue.Number(float state.Trace.Length)
              "traceEmpty", ViewValue.Flag(List.isEmpty state.Trace)
              "hasTrace", ViewValue.Flag(not (List.isEmpty state.Trace))
              "taskPrompt", ViewValue.Text task.Prompt
              "taskNumber", ViewValue.Number(float (state.TaskIndex + 1))
              "taskTotal", ViewValue.Number(float placementTasks.Length)
              "choices", ViewValue.Items choices
              "revealed", ViewValue.Flag revealed
              "verdictText", ViewValue.Text verdict
              "verdictTone", ViewValue.Text(if not revealed then "warn" elif right then "ok" else "bad")
              "scoreText", ViewValue.Text $"{state.Correct} of {state.Answered} so far"
              "nextDisabled", ViewValue.Flag(not revealed) ]
