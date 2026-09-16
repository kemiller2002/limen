// The Limen application that runs this website's interactive sections.
//
// This is the site's engine. It owns every piece of application state the
// site has, decides every transition, and projects a flat ViewState. It has
// no access to the DOM, to fetch, or to storage — its only imports from the
// kernel are *types*, so this file has no runtime dependency on Limen at all.
//
// The same engine drives more than one page. The home page binds a handful of
// its projected keys; the demos page binds all of them. Nothing changes in the
// engine — a view is just a projection, and different pages may project less.
import type {
  BrowserToEngineMessage,
  CorrelationId,
  EffectOutcome,
  EffectRequest,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  ViewItem,
  ViewState,
} from "../../dist/protocol.js";

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

/** Demo 3's five outcome scenarios, each a genuinely different real request. */
export type Scenario = "success" | "notFound" | "invalid" | "network" | "timeout";

export type LoadState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Loading"; readonly correlationId: CorrelationId; readonly scenario: Scenario }
  | { readonly kind: "Loaded"; readonly count: number }
  | { readonly kind: "Rejected"; readonly reason: string; readonly retryable: boolean }
  | { readonly kind: "OutcomeUnknown" };

/** Demo 2's explicit model — the one that cannot represent nonsense. */
export type SaveState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Editing" }
  | { readonly kind: "Saving" }
  | { readonly kind: "Saved" }
  | { readonly kind: "SaveFailed"; readonly reason: string };

/** Demo 2's straw man — four independent booleans, 16 combinations. */
export type Flags = {
  readonly isLoading: boolean;
  readonly isSaving: boolean;
  readonly hasError: boolean;
  readonly isComplete: boolean;
};

export type Placement = "html" | "css" | "kernel" | "engine" | "effect";

export type PlacementTask = {
  readonly prompt: string;
  readonly answer: Placement;
  readonly because: string;
};

export type TraceEntry = {
  readonly id: string;
  readonly event: string;
  readonly command: string;
  readonly from: string;
  readonly to: string;
  readonly effect: string;
};

export type State = {
  readonly counter: number;
  readonly save: SaveState;
  readonly load: LoadState;
  readonly flags: Flags;
  readonly taskIndex: number;
  readonly picked: Placement | null;
  readonly answered: number;
  readonly correct: number;
  readonly trace: readonly TraceEntry[];
  readonly sequence: number;
};

export const PLACEMENT_TASKS: readonly PlacementTask[] = [
  { prompt: "Decide whether an invoice may be submitted", answer: "engine", because: "A legality rule is application meaning. It belongs in a transition, not in a disabled attribute." },
  { prompt: "Change the spacing above a button", answer: "css", because: "Pure presentation. It never crosses the boundary — no projection, no round trip." },
  { prompt: "Read a saved draft from localStorage", answer: "effect", because: "The engine cannot touch storage. It requests a Storage effect; the kernel performs it." },
  { prompt: "Add a heading and a labelled input", answer: "html", because: "Document structure. Add data-* bindings only where the engine must drive it." },
  { prompt: "Remember that a save is in flight", answer: "engine", because: "Anything the application would behave differently because of is authoritative state." },
  { prompt: "POST the form to the server", answer: "effect", because: "The engine returns an EffectRequest. It never calls fetch itself." },
  { prompt: "Turn a click into an application event", answer: "kernel", because: "Carrying a DOM event across the boundary is exactly the kernel's job — and all it does." },
  { prompt: "Work out whether Save should be available", answer: "engine", because: "A capability is projected by the engine, never re-derived by the DOM or by CSS." },
];

export const initialState: State = {
  counter: 0,
  save: { kind: "Idle" },
  load: { kind: "Idle" },
  flags: { isLoading: false, isSaving: false, hasError: false, isComplete: false },
  taskIndex: 0,
  picked: null,
  answered: 0,
  correct: 0,
  trace: [],
  sequence: 0,
};

