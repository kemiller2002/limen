// The first example with an external effect.
//
// The engine never calls fetch(). It cannot — an engine has no browser APIs.
// It *requests* an Http effect by returning an EffectRequest, the kernel
// performs it, and the outcome comes back as an ordinary input message. All
// four EffectOutcome variants are represented as distinct states.
import type {
  BrowserToEngineMessage,
  CorrelationId,
  EffectOutcome,
  EffectRequest,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  ViewState,
} from "../../dist/protocol.js";

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

export type Customer = { readonly id: string; readonly name: string; readonly email: string };

export type State =
  | { readonly kind: "Idle" }
  | { readonly kind: "Loading"; readonly correlationId: CorrelationId }
  | { readonly kind: "Loaded"; readonly customers: readonly Customer[] }
  | { readonly kind: "LoadFailed"; readonly reason: string; readonly retryable: boolean }
  // A GET that timed out after dispatch. The request may or may not have
  // reached the server — but a GET is safe to repeat, so this state is
  // recoverable by retrying. Contrast 04-save-data, where the same outcome on
  // a POST is *not* safely retryable. Same kernel outcome, different domain
  // consequence: only the engine can make that call.
  | { readonly kind: "LoadOutcomeUnknown" };

export const initialState: State = { kind: "Idle" };

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  | { readonly kind: "Load"; readonly correlationId: CorrelationId }
  | { readonly kind: "RecordLoad"; readonly correlationId: CorrelationId; readonly outcome: EffectOutcome };

export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  switch (event.name) {
    case "load":
    case "retry":
      return { kind: "Load", correlationId };
    default:
      throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Decoding — the engine, not the kernel, decides what a response body means
// ---------------------------------------------------------------------------

// The kernel hands back `body: unknown`. It parsed JSON; it did not validate
// anything. Trusting the shape here would be the bug this whole architecture
// exists to prevent, so narrow it explicitly.
export function decodeCustomers(body: unknown): readonly Customer[] | null {
  if (!Array.isArray(body)) return null;
  const customers: Customer[] = [];
  for (const entry of body as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record["id"] !== "string") return null;
    if (typeof record["name"] !== "string") return null;
    if (typeof record["email"] !== "string") return null;
    customers.push({ id: record["id"], name: record["name"], email: record["email"] });
  }
  return customers;
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export type TransitionResult = {
  readonly state: State;
  readonly effects: readonly EffectRequest[];
};

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "Load": {
      // Loading twice at once is not a legal move: ignore the second request
      // rather than racing two in-flight effects against one state slot.
      if (state.kind === "Loading") return { state, effects: [] };
      return {
        state: { kind: "Loading", correlationId: command.correlationId },
        effects: [{
          kind: "Http",
          correlationId: command.correlationId,
          method: "GET",
          url: "/api/customers",
          timeoutMs: 5000,
        }],
      };
    }
    case "RecordLoad": {
      // Stale-evidence guard. A result whose correlationId doesn't match the
      // effect we're actually waiting on is discarded — it belongs to a
      // superseded request. Without this, a slow first response can overwrite
      // a fast second one.
      if (state.kind !== "Loading" || state.correlationId !== command.correlationId) {
        return { state, effects: [] };
      }
      switch (command.outcome.kind) {
        case "Success": {
          if (command.outcome.status !== 200) {
            return { state: { kind: "LoadFailed", reason: `Server returned ${command.outcome.status}.`, retryable: true }, effects: [] };
          }
          const customers = decodeCustomers(command.outcome.body);
          return customers === null
            ? { state: { kind: "LoadFailed", reason: "The server sent something unexpected.", retryable: false }, effects: [] }
            : { state: { kind: "Loaded", customers }, effects: [] };
        }
        case "Failure":
          return {
            state: {
              kind: "LoadFailed",
              reason: command.outcome.reason === "network" ? "Could not reach the server." : "The response could not be read.",
              retryable: command.outcome.reason === "network",
            },
            effects: [],
          };
        case "Cancelled":
          return { state: initialState, effects: [] };
        case "OutcomeUnknown":
          return { state: { kind: "LoadOutcomeUnknown" }, effects: [] };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function project(state: State): ViewState {
  return {
    statusText: statusTextFor(state),
    // Three separate booleans that happen to be mutually exclusive here only
    // because they are all derived from one `kind`. They are projection
    // output, never authoritative state — see docs/04-state-model.md.
    busy: state.kind === "Loading",
    hasCustomers: state.kind === "Loaded" && state.customers.length > 0,
    canRetry: state.kind === "LoadFailed" ? state.retryable : state.kind === "LoadOutcomeUnknown",
    loadDisabled: state.kind === "Loading",
    customers: state.kind === "Loaded" ? state.customers.map((c) => ({ ...c })) : [],
  };
}

function statusTextFor(state: State): string {
  switch (state.kind) {
    case "Idle":
      return "Nothing loaded yet.";
    case "Loading":
      return "Loading…";
    case "Loaded":
      return state.customers.length === 0 ? "No customers found." : `${state.customers.length} customer(s).`;
    case "LoadFailed":
      return state.reason;
    case "LoadOutcomeUnknown":
      return "The request timed out. It is safe to try again.";
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createFetchTransport(): EngineTransport {
  let state = initialState;
  let sequence = 0;
  const nextCorrelationId = (): CorrelationId => `load-${++sequence}` as CorrelationId;

  const respond = (result: TransitionResult): EngineToBrowserMessage => {
    state = result.state;
    return { view: project(state), effects: result.effects, cancellations: [] };
  };

  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      switch (message.kind) {
        case "Initialize":
          return { view: project(state), effects: [], cancellations: [] };
        case "Event":
          return respond(transition(state, eventToCommand(message.event, nextCorrelationId())));
        case "EffectResult": {
          if (message.result.kind !== "HttpResult") {
            throw new Error("This engine never requests a Storage effect.");
          }
          return respond(transition(state, {
            kind: "RecordLoad",
            correlationId: message.result.correlationId,
            outcome: message.result.outcome,
          }));
        }
      }
    },
  };
}
