// A realistic feature, assembled only from what the earlier examples showed:
// load a list, validate and add to it, mark a row processed, refresh.
//
// Nothing clever happens here. That is the point — a real feature should look
// like the small examples, just with more states.
//
//   Loading ─ok→ Ready ─add/process→ Submitting ─ok→ Refreshing ─ok→ Ready
//      └─fail→ LoadFailed                  └─fail→ Ready (with an error notice)
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

export type EntryStatus = "Saved" | "Processed";

export type Entry = {
  readonly id: string;
  readonly date: string;
  readonly hours: number;
  readonly description: string;
  readonly status: EntryStatus;
};

export type Draft = {
  readonly date: string;
  readonly hours: string;
  readonly description: string;
};

// What the engine is currently waiting on. Carried inside Submitting so the
// result can be interpreted without a side table.
export type Pending =
  | { readonly kind: "AddEntry" }
  | { readonly kind: "MarkProcessed"; readonly entryId: string };

export type State =
  | { readonly kind: "Loading" }
  | { readonly kind: "LoadFailed"; readonly reason: string }
  | { readonly kind: "Ready"; readonly entries: readonly Entry[]; readonly draft: Draft; readonly notice: string }
  | {
    readonly kind: "Submitting";
    readonly entries: readonly Entry[];
    readonly draft: Draft;
    readonly correlationId: CorrelationId;
    readonly pending: Pending;
  }
  | {
    readonly kind: "Refreshing";
    readonly entries: readonly Entry[];
    readonly draft: Draft;
    readonly correlationId: CorrelationId;
    readonly notice: string;
  };

export const emptyDraft: Draft = { date: "", hours: "", description: "" };
export const initialState: State = { kind: "Loading" };

// ---------------------------------------------------------------------------
// Validation — pure, and the only place these rules exist
// ---------------------------------------------------------------------------

export const dateError = (value: string): string =>
  value.trim() === "" ? "Pick a date." : /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? "" : "Use YYYY-MM-DD.";

export const hoursError = (value: string): string => {
  if (value.trim() === "") return "Enter hours.";
  const hours = Number(value);
  if (!Number.isFinite(hours)) return "Hours must be a number.";
  if (hours <= 0) return "Hours must be greater than zero.";
  if (hours > 24) return "A day has 24 hours.";
  return "";
};

export const descriptionError = (value: string): string =>
  value.trim().length >= 3 ? "" : "Describe the work in at least 3 characters.";

export const isDraftValid = (draft: Draft): boolean =>
  dateError(draft.date) === "" && hoursError(draft.hours) === "" && descriptionError(draft.description) === "";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  | { readonly kind: "Load"; readonly correlationId: CorrelationId }
  | { readonly kind: "EditDraft"; readonly field: keyof Draft; readonly value: string }
  | { readonly kind: "AddEntry"; readonly correlationId: CorrelationId }
  | { readonly kind: "MarkProcessed"; readonly entryId: string; readonly correlationId: CorrelationId }
  | { readonly kind: "RecordResult"; readonly correlationId: CorrelationId; readonly outcome: EffectOutcome };

