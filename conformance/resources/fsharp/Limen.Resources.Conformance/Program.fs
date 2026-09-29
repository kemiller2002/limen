// The F# reference resources library against the language-neutral scenarios
// (conformance/resources/resources.vectors.json). The snapshot is compared as
// a subset; what a command emitted and why it was ignored, exactly.
open System
open System.IO
open System.Text.Json
open System.Text.Json.Nodes
open Limen.Resources

let vectorsPath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "resources.vectors.json")
let vectors = JsonNode.Parse(File.ReadAllText vectorsPath).AsObject()

let text (node: JsonNode) = node.GetValue<string>()
let items (node: JsonNode) = match node with | null -> [] | node -> node.AsArray() |> List.ofSeq
let str (value: string) : JsonNode = JsonValue.Create value
let optional (value: string option) : JsonNode = match value with | Some v -> str v | None -> null
let obj (pairs: (string * JsonNode) list) = JsonObject(pairs |> List.map (fun (k, v) -> Collections.Generic.KeyValuePair(k, v)))
let arr (nodes: JsonNode list) = JsonArray(nodes |> Array.ofList)
let strings (map: Map<string, string>) = obj (map |> Map.toList |> List.map (fun (k, v) -> k, str v))

let rec subset (expected: JsonNode) (actual: JsonNode) =
    match expected with
    | :? JsonObject as e ->
        match actual with
        | :? JsonObject as a -> e |> Seq.forall (fun pair -> a.ContainsKey pair.Key && subset pair.Value a[pair.Key])
        | _ -> false
    | _ -> JsonNode.DeepEquals(expected, actual)

let failures = ResizeArray<string>()
let mutable passed = 0

let judge (name: string) (index: int) (expect: JsonObject) (actual: JsonObject) (emitted: JsonNode list) (ignored: string option) =
    actual["emitted"] <- arr emitted
    actual["ignored"] <- optional ignored
    let expected = expect.DeepClone().AsObject()
    if not (expected.ContainsKey "emitted") then expected["emitted"] <- JsonArray()
    if not (expected.ContainsKey "ignored") then expected["ignored"] <- null
    let exact = JsonNode.DeepEquals(expected["emitted"], actual["emitted"]) && JsonNode.DeepEquals(expected["ignored"], actual["ignored"])
    if exact && subset expected actual then passed <- passed + 1
    else failures.Add $"{name} step {index}\n    expected {expected.ToJsonString()}\n    actual   {actual.ToJsonString()}"

let readSnapshot (read: Read) =
    let state, error =
        match Read.state read with
        | ReadState.NotRequested -> "notRequested", None
        | ReadState.Loading _ -> "loading", None
        | ReadState.Ready _ -> "ready", None
        | ReadState.Refreshing _ -> "refreshing", None
        | ReadState.Failed(reason, _) -> "failed", Some reason
        | ReadState.Uncertain _ -> "uncertain", None
    obj [ "state", str state; "value", optional (Read.visible read); "inFlight", optional (Read.inFlight read); "error", optional error ]

let readEmitted (emitted: ReadEmitted) =
    match emitted with
    | ReadEmitted.Fetch id -> obj [ "fetch", str id ] :> JsonNode
    | ReadEmitted.Cancel id -> obj [ "cancel", str id ] :> JsonNode

for scenario in items vectors["resources"] do
    let name = text scenario["name"]
    items scenario["steps"]
    |> List.fold (fun (read, index) stepNode ->
        let step = stepNode.AsObject()
        let next, emitted, ignored =
            if step.ContainsKey "request" then Read.request read
            elif step.ContainsKey "cancel" then Read.cancel read
            else
                let r = step["result"]
                let o = r["outcome"]
                let outcome =
                    match text o["kind"] with
                    | "success" -> ReadOutcome.Success(text o["value"])
                    | "failure" -> ReadOutcome.Failure(text o["reason"])
                    | "cancelled" -> ReadOutcome.Cancelled
                    | _ -> ReadOutcome.Unknown
                Read.result (text r["request"]) outcome read
        judge name index (step["expect"].AsObject()) (readSnapshot next) (emitted |> List.map readEmitted) ignored
        next, index + 1) (Read.initial, 1)
    |> ignore

let statusName (status: MutationStatus) =
    match status with
    | MutationStatus.Pending -> "pending"
    | MutationStatus.Superseded -> "superseded"
    | MutationStatus.Unresolved -> "unresolved"
    | MutationStatus.SupersededUnresolved -> "superseded-unresolved"

let storeSnapshot (store: Optimistic) =
    obj [ "confirmed", strings (Optimistic.confirmed store)
          "displayed", strings (Optimistic.displayed store)
          "pending", arr (Optimistic.mutations store |> List.map (fun m -> obj [ "id", str m.Id; "key", str m.Key; "value", str m.Value; "status", str (statusName m.Status) ] :> JsonNode))
          "notices", arr (Optimistic.notices store |> List.map (fun n -> obj [ "id", str n.Id; "key", str n.Key; "reason", str n.Reason ] :> JsonNode)) ]

let values (node: JsonNode) = node.AsObject() |> Seq.map (fun pair -> pair.Key, text pair.Value) |> Map.ofSeq

for scenario in items vectors["optimistic"] do
    let name = text scenario["name"]
    items scenario["steps"]
    |> List.fold (fun (store, index) stepNode ->
        let step = stepNode.AsObject()
        let next, emitted, ignored =
            if step.ContainsKey "load" then
                let load = step["load"]
                Optimistic.load (values load["values"]), [], None
            elif step.ContainsKey "propose" then
                let p = step["propose"]
                Optimistic.propose (text p["key"]) (text p["value"]) store
            elif step.ContainsKey "result" then
                let r = step["result"]
                let o = r["outcome"]
                let outcome =
                    match text o["kind"] with
                    | "confirmed" -> MutationOutcome.Confirmed(text o["value"])
                    | "rejected" -> MutationOutcome.Rejected(text o["reason"])
                    | "failed" -> MutationOutcome.Failed
                    | _ -> MutationOutcome.Unknown
                Optimistic.result (text r["mutation"]) outcome store
            elif step.ContainsKey "reconcile" then
                let r = step["reconcile"]
                let value = match r["value"] with | null -> None | v -> Some(text v)
                Optimistic.reconcile (text r["id"]) (r["applied"].GetValue<bool>()) value store
            elif step.ContainsKey "refresh" then
                let r = step["refresh"]
                Optimistic.refresh (values r["values"]) store
            else
                let d = step["dismiss"]
                Optimistic.dismiss (text d["id"]) store
        let sent = emitted |> List.map (fun (OptimisticEmitted.Send(id, key, value)) -> obj [ "send", obj [ "id", str id; "key", str key; "value", str value ] :> JsonNode ] :> JsonNode)
        judge name index (step["expect"].AsObject()) (storeSnapshot next) sent ignored
        next, index + 1) (Optimistic.load Map.empty, 1)
    |> ignore

if failures.Count = 0 then
    printfn "Resources conformance: %d/%d scenario steps agree (F# reference library)." passed passed
else
    failures |> Seq.iter (eprintfn "FAIL %s")
    eprintfn "%d resource step(s) disagree; %d agree." failures.Count passed
    Environment.ExitCode <- 1
