open System
open System.Text.Json.Nodes
open Limen.Site.Engine
open Limen.Site.Engine.Protocol
open Limen.Site.Engine.Engine

let mutable failures = 0

let fail name expected actual =
    failures <- failures + 1
    eprintfn "FAIL %s: expected %A, got %A" name expected actual

let equal name expected actual =
    if expected <> actual then fail name expected actual

let ok name condition =
    if not condition then fail name true false

let transitionState state command = (transition state command).State

// Release gate: evidence is not decoration. It changes the legal action set.
let testsPassed = transitionState initialState TestsPassed
let securityCleared = transitionState testsPassed SecurityCleared
let prematureApproval = transitionState testsPassed ApproveRelease
equal "approval blocked until security evidence exists" false prematureApproval.Release.Approved

let approved = transitionState securityCleared ApproveRelease
equal "approval becomes legal after both evidence gates" true approved.Release.Approved

let immutableEvidence = transitionState approved TestsFailed
equal "evidence cannot be rewritten after approval" Passed immutableEvidence.Release.Tests

let deployment = transition approved (BeginDeploy(DeploySuccess, "deploy-1"))
equal "approved release can enter deployment" true (match deployment.State.Release.Deployment with | InFlight("deploy-1", DeploySuccess) -> true | _ -> false)
equal "deployment emits one browser effect" 1 deployment.Effects.Length

let staleDeploy = transition deployment.State (RecordDeploy("deploy-old", HttpSuccess 200))
equal "stale deploy evidence is discarded" deployment.State.Release.Deployment staleDeploy.State.Release.Deployment

let unknown = transition deployment.State (RecordDeploy("deploy-1", HttpOutcomeUnknown))
equal "timeout after dispatch becomes reconciliation" ReconciliationRequired unknown.State.Release.Deployment

let blindRetry = transitionState unknown.State (BeginDeploy(DeploySuccess, "deploy-2"))
equal "blind retry is illegal while outcome is unknown" ReconciliationRequired blindRetry.Release.Deployment

let reconciledNotApplied = transitionState unknown.State ReconcileNotApplied
equal "authoritative not-applied evidence reopens deploy capability" NotStarted reconciledNotApplied.Release.Deployment
equal "approval survives not-applied reconciliation" true reconciledNotApplied.Release.Approved

// Stale-evidence race: an older result cannot overwrite a newer request.
let policyA = transitionState initialState StartPolicyA
let policyB = transitionState policyA StartPolicyB
let oldArrives = transitionState policyB DeliverPolicyA
equal "older policy result is not accepted" None oldArrives.Policy.AcceptedResult
equal "older policy result is counted as stale" 1 oldArrives.Policy.StaleDiscarded

let newArrives = transitionState oldArrives DeliverPolicyB
equal "newest policy result is accepted" (Some "policy-b → Review required") newArrives.Policy.AcceptedResult

// Placement challenge should be difficult enough to expose the boundary.
ok "placement challenge has at least ten tasks" (placementTasks.Length >= 10)
ok "placement challenge includes protocol-change answers" (placementTasks |> Array.exists (fun task -> task.Answer = ProtocolChange))
ok "placement explanations are substantive" (placementTasks |> Array.forall (fun task -> task.Because.Length > 50))

// Projection carries capabilities and obligations rather than making the DOM infer them.
let initialView = project initialState
equal "initial approval capability is false" (Some(VBool false)) (Map.tryFind "canApproveRelease" initialView)
equal "initial obligations exist" (Some(VBool true)) (Map.tryFind "releaseHasObligations" initialView)

let readyView = project securityCleared
equal "approval capability becomes true" (Some(VBool true)) (Map.tryFind "canApproveRelease" readyView)

// Serialized dispatch is the exact boundary used by the WebAssembly host.
Dispatch.resetForTests()

let initialize =
    """{"kind":"Initialize","protocolVersion":1,"capabilities":["Http","Storage","Clipboard","Navigation"],"location":{"origin":"https://example.test","path":"/","query":"","hash":""}}"""

let initialized = JsonNode.Parse(Dispatch.handle initialize).AsObject()
let initialJsonView = initialized.["view"].AsObject()
equal "initialize projects tests state" "Unverified" (initialJsonView.["testsStatus"].GetValue<string>())

let passTestsMessage =
    """{"kind":"Event","event":{"kind":"Event","name":"testsPass"}}"""

let passSecurityMessage =
    """{"kind":"Event","event":{"kind":"Event","name":"securityClear"}}"""

let approveMessage =
    """{"kind":"Event","event":{"kind":"Event","name":"approveRelease"}}"""

Dispatch.handle passTestsMessage |> ignore
Dispatch.handle passSecurityMessage |> ignore
let approvedResponse = JsonNode.Parse(Dispatch.handle approveMessage).AsObject()
equal "serialized dispatch approves through F# state machine" "Approved" (approvedResponse.["view"].AsObject().["approvalStatus"].GetValue<string>())

let deployMessage =
    """{"kind":"Event","event":{"kind":"Event","name":"deploySuccess"}}"""

let deployResponse = JsonNode.Parse(Dispatch.handle deployMessage).AsObject()
let effects = deployResponse.["effects"].AsArray()
equal "serialized deploy emits one effect" 1 effects.Count
equal "serialized deploy effect is HTTP" "Http" (effects.[0].AsObject().["kind"].GetValue<string>())

if failures = 0 then
    printfn "Limen F# site engine tests passed."
else
    eprintfn "%d Limen F# site engine test(s) failed." failures
    Environment.ExitCode <- 1