export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  switch (event.name) {
    case "refresh":
    case "retryLoad":
      return { kind: "Load", correlationId };
    case "dateChanged":
      return { kind: "EditDraft", field: "date", value: event.value ?? "" };
    case "hoursChanged":
      return { kind: "EditDraft", field: "hours", value: event.value ?? "" };
    case "descriptionChanged":
      return { kind: "EditDraft", field: "description", value: event.value ?? "" };
    case "addEntry":
      return { kind: "AddEntry", correlationId };
    case "markProcessed":
      // The row's key, supplied by data-each, says which entry.
      return { kind: "MarkProcessed", entryId: event.key ?? "", correlationId };
    default:
      throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

export function decodeEntries(body: unknown): readonly Entry[] | null {
  if (!Array.isArray(body)) return null;
  const entries: Entry[] = [];
  for (const raw of body as readonly unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const status = record["status"];
    if (typeof record["id"] !== "string") return null;
    if (typeof record["date"] !== "string") return null;
    if (typeof record["hours"] !== "number") return null;
    if (typeof record["description"] !== "string") return null;
    if (status !== "Saved" && status !== "Processed") return null;
    entries.push({
      id: record["id"],
      date: record["date"],
      hours: record["hours"],
      description: record["description"],
      status,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const loadEffect = (correlationId: CorrelationId): EffectRequest =>
  ({ kind: "Http", correlationId, method: "GET", url: "/api/time-entries", timeoutMs: 5000 });

const addEffect = (draft: Draft, correlationId: CorrelationId): EffectRequest => ({
  kind: "Http",
  correlationId,
  method: "POST",
  url: "/api/time-entries",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ date: draft.date.trim(), hours: Number(draft.hours), description: draft.description.trim() }),
  timeoutMs: 5000,
});

const processEffect = (entryId: string, correlationId: CorrelationId): EffectRequest => ({
  kind: "Http",
  correlationId,
  method: "PATCH",
  url: `/api/time-entries/${encodeURIComponent(entryId)}`,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ status: "Processed" }),
  timeoutMs: 5000,
});

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export type TransitionResult = {
  readonly state: State;
  readonly effects: readonly EffectRequest[];
};

const still = (state: State): TransitionResult => ({ state, effects: [] });

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "Load": {
      if (state.kind === "Submitting" || state.kind === "Refreshing") return still(state);
      if (state.kind === "Ready") {
        return {
          state: { kind: "Refreshing", entries: state.entries, draft: state.draft, correlationId: command.correlationId, notice: "" },
          effects: [loadEffect(command.correlationId)],
        };
      }
      return { state: { kind: "Loading" }, effects: [loadEffect(command.correlationId)] };
    }

    case "EditDraft": {
      if (state.kind !== "Ready") return still(state);
      return still({ ...state, draft: { ...state.draft, [command.field]: command.value }, notice: "" });
    }

    case "AddEntry": {
      // Two independent guards. The projection already disables the button
      // when the draft is invalid, but the engine re-checks: the projection is
      // a courtesy to the user, the transition rule is the actual guarantee.
      if (state.kind !== "Ready" || !isDraftValid(state.draft)) return still(state);
      return {
        state: { kind: "Submitting", entries: state.entries, draft: state.draft, correlationId: command.correlationId, pending: { kind: "AddEntry" } },
        effects: [addEffect(state.draft, command.correlationId)],
      };
    }

    case "MarkProcessed": {
      if (state.kind !== "Ready") return still(state);
      const entry = state.entries.find((candidate) => candidate.id === command.entryId);
      // Already-processed entries cannot be processed again, and an unknown id
      // is not actionable. Either way, no effect is issued.
      if (!entry || entry.status !== "Saved") return still(state);
      return {
        state: {
          kind: "Submitting",
          entries: state.entries,
          draft: state.draft,
          correlationId: command.correlationId,
          pending: { kind: "MarkProcessed", entryId: command.entryId },
        },
        effects: [processEffect(command.entryId, command.correlationId)],
      };
    }

    case "RecordResult": {
      if (state.kind === "Loading" || state.kind === "Refreshing") return recordLoad(state, command);
      if (state.kind === "Submitting" && state.correlationId === command.correlationId) return recordSubmit(state, command);
      // Stale or unexpected evidence. Discard rather than guess.
      return still(state);
    }
  }
}

function recordLoad(
  state: Extract<State, { kind: "Loading" | "Refreshing" }>,
  command: Extract<Command, { kind: "RecordResult" }>,
): TransitionResult {
  if (state.kind === "Refreshing" && state.correlationId !== command.correlationId) return still(state);
  const keptDraft = state.kind === "Refreshing" ? state.draft : emptyDraft;
  const keptNotice = state.kind === "Refreshing" ? state.notice : "";

  switch (command.outcome.kind) {
    case "Success": {
      if (command.outcome.status !== 200) return still(failOrKeep(state, `Server returned ${command.outcome.status}.`));
      const entries = decodeEntries(command.outcome.body);
      if (entries === null) return still(failOrKeep(state, "The server sent something unexpected."));
      return still({ kind: "Ready", entries, draft: keptDraft, notice: keptNotice });
    }
    case "Failure":
      return still(failOrKeep(state, command.outcome.reason === "network" ? "Could not reach the server." : "The response could not be read."));
    case "Cancelled":
      return still(failOrKeep(state, "The load was cancelled."));
    case "OutcomeUnknown":
      // A GET is idempotent, so an unknown outcome is just a failed load.
      return still(failOrKeep(state, "The load timed out. Try again."));
  }
}

// A failed *initial* load has nothing to show, so it becomes LoadFailed. A
// failed *refresh* still has the previous list, so it stays usable and only
// carries a notice. Same effect outcome, two different domain consequences.
function failOrKeep(state: Extract<State, { kind: "Loading" | "Refreshing" }>, reason: string): State {
  return state.kind === "Loading"
    ? { kind: "LoadFailed", reason }
    : { kind: "Ready", entries: state.entries, draft: state.draft, notice: reason };
}

