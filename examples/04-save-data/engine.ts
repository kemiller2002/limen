// The full save lifecycle, plus the Storage effect.
//
//   Restoring → Editing → Saving → Saved
//                            ├──→ SaveFailed
//                            └──→ SaveOutcomeUnknown
//
// Two effect kinds appear here: Storage (a local draft, so a refresh doesn't
// lose typing) and Http (the actual save). Both are *requested* by the engine
// and *performed* by the kernel.
import type {
  BrowserToEngineMessage,
  CorrelationId,
  EffectOutcome,
  EffectRequest,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  StorageOutcome,
  ViewState,
} from "../../dist/protocol.js";

const DRAFT_KEY = "example-04-draft";

// Correlation IDs for the three storage operations. They are fixed rather
// than sequential because at most one of each is ever meaningful at a time,
// and a fixed ID makes "which result is this?" answerable without a side
// table. The Http save uses a sequence, because two saves in a row must not
// be confused with each other.
const DRAFT_GET = "draft-get" as CorrelationId;
const DRAFT_SET = "draft-set" as CorrelationId;
const DRAFT_REMOVE = "draft-remove" as CorrelationId;

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

export type State =
  | { readonly kind: "Restoring" }
  | { readonly kind: "Editing"; readonly text: string; readonly savedText: string }
  | { readonly kind: "Saving"; readonly text: string; readonly correlationId: CorrelationId }
  | { readonly kind: "Saved"; readonly text: string }
  | { readonly kind: "SaveFailed"; readonly text: string; readonly reason: string; readonly retryable: boolean }
  // A POST that timed out after dispatch. Unlike the GET in 03-fetch-data,
  // this is NOT safely retryable: the note may already have been created, and
  // retrying could create a second one. The only correct move is to reconcile
  // against the server. Representing this as its own state — rather than
  // folding it into SaveFailed — is the whole reason OutcomeUnknown exists.
  | { readonly kind: "SaveOutcomeUnknown"; readonly text: string };

export const initialState: State = { kind: "Restoring" };

export const textOf = (state: State): string => (state.kind === "Restoring" ? "" : state.text);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  | { readonly kind: "RestoreDraft"; readonly outcome: StorageOutcome }
  | { readonly kind: "EditText"; readonly value: string }
  | { readonly kind: "Save"; readonly correlationId: CorrelationId }
  | { readonly kind: "RecordSave"; readonly correlationId: CorrelationId; readonly outcome: EffectOutcome }
  | { readonly kind: "Resume" };

