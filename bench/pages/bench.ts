// In-browser benchmark scenarios (kemiller2002/limen#19, LCP-004/LCP-033).
//
// Every scenario drives the real, unmodified BrowserKernel from dist/ against
// an in-page engine, and times from the DOM action to the MutationObserver
// callback that follows the kernel's synchronous projection — so a sample is
// "event → engine → projection applied", the cost a user sees. The mutation
// count that comes with each sample is the DOM work that projection did.
//
// A scenario may run through a JSON boundary (`?boundary=json`): every message
// is serialized, parsed and strictly decoded with the generated codec, exactly
// as the .NET and Rust WebAssembly transports do. The difference between the
// two runs is the cost of the boundary itself, independent of any one
// language's runtime.
//
// Measurement tooling, not product: nothing here is shipped or imported by Core.

import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { answerHandshake } from "../../dist/guest/handshake.js";
import { decodeEngineResponse } from "../../dist/hosts/dotnet-wasm-transport.js";
import { decodeEngineToBrowserMessage } from "../../dist/generated/core.codec.js";
import { CORE_CONTRACT_IDENTITY } from "../../dist/protocol.js";
import type { BrowserToEngineMessage, CorrelationId, EffectRequest, EngineToBrowserMessage, EngineTransport, ViewItem, ViewState } from "../../dist/protocol.js";
import { FEDERATION_PROTOCOL_VERSION, ModuleFederation } from "../../dist/federation.js";
import type { ContractId, FederatedModuleTransport, FederationCorrelationId, FederationEnvelope, ModuleId, ModuleManifest } from "../../dist/federation.js";

// ---------------------------------------------------------------------------
// Statistics and timing
// ---------------------------------------------------------------------------

export type Summary = { readonly n: number; readonly median: number; readonly p95: number; readonly min: number; readonly max: number };
type Sample = { readonly ms: number; readonly mutations: number };
type Result = Readonly<Record<string, Summary | number | string>>;

const round = (value: number): number => Math.round(value * 1000) / 1000;

const quantile = (sorted: readonly number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;

const summarize = (samples: readonly number[]): Summary => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, median: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), min: round(sorted[0] ?? Number.NaN), max: round(sorted.at(-1) ?? Number.NaN) };
};

const range = (count: number): readonly number[] => Array.from({ length: count }, (_, index) => index);

// Resolve at the first MutationObserver callback that touches the sentinel
// (a `data-text="rev"` element every response rewrites) and satisfies `done`.
// The kernel applies a projection synchronously, so that callback runs after
// the whole projection is in the DOM.
const measure = (stage: Element, sentinel: Element, act: () => void, done: () => boolean = () => true): Promise<Sample> =>
  new Promise((resolve) => {
    const counted = { mutations: 0 };
    const started = performance.now();
    const observer = new MutationObserver((records) => {
      counted.mutations += records.filter((record) => !sentinel.contains(record.target)).length;
      if (records.some((record) => sentinel.contains(record.target)) && done()) {
        observer.disconnect();
        resolve({ ms: performance.now() - started, mutations: counted.mutations });
      }
    });
    observer.observe(stage, { subtree: true, childList: true, characterData: true, attributes: true });
    act();
  });

// Run measurements one after another (each needs the previous projection).
const sequentially = async <T>(steps: readonly (() => Promise<T>)[]): Promise<readonly T[]> =>
  steps.reduce<Promise<readonly T[]>>(async (done, step) => [...(await done), await step()], Promise.resolve([]));

const timings = (samples: readonly Sample[]): Summary => summarize(samples.map((sample) => sample.ms));
const mutationsOf = (samples: readonly Sample[]): number => samples[0]?.mutations ?? Number.NaN;

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

type Step<S> = (state: S, message: BrowserToEngineMessage) => { readonly state: S; readonly effects?: readonly EffectRequest[] };

// A handshaking in-page engine. Its state is one cell owned by the closure —
// the transport interface is a mailbox, so something has to hold the current
// state between messages; every transition itself is the pure `step`.
const benchEngine = <S>(initial: S, step: Step<S>, view: (state: S) => ViewState): EngineTransport => {
  const cell = { state: initial, rev: 0 };
  return {
    start: async () => {},
    dispatch: async (message) => {
      const next = message.kind === "Initialize" ? { state: cell.state } : step(cell.state, message);
      cell.state = next.state;
      cell.rev += 1;
      const response: EngineToBrowserMessage = { view: { ...view(cell.state), rev: cell.rev }, effects: [...(next.effects ?? [])], cancellations: [] };
      return message.kind === "Initialize"
        ? { ...response, handshake: answerHandshake(message.handshake, { protocol: { major: 1, minor: 1 }, contract: { ...CORE_CONTRACT_IDENTITY }, required: [], optional: [] }) }
        : response;
    },
  };
};

