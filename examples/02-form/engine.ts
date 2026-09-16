// Validation, capability projection, and a rejected illegal transition.
// Still no effects — nothing here leaves the engine. See 03-fetch-data for that.
import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  ViewState,
} from "../../dist/protocol.js";

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

export type Draft = { readonly name: string; readonly email: string };

// Two states, not a pile of booleans. There is no way to represent
// "submitted but still editing" because that combination cannot be written
// down. See docs/04-state-model.md for why this matters.
export type State =
  | { readonly kind: "Editing"; readonly draft: Draft }
  | { readonly kind: "Submitted"; readonly draft: Draft };

export const emptyDraft: Draft = { name: "", email: "" };
export const initialState: State = { kind: "Editing", draft: emptyDraft };

// ---------------------------------------------------------------------------
// Validation — pure, and the only place these rules exist
// ---------------------------------------------------------------------------

export const isNameValid = (value: string): boolean => value.trim().length >= 2;
export const isEmailValid = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
export const isDraftValid = (draft: Draft): boolean => isNameValid(draft.name) && isEmailValid(draft.email);

// An empty field is incomplete, not wrong — don't scold someone for not having
// typed yet. A message appears only once there is something to be wrong about.
const nameMessage = (value: string): string =>
  value === "" || isNameValid(value) ? "" : "Name must be at least 2 characters.";
const emailMessage = (value: string): string =>
  value === "" || isEmailValid(value) ? "" : "Enter a valid email address.";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  | { readonly kind: "EditName"; readonly value: string }
  | { readonly kind: "EditEmail"; readonly value: string }
  | { readonly kind: "Submit" }
  | { readonly kind: "StartOver" };

export function eventToCommand(event: SemanticEvent): Command {
  switch (event.name) {
    case "nameChanged":
      return { kind: "EditName", value: event.value ?? "" };
    case "emailChanged":
      return { kind: "EditEmail", value: event.value ?? "" };
    case "submit":
      return { kind: "Submit" };
    case "startOver":
      return { kind: "StartOver" };
    default:
      throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { readonly accepted: true; readonly state: State }
  | { readonly accepted: false; readonly state: State; readonly reason: string };

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "EditName":
    case "EditEmail": {
      // Editing a field after submitting is not a legal move in this feature.
      // The UI already prevents it (the inputs project as disabled), but the
      // engine rejects it anyway: the projection is a convenience, the
      // transition rule is the guarantee.
      if (state.kind !== "Editing") return { accepted: false, state, reason: "Cannot edit after submitting." };
      const draft: Draft = command.kind === "EditName"
        ? { ...state.draft, name: command.value }
        : { ...state.draft, email: command.value };
      return { accepted: true, state: { kind: "Editing", draft } };
    }
    case "Submit": {
      if (state.kind !== "Editing") return { accepted: false, state, reason: "Already submitted." };
      if (!isDraftValid(state.draft)) return { accepted: false, state, reason: "Fix the errors above first." };
      return { accepted: true, state: { kind: "Submitted", draft: state.draft } };
    }
    case "StartOver":
      return { accepted: true, state: initialState };
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function project(state: State, lastRejection = ""): ViewState {
  const { draft } = state;
  const editing = state.kind === "Editing";
  const nameError = editing ? nameMessage(draft.name) : "";
  const emailError = editing ? emailMessage(draft.email) : "";
  return {
    name: draft.name,
    email: draft.email,
    nameError,
    emailError,
    // `data-if` keys are projected separately from the message itself: the
    // kernel tests truthiness of this key and never inspects the message.
    nameErrorVisible: nameError !== "",
    emailErrorVisible: emailError !== "",
    // Capabilities. The DOM does not re-derive "can I submit?" from the
    // rendered error text — the engine answers it directly.
    submitDisabled: !editing || !isDraftValid(draft),
    fieldsDisabled: !editing,
    submitted: state.kind === "Submitted",
    confirmation: state.kind === "Submitted" ? `Account created for ${draft.name} (${draft.email}).` : "",
    formMessage: lastRejection,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createFormTransport(): EngineTransport {
  let state = initialState;
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (message.kind !== "Event") return { view: project(state), effects: [], cancellations: [] };
      const result = transition(state, eventToCommand(message.event));
      state = result.state;
      return {
        view: project(state, result.accepted ? "" : result.reason),
        effects: [],
        cancellations: [],
      };
    },
  };
}
