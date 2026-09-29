// The F# reference outbox library against the language-neutral scenarios
// (conformance/outbox/outbox.vectors.json). The snapshot is compared as a
// subset; what a command emitted and why it was ignored, exactly.
open System
open System.IO
open System.Text.Json.Nodes
open Limen.Outbox

let vectorsPath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "outbox.vectors.json")
let vectors = JsonNode.Parse(File.ReadAllText vectorsPath).AsObject()

let text (node: JsonNode) = node.GetValue<string>()
let items (node: JsonNode) = match node with | null -> [] | node -> node.AsArray() |> List.ofSeq
let str (value: string) : JsonNode = JsonValue.Create value
let boolean (value: bool) : JsonNode = JsonValue.Create value
let optional (value: string option) : JsonNode = match value with | Some v -> str v | None -> null
let obj (pairs: (string * JsonNode) list) = JsonObject(pairs |> List.map (fun (k, v) -> Collections.Generic.KeyValuePair(k, v)))
let arr (nodes: JsonNode list) = JsonArray(nodes |> Array.ofList)

let rec subset (expected: JsonNode) (actual: JsonNode) =
    match expected with
    | :? JsonObject as e ->
        match actual with
        | :? JsonObject as a -> e |> Seq.forall (fun pair -> a.ContainsKey pair.Key && subset pair.Value a[pair.Key])
        | _ -> false
    | :? JsonArray as e ->
        match actual with
        | :? JsonArray as a -> e.Count = a.Count && Seq.forall2 subset e a
        | _ -> false
    | _ -> JsonNode.DeepEquals(expected, actual)

let statusOf (status: OperationStatus) =
    match status with
    | OperationStatus.Queued -> "queued", None
    | OperationStatus.Sending -> "sending", None
    | OperationStatus.Conflict version -> "conflict", Some version
    | OperationStatus.Unknown -> "unknown", None

let snapshot (outbox: Outbox) =
    let operation (o: Operation) =
        let status, version = statusOf o.Status
        obj ([ "id", str o.Id; "kind", str o.Kind; "payload", str o.Payload; "status", str status ] @ (version |> Option.map (fun v -> [ "version", str v ]) |> Option.defaultValue []))
        :> JsonNode
    obj [ "online", boolean (Outbox.online outbox)
          "held", boolean (Outbox.held outbox)
          "operations", arr (Outbox.operations outbox |> List.map operation)
          "notices", arr (Outbox.notices outbox |> List.map (fun n -> obj [ "id", str n.Id; "reason", str n.Reason ] :> JsonNode)) ]

let emittedNode (Emitted.Send(id, kind, payload)) =
    obj [ "send", obj [ "id", str id; "kind", str kind; "payload", str payload ] :> JsonNode ] :> JsonNode

let outcomeOf (node: JsonNode) =
    match text node["kind"] with
    | "confirmed" -> Outcome.Confirmed
    | "rejected" -> Outcome.Rejected(text node["reason"])
    | "conflict" -> Outcome.Conflict(text node["version"])
    | "failed" -> Outcome.Failed
    | _ -> Outcome.Unknown

let persisted (node: JsonNode) =
    let status =
        match text node["status"] with
        | "sending" -> OperationStatus.Sending
        | "conflict" -> OperationStatus.Conflict(text node["version"])
        | "unknown" -> OperationStatus.Unknown
        | _ -> OperationStatus.Queued
    { Id = text node["id"]; Kind = text node["kind"]; Payload = text node["payload"]; Status = status }

let apply (step: JsonObject) (outbox: Outbox) =
    if step.ContainsKey "enqueue" then
        let e = step["enqueue"]
        Outbox.enqueue (text e["id"]) (text e["kind"]) (text e["payload"]) outbox
    elif step.ContainsKey "connectivity" then
        let c = step["connectivity"]
        Outbox.connectivity (c["online"].GetValue<bool>()) outbox
    elif step.ContainsKey "flush" then Outbox.flush outbox
    elif step.ContainsKey "result" then
        let r = step["result"]
        Outbox.result (text r["id"]) (outcomeOf r["outcome"]) outbox
    elif step.ContainsKey "reconcile" then
        let r = step["reconcile"]
        Outbox.reconcile (text r["id"]) (r["applied"].GetValue<bool>()) outbox
    elif step.ContainsKey "resolve" then
        let r = step["resolve"]
        let chosen = r["resolution"]
        let resolution =
            match text chosen["kind"] with
            | "discard" -> Resolution.Discard
            | _ -> Resolution.Replace(text chosen["payload"])
        Outbox.resolve (text r["id"]) resolution outbox
    elif step.ContainsKey "restore" then
        let r = step["restore"]
        Outbox.restore (items r["operations"] |> List.map persisted)
    else
        let d = step["dismiss"]
        Outbox.dismiss (text d["id"]) outbox

let verdicts =
    items vectors["scenarios"]
    |> List.collect (fun scenario ->
        let name = text scenario["name"]
        items scenario["steps"]
        |> List.fold (fun (outbox, index, found) stepNode ->
            let step = stepNode.AsObject()
            let next, emitted, ignored = apply step outbox
            let actual = snapshot next
            actual["emitted"] <- arr (emitted |> List.map emittedNode)
            actual["ignored"] <- optional ignored
            let expected = step["expect"].DeepClone().AsObject()
            if not (expected.ContainsKey "emitted") then expected["emitted"] <- JsonArray()
            expected["ignored"] <- (match step["ignored"] with | null -> null | node -> node.DeepClone())
            let exact = JsonNode.DeepEquals(expected["emitted"], actual["emitted"]) && JsonNode.DeepEquals(expected["ignored"], actual["ignored"])
            let verdict = if exact && subset expected actual then None else Some $"{name} step {index}\n    expected {expected.ToJsonString()}\n    actual   {actual.ToJsonString()}"
            next, index + 1, found @ [ verdict ]) (Outbox.empty, 1, [])
        |> fun (_, _, found) -> found)

let failures = verdicts |> List.choose id

if failures.IsEmpty then
    printfn "Outbox conformance: %d/%d scenario steps agree (F# reference library)." verdicts.Length verdicts.Length
else
    failures |> List.iter (eprintfn "FAIL %s")
    eprintfn "%d outbox step(s) disagree; %d agree." failures.Length (verdicts.Length - failures.Length)
    Environment.ExitCode <- 1
