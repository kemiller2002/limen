/// The Limen wire contract, in F#.
///
/// This is a deliberate, hand-written mirror of `src/protocol.ts`. It is not
/// generated, and it must not drift: `test/wasm.test.ts` drives this engine
/// through the real BrowserKernel, so a disagreement shows up as a failing
/// test rather than as a silent mismatch in production.
///
/// Nothing here references a browser API, a JS value, or an element. That is
/// the whole point of the exercise — `scripts/check-architecture.ts` bans
/// `IJSRuntime` and `JsValue` precisely so a ported engine cannot reach back
/// into JavaScript, and this engine never does.
module Limen.Engine.Protocol

/// Correlates an effect request with the result that answers it.
type CorrelationId = CorrelationId of string

/// Evidence from the browser. `Name` is the application's own vocabulary — the
/// value of a `data-event` attribute — and the bridge never interprets it.
type SemanticEvent =
    { Name: string
      Key: string option
      Value: string option }

/// What an Http effect can come back as. All four cases, including the one
/// most systems omit: a timeout cannot prove the request did not arrive.
type EffectOutcome =
    | Success of status: int * body: Json.Value
    | Failure of reason: string * status: int option
    | Cancelled
    | OutcomeUnknown of reason: string

type ClipboardOutcome =
    | ClipboardSuccess
    | ClipboardFailure of reason: string

/// A projected value. Flat scalars and flat item lists only — exactly what
/// `ViewState` permits on the TypeScript side.
type ViewValue =
    | VString of string
    | VInt of int
    | VBool of bool
    | VItems of (string * ViewValue) list list

type ViewState = (string * ViewValue) list

type HttpMethod =
    | GET
    | POST

type EffectRequest =
    | Http of correlationId: CorrelationId * method: HttpMethod * url: string * timeoutMs: int
    | ClipboardWriteText of correlationId: CorrelationId * text: string

/// Everything the browser can tell this engine.
type BrowserToEngine =
    | Initialize of capabilities: string list * location: string option
    | Event of SemanticEvent
    | HttpResult of CorrelationId * EffectOutcome
    | ClipboardResult of CorrelationId * ClipboardOutcome

type EngineToBrowser =
    { View: ViewState
      Effects: EffectRequest list
      Cancellations: CorrelationId list }