// The WebAssembly boundary without a WebAssembly runtime: requests are
// serialized and parsed, responses serialized, parsed and strictly decoded.
const jsonBoundary = (inner: EngineTransport): EngineTransport => ({
  start: () => inner.start(),
  dispatch: async (message) => decodeEngineResponse(JSON.stringify(await inner.dispatch(JSON.parse(JSON.stringify(message)) as BrowserToEngineMessage)), "bench"),
});

const eventName = (message: BrowserToEngineMessage): string | undefined => (message.kind === "Event" ? message.event.name : undefined);
const eventValue = (message: BrowserToEngineMessage): string => (message.kind === "Event" ? message.event.value ?? "" : "");

type Boundary = "direct" | "json";

const startKernel = async (stage: Element, markup: string, transport: EngineTransport, boundary: Boundary): Promise<{ readonly startMs: number; readonly sentinel: Element }> => {
  stage.innerHTML = `${markup}<output id="rev" data-text="rev"></output>`;
  const started = performance.now();
  await new BrowserKernel(boundary === "json" ? jsonBoundary(transport) : transport, document, undefined, { requireHandshake: true }).start();
  const startMs = performance.now() - started;
  const sentinel = document.getElementById("rev");
  if (sentinel === null) throw new Error("sentinel missing");
  return { startMs, sentinel };
};

const button = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`#${id} missing`);
  return element;
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const counterMarkup = `<button id="inc" data-event="increment">+</button><span data-text="count"></span>`;
const counterEngine = (): EngineTransport =>
  benchEngine(0, (count, message) => ({ state: eventName(message) === "increment" ? count + 1 : count }), (count) => ({ count }));

const startup = async (stage: Element, boundary: Boundary): Promise<Result> => {
  const { startMs } = await startKernel(stage, counterMarkup, counterEngine(), boundary);
  // Navigation start → kernel running: module fetch, parse and the Initialize round trip.
  return { kernelStartMs: round(startMs), sinceNavigationMs: round(performance.now()) };
};

const eventRoundTrip = async (stage: Element, boundary: Boundary): Promise<Result> => {
  const { sentinel } = await startKernel(stage, counterMarkup, counterEngine(), boundary);
  const click = (): Promise<Sample> => measure(stage, sentinel, () => button("inc").click());
  await sequentially(range(20).map(() => click));
  const samples = await sequentially(range(300).map(() => click));
  return { eventRoundTripMs: timings(samples), mutationsPerEvent: mutationsOf(samples) };
};

const FIELDS = 100;
const formsMarkup = [
  `<button id="fill" data-event="fill-all">fill</button><button id="noop" data-event="noop">noop</button>`,
  ...range(FIELDS).map((field) => `<label><input id="f${field}" data-event="f${field}" data-bind-value="f${field}"><small data-text="f${field}note"></small></label>`),
].join("");

const formsEngine = (): EngineTransport =>
  benchEngine<readonly string[]>(range(FIELDS).map(() => ""), (values, message) => {
    const name = eventName(message);
    if (name === "fill-all") return { state: values.map((_, field) => `filled-${field}-${Math.random().toString(36).slice(2, 8)}`) };
    const field = name?.startsWith("f") ? Number(name.slice(1)) : Number.NaN;
    return { state: Number.isInteger(field) ? values.map((value, index) => (index === field ? eventValue(message) : value)) : values };
  }, (values) => Object.fromEntries(values.flatMap((value, field) => [[`f${field}`, value], [`f${field}note`, value.length > 0 ? "ok" : "required"]])));

const forms100 = async (stage: Element, boundary: Boundary): Promise<Result> => {
  const { sentinel } = await startKernel(stage, formsMarkup, formsEngine(), boundary);
  const change = (field: number, round: number) => (): Promise<Sample> => measure(stage, sentinel, () => {
    const input = button(`f${field}`);
    if (input instanceof HTMLInputElement) input.value = `typed-${round}-${field}`;
    input.dispatchEvent(new Event("change"));
  });
  await sequentially(range(20).map((field) => change(field, 0)));
  const single = await sequentially(range(FIELDS).map((field) => change(field, 1)));
  const fill = await sequentially(range(30).map(() => () => measure(stage, sentinel, () => button("fill").click())));
  const unchanged = await sequentially(range(30).map(() => () => measure(stage, sentinel, () => button("noop").click())));
  return {
    oneFieldChangeMs: timings(single),
    mutationsPerOneFieldChange: mutationsOf(single),
    allFieldsChangeMs: timings(fill),
    mutationsPerAllFieldsChange: mutationsOf(fill),
    unchangedProjectionMs: timings(unchanged),
    mutationsPerUnchangedProjection: mutationsOf(unchanged),
  };
};

