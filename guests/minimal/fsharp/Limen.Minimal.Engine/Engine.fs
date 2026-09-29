/// The minimal engine: a capability probe, specified language-neutrally in
/// conformance/sessions/minimal-engine.md. Pure state and transitions.
module Limen.Minimal.Engine

open Limen.Contract.Core
open Limen.Guest

type Entry = { Id: int; Text: string }

type State =
    | Ready of log: Entry list * lastId: int * next: int * pending: Map<string, string>
    | Incompatible


/// The minimal engine speaks protocol 1.1, as its specification says
/// (conformance/sessions/minimal-engine.md): it uses none of 1.2's form-control
/// state, so a 1.2 kernel never sends it those fields.
let minimalRequirements : Handshake.Requirements =
    { Handshake.coreOnly with Protocol = { Major = 1L; Minor = 1L } }

let initial = Ready([], 0, 1, Map.empty)

let private logLimit = 20

let private record text state =
    match state with
    | Ready(log, lastId, next, pending) ->
        let entry = { Id = lastId + 1; Text = text }
        let kept = log @ [ entry ] |> List.rev |> List.truncate logLimit |> List.rev
        Ready(kept, lastId + 1, next, pending)
    | Incompatible -> Incompatible

let project state : ViewState =
    match state with
    | Incompatible -> Map.ofList [ "status", ViewValue.Text "incompatible"; "count", ViewValue.Number 0.0; "log", ViewValue.Items [] ]
    | Ready(log, _, _, _) ->
        Map.ofList
            [ "status", ViewValue.Text "ready"
              "count", ViewValue.Number(float log.Length)
              "log", ViewValue.Items(log |> List.map (fun entry -> Map.ofList [ "id", ViewPrimitive.Text(string entry.Id); "text", ViewPrimitive.Text entry.Text ])) ]

let private request (label: string) (correlationId: CorrelationId) : EffectRequest option =
    let http url = Some(EffectRequest.Http { CorrelationId = correlationId; Method = HttpMethod.Get; Url = url; Headers = None; Body = None; TimeoutMs = 5000L; Response = None; ResponseHeaders = None; Credentials = None; Xsrf = None })
    match label with
    | "http-ok" -> http "/ok.json"
    | "http-missing" -> http "/missing.json"
    | "storage-set" -> Some(EffectRequest.Storage(StorageEffectRequest.Set(correlationId, "limen-minimal", "saved")))
    | "storage-get" -> Some(EffectRequest.Storage(StorageEffectRequest.Get(correlationId, "limen-minimal")))
    | "clipboard" -> Some(EffectRequest.Clipboard { CorrelationId = correlationId; Text = "limen" })
    | "nav-push" -> Some(EffectRequest.Navigation(NavigationEffectRequest.Push(correlationId, "?screen=two")))
    | "nav-away" -> Some(EffectRequest.Navigation(NavigationEffectRequest.Push(correlationId, "https://example.org/elsewhere")))
    | _ -> None

let private failureWithStatus (reason: string) (status: int64 option) =
    match status with
    | Some code -> $"failure {reason} {code}"
    | None -> $"failure {reason}"

let describe (result: EffectResult) : string =
    match result with
    | EffectResult.HttpResult(_, outcome) ->
        match outcome with
        | EffectOutcome.Success(status, _, _) -> $"success {status}"
        | EffectOutcome.Failure(reason, status) -> failureWithStatus (Codec.wireHttpFailureReason reason) status
        | EffectOutcome.Cancelled -> "cancelled"
        | EffectOutcome.OutcomeUnknown _ -> "unknown"
    | EffectResult.StorageResult(_, outcome) ->
        match outcome with
        | StorageOutcome.Success(Some value) -> $"success {value}"
        | StorageOutcome.Success None -> "success null"
        | StorageOutcome.Failure reason -> $"failure {Codec.wireStorageFailureReason reason}"
    | EffectResult.ClipboardResult(_, outcome) ->
        match outcome with
        | ClipboardOutcome.Success -> "success"
        | ClipboardOutcome.Failure reason -> $"failure {Codec.wireClipboardFailureReason reason}"
    | EffectResult.NavigationResult(_, outcome) ->
        match outcome with
        | NavigationOutcome.Success location -> $"success {location.Path}{location.Query}"
        | NavigationOutcome.Dispatched -> "dispatched"
        | NavigationOutcome.Failure reason -> $"failure {Codec.wireNavigationFailureReason reason}"
    | EffectResult.CapabilityResult _ -> "unexpected capability result"

let private correlationOf (result: EffectResult) =
    match result with
    | EffectResult.HttpResult(CorrelationId id, _)
    | EffectResult.StorageResult(CorrelationId id, _)
    | EffectResult.ClipboardResult(CorrelationId id, _)
    | EffectResult.NavigationResult(CorrelationId id, _)
    | EffectResult.CapabilityResult(CorrelationId id, _, _, _) -> id

let private respond state effects handshake : State * EngineToBrowserMessage =
    state, { View = project state; Effects = effects; Cancellations = []; Handshake = handshake }

/// One transition: the state after the message, and the response to send.
let handle (state: State) (message: BrowserToEngineMessage) : State * EngineToBrowserMessage =
    match state with
    | Incompatible -> respond Incompatible [] None
    | Ready(_, _, next, pending) ->
        match message with
        | BrowserToEngineMessage.Initialize(_, _, offer) ->
            match Handshake.answer offer minimalRequirements with
            | EngineHandshake.Accepted _ as accepted -> respond (record "ready" state) [] (Some accepted)
            | EngineHandshake.Rejected _ as rejected -> respond Incompatible [] (Some rejected)
        | BrowserToEngineMessage.Event semanticEvent ->
            let correlationId = $"c{next}"
            match request semanticEvent.Name (CorrelationId correlationId) with
            | None -> respond (record $"ignored {semanticEvent.Name}" state) [] None
            | Some effect ->
                match record $"requested {semanticEvent.Name}" state with
                | Ready(log, lastId, _, _) -> respond (Ready(log, lastId, next + 1, pending.Add(correlationId, semanticEvent.Name))) [ effect ] None
                | Incompatible -> respond Incompatible [] None
        | BrowserToEngineMessage.EffectResult result ->
            let correlationId = correlationOf result
            match pending.TryFind correlationId with
            | None -> respond (record $"stale {correlationId}" state) [] None
            | Some label ->
                match record $"{label}: {describe result}" state with
                | Ready(log, lastId, next, pending) -> respond (Ready(log, lastId, next, pending.Remove correlationId)) [] None
                | Incompatible -> respond Incompatible [] None
        | BrowserToEngineMessage.LocationChanged location -> respond (record $"location {location.Path}{location.Query}" state) [] None
        | BrowserToEngineMessage.CapabilityFact(CapabilityId capability, _, _) -> respond (record $"unexpected fact {capability}" state) [] None