export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  switch (event.name) {
    case "textChanged":
      return { kind: "EditText", value: event.value ?? "" };
    case "save":
    case "retrySave":
      return { kind: "Save", correlationId };
    case "resumeEditing":
      return { kind: "Resume" };
    default:
      throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export type TransitionResult = {
  readonly state: State;
  readonly effects: readonly EffectRequest[];
};

const saveEffect = (text: string, correlationId: CorrelationId): EffectRequest => ({
  kind: "Http",
  correlationId,
  method: "POST",
  url: "/api/notes",
  headers: { "content-type": "application/json" },
  // The engine serializes its own body. The kernel passes the string to
  // fetch() uninterpreted — it never knows this is a note.
  body: JSON.stringify({ text }),
  timeoutMs: 5000,
});

const writeDraft = (text: string): EffectRequest =>
  ({ kind: "Storage", correlationId: DRAFT_SET, operation: "set", key: DRAFT_KEY, value: text });

const clearDraft = (): EffectRequest =>
  ({ kind: "Storage", correlationId: DRAFT_REMOVE, operation: "remove", key: DRAFT_KEY });

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "RestoreDraft": {
      if (state.kind !== "Restoring") return { state, effects: [] };
      // A missing draft (Success with value null) and an unreadable store
      // (Failure — private browsing, disabled storage) land in the same place:
      // an empty editor. Losing a local convenience must not block the feature.
      const restored = command.outcome.kind === "Success" ? command.outcome.value ?? "" : "";
      return { state: { kind: "Editing", text: restored, savedText: "" }, effects: [] };
    }
    case "EditText": {
      if (state.kind === "Restoring" || state.kind === "Saving") return { state, effects: [] };
      const savedText = state.kind === "Editing" ? state.savedText : state.text;
      return {
        state: { kind: "Editing", text: command.value, savedText },
        effects: [writeDraft(command.value)],
      };
    }
    case "Save": {
      if (state.kind === "Saving" || state.kind === "Restoring") return { state, effects: [] };
      // Saving nothing is not a legal move.
      if (state.text.trim() === "") return { state, effects: [] };
      return {
        state: { kind: "Saving", text: state.text, correlationId: command.correlationId },
        effects: [saveEffect(state.text, command.correlationId)],
      };
    }
    case "RecordSave": {
      if (state.kind !== "Saving" || state.correlationId !== command.correlationId) {
        return { state, effects: [] };
      }
      switch (command.outcome.kind) {
        case "Success":
          return command.outcome.status >= 200 && command.outcome.status < 300
            // The server now owns the text, so the local draft is obsolete.
            ? { state: { kind: "Saved", text: state.text }, effects: [clearDraft()] }
            : {
              state: { kind: "SaveFailed", text: state.text, reason: `Server returned ${command.outcome.status}.`, retryable: false },
              effects: [],
            };
        case "Failure":
          return {
            state: {
              kind: "SaveFailed",
              text: state.text,
              reason: command.outcome.reason === "network" ? "Could not reach the server." : "The response could not be read.",
              retryable: command.outcome.reason === "network",
            },
            effects: [],
          };
        case "Cancelled":
          return { state: { kind: "Editing", text: state.text, savedText: "" }, effects: [] };
        case "OutcomeUnknown":
          return { state: { kind: "SaveOutcomeUnknown", text: state.text }, effects: [] };
      }
    }
    case "Resume": {
      if (state.kind !== "Saved") return { state, effects: [] };
      return { state: { kind: "Editing", text: state.text, savedText: state.text }, effects: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

export function project(state: State): ViewState {
  const text = textOf(state);
  return {
    text,
    statusText: statusTextFor(state),
    // "Is there unsaved work?" is a domain question, so the engine answers it.
    // The DOM does not compare the textarea against anything.
    dirty: state.kind === "Editing" && state.text !== state.savedText && state.text.trim() !== "",
    saveDisabled: state.kind === "Saving" || state.kind === "Restoring" || text.trim() === "" || state.kind === "Saved",
    editorDisabled: state.kind === "Saving" || state.kind === "Restoring",
    busy: state.kind === "Saving",
    canRetry: state.kind === "SaveFailed" && state.retryable,
    // Deliberately NOT offering a retry button. The correct recovery from an
    // unknown outcome is reconciliation, not a blind second POST.
    needsReconciliation: state.kind === "SaveOutcomeUnknown",
    saved: state.kind === "Saved",
  };
}

function statusTextFor(state: State): string {
  switch (state.kind) {
    case "Restoring":
      return "Restoring your draft…";
    case "Editing":
      return state.text === state.savedText && state.text !== "" ? "No changes since last save." : "Unsaved changes.";
    case "Saving":
      return "Saving…";
    case "Saved":
      return "Saved.";
    case "SaveFailed":
      return state.reason;
    case "SaveOutcomeUnknown":
      return "The save timed out. It may or may not have gone through — reload to check before saving again.";
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createSaveTransport(): EngineTransport {
  let state = initialState;
  let sequence = 0;
  const nextCorrelationId = (): CorrelationId => `save-${++sequence}` as CorrelationId;

  const respond = (result: TransitionResult): EngineToBrowserMessage => {
    state = result.state;
    return { view: project(state), effects: result.effects, cancellations: [] };
  };

  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      switch (message.kind) {
        case "Initialize":
          // The very first thing this app does is ask the kernel to read
          // localStorage. Even startup I/O is an explicit effect request.
          return {
            view: project(state),
            effects: [{ kind: "Storage", correlationId: DRAFT_GET, operation: "get", key: DRAFT_KEY }],
            cancellations: [],
          };
        case "Event":
          return respond(transition(state, eventToCommand(message.event, nextCorrelationId())));
        case "EffectResult": {
          if (message.result.kind === "HttpResult") {
            return respond(transition(state, {
              kind: "RecordSave",
              correlationId: message.result.correlationId,
              outcome: message.result.outcome,
            }));
          }
          if (message.result.correlationId === DRAFT_GET) {
            return respond(transition(state, { kind: "RestoreDraft", outcome: message.result.outcome }));
          }
          // A draft write/removal result. Nothing depends on it: persisting a
          // local draft is best-effort, and failing to do so must not change
          // what the user can do. Acknowledged by re-projecting unchanged.
          return { view: project(state), effects: [], cancellations: [] };
        }
      }
    },
  };
}