function recordSubmit(
  state: Extract<State, { kind: "Submitting" }>,
  command: Extract<Command, { kind: "RecordResult" }>,
): TransitionResult {
  const ready = (notice: string): TransitionResult =>
    still({ kind: "Ready", entries: state.entries, draft: state.draft, notice });

  switch (command.outcome.kind) {
    case "Success": {
      if (command.outcome.status < 200 || command.outcome.status >= 300) {
        return ready(`The server rejected the change (${command.outcome.status}).`);
      }
      // Re-read rather than patching the local list from the response: the
      // server is authoritative for what was actually stored. The draft is
      // cleared only on a confirmed add.
      const refreshId = `${command.correlationId}-refresh` as CorrelationId;
      return {
        state: {
          kind: "Refreshing",
          entries: state.entries,
          draft: state.pending.kind === "AddEntry" ? emptyDraft : state.draft,
          correlationId: refreshId,
          notice: state.pending.kind === "AddEntry" ? "Entry added." : "Entry marked processed.",
        },
        effects: [loadEffect(refreshId)],
      };
    }
    case "Failure":
      return ready(command.outcome.reason === "network" ? "Could not reach the server. Nothing was changed." : "The response could not be read.");
    case "Cancelled":
      return ready("The change was cancelled.");
    case "OutcomeUnknown":
      // POST and PATCH are not safely repeatable here, so the honest report is
      // "we don't know" plus a refresh to find out — never a silent retry.
      return ready("The change timed out and may or may not have been applied. Refresh to check.");
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const entriesOf = (state: State): readonly Entry[] =>
  state.kind === "Loading" || state.kind === "LoadFailed" ? [] : state.entries;

const draftOf = (state: State): Draft =>
  state.kind === "Loading" || state.kind === "LoadFailed" ? emptyDraft : state.draft;

export function project(state: State): ViewState {
  const entries = entriesOf(state);
  const draft = draftOf(state);
  const busy = state.kind === "Submitting" || state.kind === "Refreshing" || state.kind === "Loading";
  const totalHours = entries.reduce((sum, entry) => sum + entry.hours, 0);

  return {
    loading: state.kind === "Loading",
    loadFailed: state.kind === "LoadFailed",
    loadError: state.kind === "LoadFailed" ? state.reason : "",
    notice: state.kind === "Ready" ? state.notice : state.kind === "Refreshing" ? state.notice : "",
    busy,
    refreshDisabled: busy,

    date: draft.date,
    hours: draft.hours,
    description: draft.description,
    // Errors are shown only for fields that have been filled in — an untouched
    // form should not be covered in red.
    dateError: draft.date === "" ? "" : dateError(draft.date),
    hoursError: draft.hours === "" ? "" : hoursError(draft.hours),
    descriptionError: draft.description === "" ? "" : descriptionError(draft.description),
    dateErrorVisible: draft.date !== "" && dateError(draft.date) !== "",
    hoursErrorVisible: draft.hours !== "" && hoursError(draft.hours) !== "",
    descriptionErrorVisible: draft.description !== "" && descriptionError(draft.description) !== "",
    addDisabled: state.kind !== "Ready" || !isDraftValid(draft),
    fieldsDisabled: state.kind !== "Ready",

    hasEntries: entries.length > 0,
    isEmpty: state.kind === "Ready" && entries.length === 0,
    totalHours,
    summary: `${entries.length} entr${entries.length === 1 ? "y" : "ies"}, ${totalHours} hour(s).`,

    // Per-row capability. The row's "Mark processed" button asks the engine
    // whether it is allowed; the DOM never infers it from the status text.
    entries: entries.map((entry) => ({
      id: entry.id,
      date: entry.date,
      hours: entry.hours,
      description: entry.description,
      status: entry.status,
      processed: entry.status === "Processed",
      processDisabled: entry.status !== "Saved" || state.kind !== "Ready",
    })),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createTimeEntriesTransport(): EngineTransport {
  let state = initialState;
  let sequence = 0;
  const nextCorrelationId = (): CorrelationId => `entries-${++sequence}` as CorrelationId;

  const respond = (result: TransitionResult): EngineToBrowserMessage => {
    state = result.state;
    return { view: project(state), effects: result.effects, cancellations: [] };
  };

  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      switch (message.kind) {
        case "Initialize":
          // Load immediately on startup: the initial projection and the first
          // effect go back in the same response.
          return respond(transition(state, { kind: "Load", correlationId: nextCorrelationId() }));
        case "Event":
          return respond(transition(state, eventToCommand(message.event, nextCorrelationId())));
        case "EffectResult": {
          if (message.result.kind !== "HttpResult") {
            throw new Error("This engine never requests a Storage effect.");
          }
          return respond(transition(state, {
            kind: "RecordResult",
            correlationId: message.result.correlationId,
            outcome: message.result.outcome,
          }));
        }
      }
    },
  };
}
