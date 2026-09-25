open System
open System.Text.Json.Nodes

module Source = Limen.Federation.Source.Engine.SourceModule
module Target = Limen.Federation.Target.Engine.TargetModule

let mutable failures = 0

let fail name expected actual =
    failures <- failures + 1
    eprintfn "FAIL %s: expected %A, got %A" name expected actual

let equal name expected actual =
    if expected <> actual then fail name expected actual

let ok name condition =
    if not condition then fail name true false

let context moduleId =
    $"{{\"federationProtocolVersion\":1,\"moduleId\":\"{moduleId}\",\"peers\":[],\"availableCapabilities\":[]}}"

Source.resetForTests ()
Target.resetForTests ()

Target.initialize (context Target.ModuleId)
Target.restore "null"
Target.activate ()

Source.initialize (context Source.ModuleId)
Source.restore "null"
Source.activate ()

let requestJson = Source.beginTransition ()
let request = JsonNode.Parse(requestJson).AsObject()

equal "source emits a transition request" "TransitionRequest" (request["kind"].GetValue<string>())
equal "request contract is versioned" 1 (request["contractVersion"].GetValue<int>())
equal "source addresses the target explicitly" Target.ModuleId (request["target"].GetValue<string>())
equal "request carries expected target state version" 0 (request["expectedStateVersion"].GetValue<int>())

let targetResult = JsonNode.Parse(Target.dispatch requestJson).AsObject()
let emitted = targetResult["emitted"].AsArray()
equal "target emits exactly one response" 1 emitted.Count

let responseJson = emitted[0].ToJsonString()
let response = emitted[0].AsObject()
equal "target accepts the legal transition" "TransitionAccepted" (response["kind"].GetValue<string>())
equal "target response uses its declared result contract" Target.ResultContract (response["contract"].GetValue<string>())
equal "target response returns to the source" Source.ModuleId (response["target"].GetValue<string>())

Source.dispatch responseJson |> ignore

let sourceSnapshot = JsonNode.Parse(Source.snapshotJson()).AsObject()
let targetSnapshot = JsonNode.Parse(Target.snapshotJson()).AsObject()

equal "source owns completed state" "Completed" (sourceSnapshot["status"].GetValue<string>())
equal "source consumes accepted value" 42 (sourceSnapshot["acceptedValue"].GetValue<int>())
equal "source records target version evidence" 1 (sourceSnapshot["targetStateVersion"].GetValue<int>())
equal "target owns its state version" 1 (targetSnapshot["stateVersion"].GetValue<int>())
equal "target owns accepted count" 1 (targetSnapshot["acceptedCount"].GetValue<int>())
equal "target owns accepted value" 42 (targetSnapshot["lastValue"].GetValue<int>())

// Re-deliver the original request after the target has advanced.
// The target must reject it without mutating authoritative state.
let staleResult = JsonNode.Parse(Target.dispatch requestJson).AsObject()
let staleResponse = staleResult["emitted"].AsArray()[0].AsObject()
equal "stale expected version is rejected" "TransitionRejected" (staleResponse["kind"].GetValue<string>())
equal "stale rejection reports current version" 1 (staleResponse["payload"].AsObject()["currentStateVersion"].GetValue<int>())

let targetAfterStale = JsonNode.Parse(Target.snapshotJson()).AsObject()
equal "stale request does not increment target count" 1 (targetAfterStale["acceptedCount"].GetValue<int>())
equal "stale request does not advance target version" 1 (targetAfterStale["stateVersion"].GetValue<int>())

let sourceManifest = JsonNode.Parse(Source.manifestJson()).AsObject()
let targetManifest = JsonNode.Parse(Target.manifestJson()).AsObject()
ok "module identities are independent" (sourceManifest["id"].GetValue<string>() <> targetManifest["id"].GetValue<string>())

Source.suspend ()
Target.suspend ()

if failures = 0 then
    printfn "Limen multi-F#-WASM federation engine tests passed."
else
    eprintfn "%d Limen federation test(s) failed." failures
    Environment.ExitCode <- 1