type Row = { readonly id: number; readonly label: string };
type ListState = { readonly rows: readonly Row[]; readonly nextId: number };

const LIST_OPERATIONS = ["noop", "update", "insert", "remove", "append", "trim", "reverse"] as const;
type ListOperation = (typeof LIST_OPERATIONS)[number];

const middle = (rows: readonly Row[]): number => Math.floor(rows.length / 2);

const listStep = (size: number) => (state: ListState, message: BrowserToEngineMessage): { readonly state: ListState } => {
  const name = eventName(message);
  const rows = state.rows;
  const fresh = (id: number): Row => ({ id, label: `row ${id}` });
  switch (name) {
    case "load": return { state: { rows: range(size).map(fresh), nextId: size } };
    case "update": return { state: { ...state, rows: rows.map((row, index) => (index === middle(rows) ? { ...row, label: `${row.label}!` } : row)) } };
    case "insert": return { state: { rows: [...rows.slice(0, middle(rows)), fresh(state.nextId), ...rows.slice(middle(rows))], nextId: state.nextId + 1 } };
    case "remove": return { state: { ...state, rows: rows.filter((_, index) => index !== middle(rows)) } };
    case "append": return { state: { rows: [...rows, fresh(state.nextId)], nextId: state.nextId + 1 } };
    case "trim": return { state: { ...state, rows: rows.slice(0, -1) } };
    case "reverse": return { state: { ...state, rows: [...rows].reverse() } };
    default: return { state };
  }
};

const listMarkup = [
  `<button id="load" data-event="load">load</button>`,
  ...LIST_OPERATIONS.map((operation) => `<button id="${operation}" data-event="${operation}">${operation}</button>`),
  `<ul><template data-each="rows" data-key="id"><li><span data-text="label"></span></li></template></ul>`,
].join("");

const listScenario = (size: number, repetitions: number) => async (stage: Element, boundary: Boundary): Promise<Result> => {
  const engine = benchEngine<ListState>({ rows: [], nextId: 0 }, listStep(size), (state) => ({ rows: state.rows.map((row): ViewItem => ({ id: row.id, label: row.label })) }));
  const { sentinel } = await startKernel(stage, listMarkup, engine, boundary);
  const click = (id: string) => (): Promise<Sample> => measure(stage, sentinel, () => button(id).click());
  const initial = await click("load")();
  const rounds = await sequentially(range(repetitions).map(() => async () => sequentially(LIST_OPERATIONS.map((operation) => click(operation)))));
  const byOperation = (operation: ListOperation): readonly Sample[] => rounds.map((samples) => samples[LIST_OPERATIONS.indexOf(operation)]).filter((sample): sample is Sample => sample !== undefined);
  return Object.fromEntries([
    ["initialRenderMs", round(initial.ms)],
    ["initialRenderMutations", initial.mutations],
    ...LIST_OPERATIONS.flatMap((operation) => [[`${operation}Ms`, timings(byOperation(operation))], [`${operation}Mutations`, mutationsOf(byOperation(operation))]]),
  ]);
};

const ROUTES = 100;
type RouteState = { readonly round: number; readonly count: number };

const routes = async (stage: Element, boundary: Boundary): Promise<Result> => {
  const push = (round: number, count: number): EffectRequest => ({ kind: "Navigation", correlationId: `nav-${round}-${count}` as CorrelationId, operation: "push", url: `?route=${round}-${count}` });
  const engine = benchEngine<RouteState>({ round: 0, count: 0 }, (state, message) => {
    if (eventName(message) === "go") return { state: { round: state.round + 1, count: 0 }, effects: [push(state.round + 1, 0)] };
    if (message.kind === "EffectResult" && message.result.kind === "NavigationResult") {
      const count = state.count + 1;
      return { state: { ...state, count }, effects: count < ROUTES ? [push(state.round, count)] : [] };
    }
    return { state };
  }, (state) => ({ count: state.count }));
  const { sentinel } = await startKernel(stage, `<button id="go" data-event="go">go</button><span id="count" data-text="count"></span>`, engine, boundary);
  const run = (): Promise<Sample> => measure(stage, sentinel, () => button("go").click(), () => button("count").textContent === String(ROUTES));
  await run();
  const samples = await sequentially(range(5).map(() => run));
  return { routes: ROUTES, hundredRouteChangesMs: timings(samples), perRouteChangeMs: round((timings(samples).median) / ROUTES) };
};