// ---------------------------------------------------------------------------
// Commands — the closed vocabulary
// ---------------------------------------------------------------------------

export type Command =
  | { readonly kind: "Increment" }
  | { readonly kind: "Decrement" }
  | { readonly kind: "ResetCounter" }
  | { readonly kind: "ClearTrace" }
  | { readonly kind: "ToggleFlag"; readonly flag: keyof Flags }
  | { readonly kind: "AdvanceSave" }
  | { readonly kind: "FailSave" }
  | { readonly kind: "ResetSave" }
  | { readonly kind: "Load"; readonly scenario: Scenario; readonly correlationId: CorrelationId }
  | { readonly kind: "RecordLoad"; readonly correlationId: CorrelationId; readonly outcome: EffectOutcome }
  | { readonly kind: "Pick"; readonly choice: Placement }
  | { readonly kind: "NextTask" };

const FLAGS: Readonly<Record<string, keyof Flags>> = {
  toggleLoading: "isLoading",
  toggleSaving: "isSaving",
  toggleError: "hasError",
  toggleComplete: "isComplete",
};

const SCENARIOS: Readonly<Record<string, Scenario>> = {
  loadSuccess: "success",
  loadNotFound: "notFound",
  loadInvalid: "invalid",
  loadNetwork: "network",
  loadTimeout: "timeout",
};

const PLACEMENTS = ["html", "css", "kernel", "engine", "effect"] as const;
const isPlacement = (value: string): value is Placement => (PLACEMENTS as readonly string[]).includes(value);

