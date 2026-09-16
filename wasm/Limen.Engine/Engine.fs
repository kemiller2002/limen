/// The wasm-side entry point: decode a `BrowserToEngineMessage`, transition,
/// encode an `EngineToBrowserMessage`.
///
/// This module owns the one mutable cell in the whole engine. Everything it
/// calls is pure; the mutation is here, in one place, exactly as the
/// TypeScript transport keeps one `let state`.
module Limen.Engine.Engine

open Limen.Engine.Json
open Limen.Engine.Protocol
open Limen.Engine.Domain
open Limen.Engine.Projection

// ---------------------------------------------------------------------------
// Decoding — external data, validated before it becomes trusted state
// ---------------------------------------------------------------------------

exception ProtocolError of string

let private requireString name value =
    match asString (field name value) with
    | Some s -> s
    | None -> raise (ProtocolError(sprintf "expected a string field '%s'" name))

let private decodeOutcome (outcome: Value) =
    match asString (field "kind" outcome) with
    | Some "Success" ->
        let status = asInt (field "status" outcome) |> Option.defaultValue 0
        let body = field "body" outcome |> Option.defaultValue JNull
        Success(status, body)
    | Some "Failure" ->
        Failure(requireString "reason" outcome, asInt (field "status" outcome))
    | Some "Cancelled" -> Cancelled
    | Some "OutcomeUnknown" ->
        OutcomeUnknown(asString (field "reason" outcome) |> Option.defaultValue "timeout-after-dispatch")
    | other -> raise (ProtocolError(sprintf "unknown Http outcome '%A'" other))

let private decodeClipboardOutcome (outcome: Value) =
    match asString (field "kind" outcome) with
    | Some "Success" -> ClipboardSuccess
    | Some "Failure" -> ClipboardFailure(requireString "reason" outcome)
    | other -> raise (ProtocolError(sprintf "unknown Clipboard outcome '%A'" other))

let decodeMessage (raw: string) : BrowserToEngine =
    let message = parse raw
    match asString (field "kind" message) with
    | Some "Initialize" ->
        let capabilities =
            match field "capabilities" message with
            | Some(JArray items) -> items |> List.choose (function JString s -> Some s | _ -> None)
            | _ -> []
        Initialize(capabilities, asString (field "location" message))
    | Some "Event" ->
        match field "event" message with
        | Some event ->
            Event
                { Name = requireString "name" event
                  Key = asString (field "key" event)
                  Value = asString (field "value" event) }
        | None -> raise (ProtocolError "Event message carried no event")
    | Some "EffectResult" ->
        match field "result" message with
        | Some result ->
            let correlationId = CorrelationId(requireString "correlationId" result)
            let outcome = field "outcome" result |> Option.defaultValue JNull
            match asString (field "kind" result) with
            | Some "HttpResult" -> HttpResult(correlationId, decodeOutcome outcome)
            | Some "ClipboardResult" -> ClipboardResult(correlationId, decodeClipboardOutcome outcome)
            // An engine must never silently ignore a result it did not expect.
            | other -> raise (ProtocolError(sprintf "this engine never requests a %A effect" other))
        | None -> raise (ProtocolError "EffectResult message carried no result")
    | other -> raise (ProtocolError(sprintf "unknown message kind '%A'" other))

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

let rec private encodeViewValue value =
    match value with
    | VString s -> JString s
    | VInt n -> JNumber(float n)
    | VBool b -> JBool b
    | VItems items -> JArray(items |> List.map (fun fields -> JObject(fields |> List.map (fun (k, v) -> k, encodeViewValue v))))

let private encodeEffect effect =
    match effect with
    | Http(CorrelationId id, method, url, timeoutMs) ->
        JObject
            [ "kind", JString "Http"
              "correlationId", JString id
              "method", JString(match method with GET -> "GET" | POST -> "POST")
              "url", JString url
              "timeoutMs", JNumber(float timeoutMs) ]
    | ClipboardWriteText(CorrelationId id, text) ->
        JObject
            [ "kind", JString "Clipboard"
              "correlationId", JString id
              "operation", JString "writeText"
              "text", JString text ]

let encodeResponse (response: EngineToBrowser) : string =
    JObject
        [ "view", JObject(response.View |> List.map (fun (k, v) -> k, encodeViewValue v))
          "effects", JArray(response.Effects |> List.map encodeEffect)
          "cancellations", JArray(response.Cancellations |> List.map (fun (CorrelationId id) -> JString id)) ]
    |> stringify

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/// A correlation id minted per request. Prefixed so it is obvious in a trace
/// which side of the boundary produced it.
let private nextCorrelationId =
    let mutable counter = 0
    fun () ->
        counter <- counter + 1
        CorrelationId(sprintf "wasm-%d" counter)

/// The one mutable cell.
let mutable private current = initialState

/// Resets the engine. Used by tests; a page load creates a fresh module.
let reset () = current <- initialState

let private respond effects =
    encodeResponse { View = project current; Effects = effects; Cancellations = [] }

/// Handle one message and return the response, both as JSON strings.
///
/// Every path returns a complete `ViewState` — the protocol is total, never a
/// patch — including the paths where nothing changed.
let handle (raw: string) : string =
    match decodeMessage raw with
    | Initialize _ ->
        // Nothing to request at startup. The site's demos are all
        // user-initiated, so the first projection is simply the initial state.
        respond []

    | Event event ->
        match eventToCommand event (nextCorrelationId ()) with
        // Loud, not silent. The refusal reached here as data; this is the one
        // place that decides what to do with it, and doing nothing would mean
        // a mistyped `data-event` produces a page that simply ignores clicks.
        // The kernel's error boundary catches this and reports BridgeError
        // without touching the DOM.
        | Error reason -> raise (ProtocolError reason)
        | Ok command ->
            let label =
                match event.Key with
                | Some key -> sprintf "%s(%s)" event.Name key
                | None -> event.Name
            let result = transition current command
            current <- apply current label result
            respond result.Effects

    | HttpResult(correlationId, outcome) ->
        let result = transition current (RecordLoad(correlationId, outcome))
        current <- apply current "EffectResult" result
        respond result.Effects

    | ClipboardResult(_, outcome) ->
        let result = transition current (RecordCopy outcome)
        current <- apply current "EffectResult" result
        respond result.Effects