const serialization = async (): Promise<Result> => {
  const message = (size: number): EngineToBrowserMessage => ({ view: { rev: 1, rows: range(size).map((id): ViewItem => ({ id, label: `row ${id}`, done: id % 2 === 0 })) }, effects: [], cancellations: [] });
  const time = (work: () => unknown): number => { const started = performance.now(); work(); return performance.now() - started; };
  const measureSize = (size: number): readonly (readonly [string, Summary | number])[] => {
    const value = message(size);
    const json = JSON.stringify(value);
    const parsed: unknown = JSON.parse(json);
    const repeat = (work: () => unknown): Summary => summarize(range(25).map(() => time(work)));
    return [
      [`view${size}Bytes`, json.length],
      [`view${size}StringifyMs`, repeat(() => JSON.stringify(value))],
      [`view${size}ParseMs`, repeat(() => JSON.parse(json))],
      [`view${size}DecodeMs`, repeat(() => decodeEngineToBrowserMessage(parsed))],
    ];
  };
  return Object.fromEntries([1000, 10000].flatMap(measureSize));
};

const federation = async (): Promise<Result> => {
  const contract = "bench.ping" as ContractId;
  const pong = "bench.pong" as ContractId;
  const moduleOf = (id: ModuleId, accepts: ContractId, emits: ContractId, reply: (envelope: FederationEnvelope) => readonly FederationEnvelope[]): FederatedModuleTransport => {
    const manifest: ModuleManifest = {
      id, version: "1.0.0", federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
      accepts: [{ contract: accepts, minVersion: 1, maxVersion: 1 }], emits: [{ contract: emits, minVersion: 1, maxVersion: 1 }],
      capabilitiesRequired: [], dependencies: [], routes: [],
    };
    return {
      manifest,
      load: async () => {}, initialize: async () => {}, restore: async () => {}, activate: async () => {},
      dispatch: async (envelope) => ({ emitted: reply(envelope) }),
      suspend: async () => {}, snapshot: async () => null, unload: async () => {},
    };
  };
  const a = "bench-a" as ModuleId;
  const b = "bench-b" as ModuleId;
  const envelope = (source: ModuleId, target: ModuleId, kind: FederationEnvelope["kind"], of: ContractId, correlationId: FederationCorrelationId): FederationEnvelope =>
    ({ protocolVersion: FEDERATION_PROTOCOL_VERSION, source, target, correlationId, kind, contract: of, contractVersion: 1, capabilities: [], evidence: [], payload: { value: "ping" } });
  const federated = new ModuleFederation([
    moduleOf(a, pong, contract, () => []),
    moduleOf(b, contract, pong, (request) => [{ ...envelope(b, a, "TransitionAccepted", pong, request.correlationId), causationId: request.correlationId }]),
  ]);
  await federated.startAll();
  const exchange = (index: number) => async (): Promise<number> => {
    const started = performance.now();
    await federated.exchange(envelope(a, b, "TransitionRequest", contract, `bench-${index}` as FederationCorrelationId));
    return performance.now() - started;
  };
  await sequentially(range(50).map((index) => exchange(index)));
  return { requestReplyExchangeMs: summarize(await sequentially(range(500).map((index) => exchange(50 + index)))) };
};

const SCENARIOS: Readonly<Record<string, (stage: Element, boundary: Boundary) => Promise<Result>>> = {
  "startup": startup,
  "event": eventRoundTrip,
  "forms-100": forms100,
  "list-1k": listScenario(1000, 10),
  "list-10k": listScenario(10000, 5),
  "routes": routes,
  "serialization": () => serialization(),
  "federation": () => federation(),
};

const stage = document.getElementById("stage");
const parameters = new URLSearchParams(window.location.search);
const scenario = parameters.get("scenario") ?? "";
const boundary: Boundary = parameters.get("boundary") === "json" ? "json" : "direct";

// scripts/bench.ts reads window.limenBench: { scenarios } always, and
// { result } or { error } once the scenario named in ?scenario= settles.
Reflect.set(window, "limenBench", { scenarios: Object.keys(SCENARIOS) });
const run = SCENARIOS[scenario];
if (stage !== null && run !== undefined) {
  run(stage, boundary).then(
    (measured) => {
      // Without cross-origin isolation Chromium coarsens timers to 100µs.
      const result = { ...measured, crossOriginIsolated: String(window.crossOriginIsolated) }; Reflect.set(window, "limenBench", { scenarios: Object.keys(SCENARIOS), result }); },
    (error: unknown) => { Reflect.set(window, "limenBench", { scenarios: Object.keys(SCENARIOS), error: String(error) }); },
  );
}
