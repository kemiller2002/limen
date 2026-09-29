// The measurement and observer capability pack (kemiller2002/limen#25,
// LCP-014) through the real kernel. jsdom has neither ResizeObserver nor
// IntersectionObserver, which is itself the Unsupported case; subscription
// lifecycle is driven here through scripted observers installed on the jsdom
// window, and the real observers are proven in Chromium in
// test/browser/packs/measure/.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { MEASURE_CAPABILITY, decodeMeasureFact, decodeMeasureResult, measureCapability, type MeasureFact, type MeasureRequest, type MeasureResult } from "../dist/capabilities/measure/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EffectRequest, type EngineTransport, type ViewState } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const offer = { id: MEASURE_CAPABILITY.id as CapabilityId, version: MEASURE_CAPABILITY.version, fingerprint: MEASURE_CAPABILITY.fingerprint };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// Scripted observers: record what they observe, fire when the test says so.
type Callback = (entries: readonly unknown[]) => void;
const observers: { readonly kind: string; readonly callback: Callback; readonly targets: Element[]; disconnected: boolean }[] = [];
const scripted = (kind: string) => class {
  readonly #record: (typeof observers)[number];
  constructor(callback: Callback) {
    this.#record = { kind, callback, targets: [], disconnected: false };
    observers.push(this.#record);
  }
  observe(target: Element): void { this.#record.targets.push(target); }
  disconnect(): void { this.#record.disconnected = true; }
};
const install = (document: Document): void => {
  const view = document.defaultView;
  assert.ok(view !== null);
  Reflect.set(view, "ResizeObserver", scripted("resize"));
  Reflect.set(view, "IntersectionObserver", scripted("intersection"));
};

type Step = { readonly view: ViewState; readonly requests?: readonly MeasureRequest[] };
type Heard = { readonly results: MeasureResult[]; readonly facts: MeasureFact[] };

const engine = (steps: readonly Step[]): { readonly transport: EngineTransport; readonly heard: Heard } => {
  const heard: Heard = { results: [], facts: [] };
  const cursor = { step: 0, effect: 0 };
  const current = (): ViewState => steps[Math.max(0, cursor.step - 1)]?.view ?? {};
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "EffectResult" && message.result.kind === "CapabilityResult" && message.result.outcome.kind === "Completed") {
        const decoded = decodeMeasureResult(message.result.outcome.result);
        if (decoded.ok) heard.results.push(decoded.value);
        return { view: current(), effects: [], cancellations: [] };
      }
      if (message.kind === "CapabilityFact") {
        const decoded = decodeMeasureFact(message.fact);
        assert.ok(decoded.ok, "every fact decodes with the pack's generated decoder");
        heard.facts.push(decoded.value);
        return { view: current(), effects: [], cancellations: [] };
      }
      const step = steps[cursor.step] ?? { view: current() };
      cursor.step += 1;
      const effects = (step.requests ?? []).map((request): EffectRequest => {
        cursor.effect += 1;
        return { kind: "Capability", correlationId: `m${cursor.effect}` as CorrelationId, capability: offer.id, version: 1, request };
      });
      const response = { view: step.view, effects, cancellations: [] };
      return message.kind === "Initialize"
        ? { ...response, handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } }
        : response;
    },
  };
  return { transport, heard };
};

const PAGE = `
  <main data-measure-target="main"><p>content</p></main>
  <ul><template data-each="rows" data-key="id"><li data-bind-data-measure-key="id" data-measure-target="row" data-text="id"></li></template></ul>
  <button id="next" data-event="next">next</button>`;

const drive = async (steps: readonly Step[], act: (document: Document) => Promise<void>, installObservers = true): Promise<Heard> => {
  observers.length = 0;
  const { transport, heard } = engine(steps);
  // Snapshot what the engine heard when the scenario ends: tearing the jsdom
  // window down removes every node, which (correctly) ends every subscription.
  return withDom(PAGE, async (document) => {
    if (installObservers) install(document);
    await new BrowserKernel(transport, document, undefined, { capabilities: [measureCapability()], requireHandshake: true }).start();
    await sleep(0);
    await act(document);
    return { results: [...heard.results], facts: [...heard.facts] };
  });
};

const click = async (document: Document): Promise<void> => {
  document.getElementById("next")?.click();
  await sleep(0);
  await sleep(0);
};

const rows = (ids: readonly string[]) => ({ rows: ids.map((id) => ({ id })) });

test("measure and viewport answer with plain JSON rectangles and scroll facts", async () => {
  const heard = await drive([{ view: rows(["a"]), requests: [{ operation: "measure", target: { name: "main" } }, { operation: "viewport" }, { operation: "measure", target: { name: "row", key: "a" } }] }], async () => {});
  assert.deepEqual(heard.results.map((result) => result.kind), ["Measured", "ViewportMeasured", "Measured"]);
  for (const result of heard.results) assert.deepEqual(JSON.parse(JSON.stringify(result)), result, "serializes unchanged");
});

