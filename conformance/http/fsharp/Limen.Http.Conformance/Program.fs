// The F# reference HTTP policy library against the language-neutral cases
// (conformance/http/http.vectors.json), compared exactly.
open System
open System.IO
open System.Text.Json.Nodes
open Limen.Http

let vectorsPath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "http.vectors.json")
let vectors = JsonNode.Parse(File.ReadAllText vectorsPath).AsObject()

let text (node: JsonNode) = node.GetValue<string>()
let int64Of (node: JsonNode) = node.GetValue<int64>()
let items (node: JsonNode) = match node with | null -> [] | node -> node.AsArray() |> List.ofSeq
let has (key: string) (node: JsonNode) = node.AsObject().ContainsKey key
let str (value: string) : JsonNode = JsonValue.Create value
let num (value: int64) : JsonNode = JsonValue.Create value
let obj (pairs: (string * JsonNode) list) = JsonObject(pairs |> List.map (fun (k, v) -> Collections.Generic.KeyValuePair(k, v)))
let arr (nodes: JsonNode list) = JsonArray(nodes |> Array.ofList)
let stringMap (node: JsonNode) = match node with | null -> Map.empty | node -> node.AsObject() |> Seq.map (fun pair -> pair.Key, text pair.Value) |> Map.ofSeq
let strings (map: Map<string, string>) = obj (map |> Map.toList |> List.map (fun (k, v) -> k, str v))

let failures = ResizeArray<string>()
let passed = ref 0

let judge (name: string) (expected: JsonNode) (actual: JsonNode) =
    if JsonNode.DeepEquals(expected, actual) then passed.Value <- passed.Value + 1
    else failures.Add $"{name}\n    expected {expected.ToJsonString()}\n    actual   {actual.ToJsonString()}"

let requestOf (node: JsonNode) : Request =
    { Method = text node["method"]
      Url = text node["url"]
      Headers = stringMap node["headers"]
      Body = if has "body" node then Some(text node["body"]) else None
      TimeoutMs = if has "timeoutMs" node then int64Of node["timeoutMs"] else 5000L
      ResponseHeaders = if has "responseHeaders" node then items node["responseHeaders"] |> List.map text else [] }

let requestJson (request: Request) : JsonNode =
    obj
        [ yield "method", str request.Method
          yield "url", str request.Url
          yield "headers", strings request.Headers
          match request.Body with
          | Some body -> yield "body", str body
          | None -> ()
          yield "timeoutMs", num request.TimeoutMs
          yield "responseHeaders", arr (request.ResponseHeaders |> List.map str) ]

let outcomeOf (node: JsonNode) =
    match text node["kind"] with
    | "success" -> Outcome.Success(int (int64Of node["status"]), text node["body"], stringMap node["headers"])
    | "failure" -> Outcome.Failure(text node["reason"], if has "status" node then Some(int (int64Of node["status"])) else None)
    | "cancelled" -> Outcome.Cancelled
    | "unknown" -> Outcome.Unknown
    | other -> failwithf "unknown outcome kind %s" other

let outcomeJson (outcome: Outcome) : JsonNode =
    match outcome with
    | Outcome.Success(status, body, headers) -> obj [ "kind", str "success"; "status", num (int64 status); "body", str body; "headers", strings headers ]
    | Outcome.Failure(reason, status) ->
        obj
            [ yield "kind", str "failure"
              yield "reason", str reason
              match status with
              | Some code -> yield "status", num (int64 code)
              | None -> () ]
    | Outcome.Cancelled -> obj [ "kind", str "cancelled" ]
    | Outcome.Unknown -> obj [ "kind", str "unknown" ]

let interceptorOf (node: JsonNode) =
    let pair = node.AsObject() |> Seq.exactlyOne
    let body = pair.Value
    match pair.Key with
    | "header" -> Interceptor.Header(text body["name"], text body["value"])
    | "bearer" -> Interceptor.Bearer(text body["token"])
    | "timeout" -> Interceptor.Timeout(int64Of body["ms"])
    | "expose" -> Interceptor.Expose(items body["names"] |> List.map text)
    | "base" -> Interceptor.Base(text body["prefix"])
    | other -> failwithf "unknown interceptor %s" other

for case in items vectors["interceptors"] do
    let result = Interceptor.intercept (items case["interceptors"] |> List.map interceptorOf) (requestOf case["request"])
    judge $"""interceptors: {text case["name"]}""" case["expect"] (requestJson result)

let retry = vectors["retry"]
let retrySettings = retry["policy"]
let policy =
    { MaxAttempts = int (int64Of retrySettings["maxAttempts"])
      BaseDelayMs = int64Of retrySettings["baseDelayMs"]
      MaxDelayMs = int64Of retrySettings["maxDelayMs"]
      RetryStatuses = items retrySettings["retryStatuses"] |> List.map (int64Of >> int) }

let decisionJson (decision: RetryDecision) : JsonNode =
    match decision with
    | RetryDecision.Done -> str "done"
    | RetryDecision.Reconcile -> str "reconcile"
    | RetryDecision.Retry delay -> obj [ "retry", num delay ]
    | RetryDecision.GiveUp reason -> obj [ "giveUp", str reason ]

for case in items retry["cases"] do
    let request = { Request.create (text case["method"]) "/r" with Headers = stringMap case["headers"] }
    let decision = Retry.decide policy request (int (int64Of case["attempt"])) (outcomeOf case["outcome"])
    judge $"""retry: {text case["name"]}""" case["expect"] (decisionJson decision)

for scenario in items vectors["cache"] do
    items scenario["steps"]
    |> List.fold (fun (cache, index) (step: JsonNode) ->
        let name = $"""cache: {text scenario["name"]} step {index}"""
        if has "prepare" step then
            judge name step["expect"] (requestJson (Cache.prepare cache (requestOf step["prepare"])))
            cache, index + 1
        else
            let absorb = step["absorb"]
            let request = Request.create (text absorb["method"]) (text absorb["url"])
            let next, outcome = Cache.absorb cache request (outcomeOf step["outcome"])
            judge name step["expect"] (obj [ "outcome", outcomeJson outcome; "cached", arr (Cache.urls next |> List.map str) ])
            next, index + 1) (Cache.empty, 0)
    |> ignore

let polling = vectors["polling"]
let pollSettings = polling["policy"]
let pollPolicy =
    { IntervalMs = int64Of pollSettings["intervalMs"]
      MaxIntervalMs = int64Of pollSettings["maxIntervalMs"]
      Factor = int64Of pollSettings["factor"] }

items polling["steps"]
|> List.fold (fun (failuresSoFar, index) (step: JsonNode) ->
    let decision, next = Poll.next pollPolicy failuresSoFar (outcomeOf step["outcome"]) (step["stop"].GetValue<bool>())
    let actual =
        match decision with
        | PollDecision.After delay -> obj [ "after", num delay; "failures", num (int64 next) ]
        | PollDecision.Stop -> obj [ "stop", JsonValue.Create true; "failures", num (int64 next) ]
    judge $"polling step {index}" step["expect"] actual
    next, index + 1) (0, 0)
|> ignore

if failures.Count > 0 then
    failures |> Seq.iter (eprintfn "FAIL %s")
    eprintfn "HTTP conformance: %d of %d cases disagree." failures.Count (failures.Count + passed.Value)
    exit 1
else
    printfn "HTTP conformance: %d/%d cases agree (F# reference library)." passed.Value passed.Value
