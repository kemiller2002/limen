// The Clipboard capability, end to end. The whole point of this example is
// what is *absent*: no `navigator.clipboard` call appears anywhere in it, and
// none can — this file is checked by scripts/check-architecture.ts, which
// fails the build if engine code so much as names a browser global.
//
// The engine asks. The kernel performs. The answer comes back as a typed
// outcome and becomes state, like every other effect.
import type {
  BrowserToEngineMessage,
  ClipboardOutcome,
  CorrelationId,
  EffectRequest,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  ViewState,
} from "../../dist/protocol.js";

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

// What the user is being offered to copy. Held in state rather than read back
// out of the DOM at copy time: the text that gets copied and the text on
// screen are then the same value by construction, not by coincidence.
export type Share = { readonly label: string; readonly url: string };

export const shares: readonly Share[] = [
  { label: "This page", url: "https://limen.example/examples/07-clipboard/" },
  { label: "The docs", url: "https://limen.example/docs/clipboard" },
];

// Four states, and "Copying" is one of them. A clipboard write is
// asynchronous and permission-gated, so the gap between asking and knowing is
// real; representing it is what lets the button disable itself honestly
// instead of inviting a second click that races the first.
export type FailureReason = "denied" | "unavailable" | "unknown";

export type State =
  | { readonly kind: "Idle" }
  | { readonly kind: "Copying"; readonly correlationId: CorrelationId; readonly url: string }
  | { readonly kind: "Copied"; readonly url: string }
  | { readonly kind: "CopyFailed"; readonly reason: FailureReason };

export const initialState: State = { kind: "Idle" };

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  | { readonly kind: "Copy"; readonly url: string; readonly correlationId: CorrelationId }
  | { readonly kind: "RecordCopy"; readonly correlationId: CorrelationId; readonly outcome: ClipboardOutcome }
  | { readonly kind: "Dismiss" };

// The DOM sends `copy` with the share's key. Which URL that key stands for is
// decided here — the button carries an opaque key, never the URL itself.
export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  switch (event.name) {
    case "copy": {
      const share = shares.find((candidate) => candidate.label === event.key);
      if (!share) throw new Error(`Unrecognized share key: ${String(event.key)}`);
      return { kind: "Copy", url: share.url, correlationId };
    }
    case "dismiss":
      return { kind: "Dismiss" };
    default:
      throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type TransitionResult = {
  readonly state: State;
  readonly effects: readonly EffectRequest[];
  // Whether the command was legal in this state. An illegal one leaves the
  // state untouched and says so, rather than throwing or quietly working.
  readonly accepted: boolean;
};

const stay = (state: State): TransitionResult => ({ state, effects: [], accepted: false });
const go = (state: State, effects: readonly EffectRequest[] = []): TransitionResult =>
  ({ state, effects, accepted: true });

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "Copy":
      // A second copy while one is in flight is refused, not queued. The
      // projection already disables the button; this is the same rule stated
      // where it is actually enforced.
      if (state.kind === "Copying") return stay(state);
      return go(
        { kind: "Copying", correlationId: command.correlationId, url: command.url },
        [{ kind: "Clipboard", correlationId: command.correlationId, operation: "writeText", text: command.url }],
      );

    case "RecordCopy": {
      // Evidence that does not match what we are waiting for is not evidence.
      // A result from a superseded attempt must not overwrite a newer one.
      if (state.kind !== "Copying" || state.correlationId !== command.correlationId) return stay(state);
      if (command.outcome.kind === "Success") return go({ kind: "Copied", url: state.url });
      return go({ kind: "CopyFailed", reason: command.outcome.reason });
    }

    case "Dismiss":
      return state.kind === "Copying" ? stay(state) : go({ kind: "Idle" });
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

// Why each failure gets its own sentence: "denied" usually means the browser
// wanted a fresher user gesture, so clicking again genuinely works.
// "unavailable" means this browser or this context (an insecure origin, an
// iframe without permission) has no Clipboard API at all, and clicking again
// never will. Telling a user to retry something that cannot succeed is worse
// than telling them nothing.
const message = (state: State): string => {
  switch (state.kind) {
    case "Idle": return "";
    case "Copying": return "Copying…";
    case "Copied": return "Copied to the clipboard.";
    case "CopyFailed":
      switch (state.reason) {
        case "denied": return "The browser refused the copy. Click Copy again — it usually works on a fresh click.";
        case "unavailable": return "This browser will not give the page clipboard access. Select the link and copy it manually.";
        case "unknown": return "The copy did not complete.";
      }
  }
};

export function project(state: State): ViewState {
  const busy = state.kind === "Copying";
  return {
    statusText: message(state),
    // Availability is projected, never re-derived by the DOM from the message
    // text. The engine is the only thing that knows a copy is in flight.
    copyDisabled: busy,
    showStatus: state.kind !== "Idle",
    // Only "denied" is worth offering a retry for; see the comment above.
    canRetry: state.kind === "CopyFailed" && state.reason === "denied",
    // `copyDisabled` is repeated on every row deliberately. Inside a
    // data-each, bindings resolve against the *item*, not the top-level view —
    // a row binding a key that only exists at the top level fails the
    // projection outright. Repeating it is how a per-row capability is
    // projected; it is not duplicated state, since both copies are computed
    // here from the same `busy`.
    shares: shares.map((share) => ({ id: share.label, label: share.label, url: share.url, copyDisabled: busy })),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createClipboardTransport(): EngineTransport {
  let state: State = initialState;
  let sequence = 0;
  const nextCorrelationId = (): CorrelationId => `copy-${++sequence}` as CorrelationId;

  const respond = (result: TransitionResult): EngineToBrowserMessage =>
    ({ view: project((state = result.state)), effects: result.effects, cancellations: [] });

  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      switch (message.kind) {
        case "Initialize":
          // `message.capabilities` lists what the kernel implements, not what
          // this browser will permit — so it is deliberately NOT used to
          // pre-disable the button. Whether the clipboard actually works is
          // only knowable by trying, and the outcome says so.
          return { view: project(state), effects: [], cancellations: [] };
        case "Event":
          return respond(transition(state, eventToCommand(message.event, nextCorrelationId())));
        case "EffectResult": {
          if (message.result.kind !== "ClipboardResult") {
            throw new Error(`Unexpected ${message.result.kind}: this engine requests only Clipboard effects.`);
          }
          return respond(transition(state, {
            kind: "RecordCopy",
            correlationId: message.result.correlationId,
            outcome: message.result.outcome,
          }));
        }
        case "LocationChanged":
          // Nothing here is URL-driven. See examples/08-routing for an engine
          // that reacts to this message.
          return { view: project(state), effects: [], cancellations: [] };
      }
    },
  };
}