test("a resize subscription forwards Resized facts under its id until unsubscribed", async () => {
  const heard = await drive([
    { view: rows([]), requests: [{ operation: "observeSize", target: { name: "main" } }] },
  ], async () => {
    const observer = observers.find((o) => o.kind === "resize");
    assert.ok(observer !== undefined && observer.targets.length === 1);
    observer.callback([{ contentRect: { width: 100, height: 40 } }, { contentRect: { width: 120, height: 40 } }]);
    await sleep(0);
  });
  const [subscribed] = heard.results;
  assert.ok(subscribed?.kind === "Subscribed");
  assert.deepEqual(heard.facts, [{ kind: "Resized", subscription: subscribed.subscription, width: 120, height: 40 }], "the latest entry per callback");
});

test("intersection enter and leave arrive as Visibility facts", async () => {
  const heard = await drive([{ view: rows([]), requests: [{ operation: "observeVisibility", target: { name: "main" }, threshold: 0.5 }] }], async () => {
    const observer = observers.find((o) => o.kind === "intersection");
    assert.ok(observer !== undefined);
    observer.callback([{ isIntersecting: true, intersectionRatio: 0.75 }]);
    observer.callback([{ isIntersecting: false, intersectionRatio: 0 }]);
    await sleep(0);
  });
  assert.deepEqual(heard.facts.map((fact) => fact.kind === "Visibility" ? [fact.intersecting, fact.ratio] : fact.kind), [[true, 0.75], [false, 0]]);
});

test("a removed target ends its subscription deterministically: one TargetRemoved, then nothing", async () => {
  const heard = await drive([
    { view: rows(["a", "b"]), requests: [{ operation: "observeSize", target: { name: "row", key: "b" } }, { operation: "observeSize", target: { name: "row", key: "a" } }] },
    { view: rows(["a"]) },
  ], async (document) => {
    await click(document);
    await sleep(0);
    const [forB] = observers;
    assert.ok(forB !== undefined);
    assert.equal(forB.disconnected, true, "the removed target's observer is disconnected");
    forB.callback([{ contentRect: { width: 0, height: 0 } }]);
    await sleep(0);
    assert.equal(observers[1]?.disconnected, false, "the other row's subscription is untouched");
  });
  const [b, a] = heard.results;
  assert.ok(b?.kind === "Subscribed" && a?.kind === "Subscribed");
  assert.deepEqual(heard.facts, [{ kind: "TargetRemoved", subscription: b.subscription }], "a callback queued before removal says nothing after it");
});

test("subscription cancellation: unsubscribe ends it and disconnects its observer; again, or a foreign id, is Stale", async () => {
  const provider = measureCapability();
  await withDom(PAGE, async (document) => {
    install(document);
    const context = { correlationId: "x" as CorrelationId, signal: new AbortController().signal, document };
    provider.activate({ document, emitFact: () => {} });
    const run = async (request: MeasureRequest): Promise<MeasureResult | undefined> => {
      const answer = await provider.execute(request, context);
      const decoded = answer.kind === "Completed" ? decodeMeasureResult(answer.result) : undefined;
      return decoded?.ok === true ? decoded.value : undefined;
    };
    const subscribed = await run({ operation: "observeSize", target: { name: "main" } });
    assert.ok(subscribed?.kind === "Subscribed");
    assert.deepEqual(await run({ operation: "unsubscribe", subscription: subscribed.subscription }), { kind: "Unsubscribed" });
    assert.equal(observers.at(-1)?.disconnected, true);
    assert.deepEqual(await run({ operation: "unsubscribe", subscription: subscribed.subscription }), { kind: "Stale", reason: "disposed" });
    assert.deepEqual(await run({ operation: "unsubscribe", subscription: "elsewhere.1" as typeof subscribed.subscription }), { kind: "Stale", reason: "other-session" });
  });
});

test("typed refusals: unknown and ambiguous targets, bad thresholds, missing observers", async () => {
  const heard = await drive([{ view: rows(["a", "b"]), requests: [
    { operation: "measure", target: { name: "nope" } },
    { operation: "measure", target: { name: "row" } },
    { operation: "observeVisibility", target: { name: "main" }, threshold: 1.5 },
  ] }], async () => {});
  assert.deepEqual(heard.results, [{ kind: "NotFound" }, { kind: "Ambiguous", count: 2 }, { kind: "InvalidThreshold" }]);
  const bare = await drive([{ view: rows([]), requests: [{ operation: "observeSize", target: { name: "main" } }, { operation: "observeVisibility", target: { name: "main" }, threshold: 0 }] }], async () => {}, false);
  assert.deepEqual(bare.results, [{ kind: "Unsupported" }, { kind: "Unsupported" }]);
});

test("the measure pack passes the shared provider conformance suite (every result is plain JSON)", async () => {
  await withDom(PAGE, async (document) => {
    install(document);
    assert.deepEqual(await runProviderConformance(measureCapability(), {
      document,
      decodeResult: decodeMeasureResult,
      valid: [
        { name: "measure", payload: { operation: "measure", target: { name: "main" } } },
        { name: "viewport", payload: { operation: "viewport" } },
        { name: "observe", payload: { operation: "observeSize", target: { name: "main" } } },
        { name: "stale", payload: { operation: "unsubscribe", subscription: "nobody.9" } },
      ],
      malformed: [
        { name: "element", payload: { operation: "measure", target: { name: "main", element: {} } } },
        { name: "threshold-string", payload: { operation: "observeVisibility", target: { name: "main" }, threshold: "half" } },
        { name: "unknown", payload: { operation: "scrollTo" } },
      ],
      cancellable: { name: "viewport", payload: { operation: "viewport" } },
    }), []);
  });
});