export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  const flag = FLAGS[event.name];
  if (flag) return { kind: "ToggleFlag", flag };

  const scenario = SCENARIOS[event.name];
  if (scenario) return { kind: "Load", scenario, correlationId };

  switch (event.name) {
    case "increment": return { kind: "Increment" };
    case "decrement": return { kind: "Decrement" };
    case "resetCounter": return { kind: "ResetCounter" };
    case "clearTrace": return { kind: "ClearTrace" };
    case "advanceSave": return { kind: "AdvanceSave" };
    case "failSave": return { kind: "FailSave" };
    case "resetSave": return { kind: "ResetSave" };
    case "nextTask": return { kind: "NextTask" };
    case "pick": {
      // The choice arrives as a data-each item key — a string from the DOM,
      // so it is validated here rather than trusted.
      const choice = event.key ?? "";
      if (!isPlacement(choice)) throw new Error(`Unknown placement: ${choice}`);
      return { kind: "Pick", choice };
    }
    default:
      throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

// Five real requests. None of these are faked or intercepted: the kernel runs
// fetch() against each URL and classifies whatever actually comes back, which
// is the only way a demo of outcome classification is worth anything.
const SCENARIO_REQUEST: Readonly<Record<Scenario, { url: string; timeoutMs: number }>> = {
  success: { url: "./demo/customers.json", timeoutMs: 5000 },
  notFound: { url: "./demo/no-such-file.json", timeoutMs: 5000 },
  invalid: { url: "./demo/not-json.txt", timeoutMs: 5000 },
  network: { url: "https://limen-demo-unreachable.invalid/customers.json", timeoutMs: 5000 },
  // A 1 ms budget against a real file: the request is dispatched and then
  // aborted, which is precisely the situation OutcomeUnknown exists for.
  timeout: { url: "./demo/customers.json", timeoutMs: 1 },
};

const loadEffect = (scenario: Scenario, correlationId: CorrelationId): EffectRequest => ({
  kind: "Http",
  correlationId,
  method: "GET",
  url: SCENARIO_REQUEST[scenario].url,
  timeoutMs: SCENARIO_REQUEST[scenario].timeoutMs,
});

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export type TransitionResult = {
  readonly state: State;
  readonly effects: readonly EffectRequest[];
  /** What to write into the visible trace. Empty when nothing happened. */
  readonly step: { readonly command: string; readonly from: string; readonly to: string; readonly effect: string } | null;
};

const decodeCount = (body: unknown): number | null =>
  Array.isArray(body) ? body.length : null;

export function transition(state: State, command: Command): TransitionResult {
  const step = (next: State, effect = "—"): TransitionResult => ({
    state: next,
    effects: [],
    step: { command: command.kind, from: describe(state), to: describe(next), effect },
  });

  switch (command.kind) {
    case "Increment": return step({ ...state, counter: state.counter + 1 });
    case "Decrement": return step({ ...state, counter: Math.max(0, state.counter - 1) });
    case "ResetCounter": return step({ ...state, counter: 0 });

    case "ClearTrace":
      return { state: { ...state, trace: [] }, effects: [], step: null };

    case "ToggleFlag": {
      const flags = { ...state.flags, [command.flag]: !state.flags[command.flag] };
      return step({ ...state, flags });
    }

    case "AdvanceSave": {
      // The legal path, and only the legal path. There is no arrangement of
      // these commands that reaches two of these states at once.
      const next: SaveState =
        state.save.kind === "Idle" ? { kind: "Editing" }
        : state.save.kind === "Editing" ? { kind: "Saving" }
        : state.save.kind === "Saving" ? { kind: "Saved" }
        : state.save;
      if (next === state.save) return { state, effects: [], step: null };
      return step({ ...state, save: next });
    }
    case "FailSave": {
      if (state.save.kind !== "Saving") return { state, effects: [], step: null };
      return step({ ...state, save: { kind: "SaveFailed", reason: "The server rejected the change." } });
    }
    case "ResetSave": return step({ ...state, save: { kind: "Idle" } });

    case "Load": {
      if (state.load.kind === "Loading") return { state, effects: [], step: null };
      const next: State = { ...state, load: { kind: "Loading", correlationId: command.correlationId, scenario: command.scenario } };
      return {
        state: next,
        effects: [loadEffect(command.scenario, command.correlationId)],
        step: { command: `Load(${command.scenario})`, from: describe(state), to: describe(next), effect: `Http GET ${SCENARIO_REQUEST[command.scenario].url}` },
      };
    }

    case "RecordLoad": {
      // Stale-evidence guard: a result for a request we are no longer waiting
      // on is discarded rather than allowed to overwrite newer state.
      if (state.load.kind !== "Loading" || state.load.correlationId !== command.correlationId) {
        return { state, effects: [], step: null };
      }
      const next: State = { ...state, load: recordLoad(command.outcome) };
      return {
        state: next,
        effects: [],
        step: { command: "RecordLoad", from: describe(state), to: describe(next), effect: `← ${outcomeLabel(command.outcome)}` },
      };
    }

    case "Pick": {
      if (state.picked !== null) return { state, effects: [], step: null };
      const task = PLACEMENT_TASKS[state.taskIndex];
      if (!task) return { state, effects: [], step: null };
      const right = command.choice === task.answer;
      return step({
        ...state,
        picked: command.choice,
        answered: state.answered + 1,
        correct: state.correct + (right ? 1 : 0),
      });
    }
    case "NextTask": {
      if (state.picked === null) return { state, effects: [], step: null };
      return step({
        ...state,
        taskIndex: (state.taskIndex + 1) % PLACEMENT_TASKS.length,
        picked: null,
      });
    }
  }
}

function recordLoad(outcome: EffectOutcome): LoadState {
  switch (outcome.kind) {
    case "Success": {
      // A 404 arrives here too — the kernel got a response, so it is a
      // transport-level Success. Deciding what the status *means* is the
      // engine's job, and this is where that happens.
      if (outcome.status !== 200) {
        return { kind: "Rejected", reason: `The server answered ${outcome.status}.`, retryable: outcome.status >= 500 };
      }
      const count = decodeCount(outcome.body);
      return count === null
        ? { kind: "Rejected", reason: "The response parsed, but was not the shape expected.", retryable: false }
        : { kind: "Loaded", count };
    }
    case "Failure": {
      if (outcome.reason === "network") {
        return { kind: "Rejected", reason: "Could not reach the server.", retryable: true };
      }
      // A response arrived but would not decode. The status distinguishes the
      // two cases that matter: the server refusing (its error page is rarely
      // JSON), versus a 200 whose body is malformed. Only the first is worth
      // retrying, and only the status tells them apart.
      if (outcome.status !== undefined && outcome.status !== 200) {
        return {
          kind: "Rejected",
          reason: `The server answered ${outcome.status}, and its error body was not JSON.`,
          retryable: outcome.status >= 500,
        };
      }
      return { kind: "Rejected", reason: "The response could not be read as JSON.", retryable: false };
    }
    case "Cancelled":
      return { kind: "Idle" };
    case "OutcomeUnknown":
      return { kind: "OutcomeUnknown" };
  }
}

const outcomeLabel = (outcome: EffectOutcome): string =>
  outcome.kind === "Success" ? `Success ${outcome.status}`
  : outcome.kind === "Failure" ? `Failure (${outcome.reason})`
  : outcome.kind === "OutcomeUnknown" ? "OutcomeUnknown (timeout-after-dispatch)"
  : "Cancelled";

/** A compact label for the trace's from/to columns. */
const describe = (state: State): string =>
  `counter=${state.counter} save=${state.save.kind} load=${state.load.kind}`;

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const FLAG_VERDICT = (flags: Flags): { text: string; tone: string } => {
  const on = [flags.isLoading && "isLoading", flags.isSaving && "isSaving", flags.hasError && "hasError", flags.isComplete && "isComplete"].filter(Boolean) as string[];
  if (on.length === 0) return { text: "Nothing set. Which is also a state nobody named — is that Idle, or not started?", tone: "warn" };
  if (on.length === 1) return { text: `Only ${on[0]} is set. This one happens to be coherent.`, tone: "ok" };
  return { text: `${on.join(" + ")} are all true at once. Nothing prevents this, and every reader must now decide what it means.`, tone: "bad" };
};

const SAVE_TONE: Readonly<Record<SaveState["kind"], string>> = {
  Idle: "warn", Editing: "warn", Saving: "warn", Saved: "ok", SaveFailed: "bad",
};

const LOAD_TONE: Readonly<Record<LoadState["kind"], string>> = {
  Idle: "warn", Loading: "warn", Loaded: "ok", Rejected: "bad", OutcomeUnknown: "bad",
};

export function project(state: State): ViewState {
  const verdict = FLAG_VERDICT(state.flags);
  const task = PLACEMENT_TASKS[state.taskIndex];
  const revealed = state.picked !== null;
  const right = revealed && task !== undefined && state.picked === task.answer;

  return {
    // Demo 1 — counter and the live trace.
    counter: state.counter,
    decrementDisabled: state.counter === 0,
    resetDisabled: state.counter === 0,
    trace: state.trace.map((entry) => ({ ...entry } as ViewItem)),
    hasTrace: state.trace.length > 0,
    traceEmpty: state.trace.length === 0,
    traceCount: state.trace.length,

    // Demo 2 — booleans versus an explicit union.
    isLoading: state.flags.isLoading,
    isSaving: state.flags.isSaving,
    hasError: state.flags.hasError,
    isComplete: state.flags.isComplete,
    flagVerdict: verdict.text,
    flagTone: verdict.tone,
    saveState: state.save.kind,
    saveTone: SAVE_TONE[state.save.kind],
    saveHint: saveHint(state.save),
    advanceDisabled: state.save.kind === "Saved" || state.save.kind === "SaveFailed",
    failDisabled: state.save.kind !== "Saving",

    // Demo 3 — effects, and all four outcomes.
    loadState: state.load.kind,
    loadTone: LOAD_TONE[state.load.kind],
    loadMessage: loadMessage(state.load),
    loadBusy: state.load.kind === "Loading",
    canRetryLoad: state.load.kind === "Rejected" && state.load.retryable,
    needsReconciliation: state.load.kind === "OutcomeUnknown",

    // Demo 4 — where does this code go?
    taskPrompt: task?.prompt ?? "",
    taskNumber: state.taskIndex + 1,
    taskTotal: PLACEMENT_TASKS.length,
    choices: PLACEMENTS.map((id) => ({
      id,
      label: CHOICE_LABEL[id],
      // The engine says which button reads as pressed. The DOM does not track it.
      pressed: state.picked === id,
    } as ViewItem)),
    revealed,
    verdictText: !revealed || task === undefined ? "" : right ? `Correct — ${task.because}` : `Not quite. ${CHOICE_LABEL[task.answer]} — ${task.because}`,
    verdictTone: !revealed ? "warn" : right ? "ok" : "bad",
    scoreText: `${state.correct} of ${state.answered} so far`,
    nextDisabled: !revealed,
  };
}

const CHOICE_LABEL: Readonly<Record<Placement, string>> = {
  html: "HTML",
  css: "CSS",
  kernel: "Limen kernel",
  engine: "Engine",
  effect: "Effect request",
};

const saveHint = (save: SaveState): string => {
  switch (save.kind) {
    case "Idle": return "Nothing started. Advance to begin editing.";
    case "Editing": return "Editing. The only legal next step is Saving.";
    case "Saving": return "In flight. It can succeed or fail — not both.";
    case "Saved": return "Done. There is no way to also be failed.";
    case "SaveFailed": return save.reason;
  }
};

const loadMessage = (load: LoadState): string => {
  switch (load.kind) {
    case "Idle": return "Nothing requested yet. Pick a scenario.";
    case "Loading": return `Requesting the ${load.scenario} scenario…`;
    case "Loaded": return `Loaded ${load.count} record(s).`;
    case "Rejected": return load.reason;
    case "OutcomeUnknown": return "Timed out after dispatch. The request may or may not have reached the server — which is why this is not reported as a failure.";
  }
};

// ---------------------------------------------------------------------------
// Transport — the one mutable cell
// ---------------------------------------------------------------------------

const TRACE_LIMIT = 40;

export function createSiteTransport(): EngineTransport {
  let state = initialState;
  let sequence = 0;
  const nextCorrelationId = (): CorrelationId => `load-${++sequence}` as CorrelationId;

  const apply = (result: TransitionResult, eventLabel: string): EngineToBrowserMessage => {
    state = result.step === null
      ? result.state
      : {
        ...result.state,
        sequence: result.state.sequence + 1,
        // Newest first, bounded. The trace is projected state like anything
        // else — the kernel is not keeping a log, the engine is.
        trace: [
          {
            id: String(result.state.sequence + 1),
            event: eventLabel,
            command: result.step.command,
            from: result.step.from,
            to: result.step.to,
            effect: result.step.effect,
          },
          ...result.state.trace,
        ].slice(0, TRACE_LIMIT),
      };
    return { view: project(state), effects: result.effects, cancellations: [] };
  };

  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      switch (message.kind) {
        case "Initialize":
          return { view: project(state), effects: [], cancellations: [] };
        case "Event": {
          const label = message.event.key === undefined ? message.event.name : `${message.event.name}(${message.event.key})`;
          return apply(transition(state, eventToCommand(message.event, nextCorrelationId())), label);
        }
        case "EffectResult": {
          if (message.result.kind !== "HttpResult") {
            throw new Error("This engine never requests a Storage effect.");
          }
          return apply(
            transition(state, { kind: "RecordLoad", correlationId: message.result.correlationId, outcome: message.result.outcome }),
            "EffectResult",
          );
        }
      }
    },
  };
}
