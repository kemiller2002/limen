// The smallest possible engine. No effects, no async, no validation.
//
// Everything imported from the kernel here is a *type*. This file has no
// runtime dependency on the kernel at all, which is what lets the test suite
// import it directly as TypeScript and lets it be ported to another language
// later without the port having to reproduce any kernel behavior.
import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
  ViewState,
} from "../../dist/protocol.js";

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

export type State = { readonly count: number };

export const initialState: State = { count: 0 };

// ---------------------------------------------------------------------------
// Commands — the closed vocabulary this engine accepts
// ---------------------------------------------------------------------------

export type Command = { readonly kind: "Increment" } | { readonly kind: "Reset" };

// `data-event` attribute values arrive here verbatim as strings. This is the
// one place that open vocabulary is narrowed to a closed one. An unknown name
// is an error, not a silent no-op: a typo'd data-event should be loud.
export function eventToCommand(name: string): Command {
  switch (name) {
    case "increment":
      return { kind: "Increment" };
    case "reset":
      return { kind: "Reset" };
    default:
      throw new Error(`Unrecognized event: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Transition — pure: (state, command) -> state
// ---------------------------------------------------------------------------

export function transition(state: State, command: Command): State {
  switch (command.kind) {
    case "Increment":
      return { count: state.count + 1 };
    case "Reset":
      return initialState;
  }
}

// ---------------------------------------------------------------------------
// Projection — pure: state -> ViewState
// ---------------------------------------------------------------------------

// Note `resetDisabled`. The engine decides whether Reset is available; the
// DOM never re-derives that from the displayed count. This is the "capability"
// rule: if the UI needs to know whether something is allowed, the engine says
// so explicitly in the projection.
export function project(state: State): ViewState {
  return {
    count: state.count,
    resetDisabled: state.count === 0,
  };
}

// ---------------------------------------------------------------------------
// Transport — the one mutable cell in the whole example
// ---------------------------------------------------------------------------

export function createCounterTransport(): EngineTransport {
  let state = initialState;
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (message.kind === "Event") {
        state = transition(state, eventToCommand(message.event.name));
      }
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}
