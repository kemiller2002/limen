// Page, connectivity and browser-lifecycle evidence (kemiller2002/limen#43,
// LCP-037). The browser source against real jsdom events; subscriptions that
// are tagged, filtered by topic and cancellable; no unload listener, ever; and
// a reference workflow through the real kernel in which the engine — not the
// pack — decides what offline, hidden and a back/forward-cache restore mean.
// The real sequence (offline, online, a bfcache round trip with freeze and
// resume) runs in Chromium in test/browser/packs/lifecycle/.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import {
  LIFECYCLE_CAPABILITY, decodeLifecycleFact, decodeLifecycleResult, lifecycleCapability,
  type LifecycleFact, type LifecycleRequest, type LifecycleResult, type LifecycleSignal, type LifecycleSource, type PageState, type Topic,
} from "../dist/capabilities/lifecycle/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineTransport } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

type Harness = { readonly ask: (request: LifecycleRequest, signal?: AbortSignal) => Promise<LifecycleResult>; readonly facts: LifecycleFact[] };

const withPack = async (source: ((document: Document) => LifecycleSource) | undefined, act: (harness: Harness, document: Document) => Promise<void>): Promise<void> => {
  await withDom("<p></p>", async (document) => {
    const facts: LifecycleFact[] = [];
    const provider = lifecycleCapability(source === undefined ? {} : { source });
    provider.activate({ document, emitFact: (fact) => { const decoded = decodeLifecycleFact(fact); assert.ok(decoded.ok, JSON.stringify(fact)); facts.push(decoded.value); } });
    const ask = async (request: LifecycleRequest, signal = new AbortController().signal): Promise<LifecycleResult> => {
      const answer = await provider.execute(request, { correlationId: "l" as CorrelationId, signal, document });
      const decoded = answer.kind === "Completed" ? decodeLifecycleResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true, JSON.stringify(answer));
      return decoded.value;
    };
    await act({ ask, facts }, document);
  });
};

const subscriptionOf = (result: LifecycleResult): string => (result.kind === "Subscribed" ? result.subscription : assert.fail(JSON.stringify(result)));

// A real event of the given type, with extra read-only properties (persisted).
const fire = (target: EventTarget, window: Window, type: string, extra: Record<string, unknown> = {}): void => {
  const event = new window.Event(type);
  Object.entries(extra).forEach(([name, value]) => Object.defineProperty(event, name, { value }));
  target.dispatchEvent(event);
};

const setVisibility = (document: Document, state: "visible" | "hidden"): void => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  fire(document, document.defaultView ?? assert.fail("window"), "visibilitychange");
};

test("describe reports the page's real state; connection quality is absent where the browser has no Network Information API", async () => {
  await withPack(undefined, async ({ ask }) => {
    assert.deepEqual(await ask({ operation: "describe" }), { kind: "Described", state: { online: true, visibility: "visible", prerendering: false, wasDiscarded: false } });
  });
});

test("every topic from real DOM events: offline/online, visibility, pagehide/pageshow with persisted, freeze/resume, prerender activation", async () => {
  await withPack(undefined, async ({ ask, facts }, document) => {
    const window = document.defaultView ?? assert.fail("window");
    const id = subscriptionOf(await ask({ operation: "subscribe", topics: ["connectivity", "visibility", "pageLifecycle", "freezing", "prerendering"] }));
    fire(window, window, "offline");
    fire(window, window, "online");
    fire(window, window, "pagehide", { persisted: true });
    setVisibility(document, "hidden");
    fire(document, window, "freeze");
    fire(document, window, "resume");
    setVisibility(document, "visible");
    fire(window, window, "pageshow", { persisted: true });
    fire(window, window, "pagehide", { persisted: false });
    fire(document, window, "prerenderingchange");
    assert.deepEqual(facts, [
      { kind: "ConnectivityChanged", subscription: id, online: false },
      { kind: "ConnectivityChanged", subscription: id, online: true },
      { kind: "PageHidden", subscription: id, persisted: true },
      { kind: "VisibilityChanged", subscription: id, visibility: "hidden" },
      { kind: "Frozen", subscription: id },
      { kind: "Resumed", subscription: id },
      { kind: "VisibilityChanged", subscription: id, visibility: "visible" },
      { kind: "PageShown", subscription: id, persisted: true },
      { kind: "PageHidden", subscription: id, persisted: false },
      { kind: "PrerenderActivated", subscription: id },
    ]);
  });
});

test("subscriptions are filtered by topic and tagged: two subscribers each hear only what they asked for", async () => {
  await withPack(undefined, async ({ ask, facts }, document) => {
    const window = document.defaultView ?? assert.fail("window");
    const network = subscriptionOf(await ask({ operation: "subscribe", topics: ["connectivity"] }));
    const screen = subscriptionOf(await ask({ operation: "subscribe", topics: ["visibility", "visibility"] }));
    assert.notEqual(network, screen);
    fire(window, window, "offline");
    setVisibility(document, "hidden");
    fire(window, window, "pagehide", { persisted: true });
    assert.deepEqual(facts, [
      { kind: "ConnectivityChanged", subscription: network, online: false },
      { kind: "VisibilityChanged", subscription: screen, visibility: "hidden" },
    ], "a duplicated topic is one listener; pagehide was not asked for");
  });
});

test("unsubscribe removes the listeners: no fact afterwards; an unknown or already-ended subscription is refused, not ignored", async () => {
  await withPack(undefined, async ({ ask, facts }, document) => {
    const window = document.defaultView ?? assert.fail("window");
    const id = subscriptionOf(await ask({ operation: "subscribe", topics: ["connectivity"] }));
    assert.deepEqual(await ask({ operation: "unsubscribe", subscription: id }), { kind: "Unsubscribed" });
    fire(window, window, "offline");
    assert.deepEqual(facts, []);
    assert.deepEqual(await ask({ operation: "unsubscribe", subscription: id }), { kind: "UnknownSubscription" });
    assert.deepEqual(await ask({ operation: "unsubscribe", subscription: "lifecycle-99" }), { kind: "UnknownSubscription" });
  });
});

test("illegal requests: a subscription with no topics is refused; an aborted request reports Cancelled and subscribes nothing", async () => {
  await withPack(undefined, async ({ ask, facts }, document) => {
    const window = document.defaultView ?? assert.fail("window");
    assert.equal((await ask({ operation: "subscribe", topics: [] })).kind, "InvalidRequest");
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await ask({ operation: "subscribe", topics: ["connectivity"] }, aborted.signal), { kind: "Cancelled" });
    fire(window, window, "offline");
    assert.deepEqual(facts, []);
  });
});

test("the pack never listens for unload or beforeunload, which would keep the page out of the back/forward cache", async () => {
  await withDom("<p></p>", async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const types: string[] = [];
    [window, document].forEach((target) => {
      const original = target.addEventListener.bind(target);
      Object.defineProperty(target, "addEventListener", { value: (type: string, ...rest: [EventListenerOrEventListenerObject, boolean?]) => { types.push(type); original(type, ...rest); } });
    });
    const provider = lifecycleCapability();
    provider.activate({ document, emitFact: () => {} });
    await provider.execute({ operation: "subscribe", topics: ["connectivity", "visibility", "pageLifecycle", "freezing", "prerendering", "connection"] }, { correlationId: "l" as CorrelationId, signal: new AbortController().signal, document });
    assert.deepEqual([...types].sort(), ["freeze", "offline", "online", "pagehide", "pageshow", "prerenderingchange", "resume", "visibilitychange"]);
  });
});

test("advisory connection quality: reported from the Network Information API where it exists, with a fact on change", async () => {
  await withPack(undefined, async ({ ask, facts }, document) => {
    const window = document.defaultView ?? assert.fail("window");
    const connection = Object.assign(new window.EventTarget(), { effectiveType: "4g", downlink: 9.6, rtt: 50, saveData: false });
    Object.defineProperty(window.navigator, "connection", { value: connection, configurable: true });
    const described = await ask({ operation: "describe" });
    assert.deepEqual(described.kind === "Described" ? described.state.connection : undefined, { effectiveType: "4g", downlinkMbps: 9.6, rttMs: 50, saveData: false });
    const id = subscriptionOf(await ask({ operation: "subscribe", topics: ["connection"] }));
    Object.assign(connection, { effectiveType: "3g", downlink: 0.4, rtt: 400 });
    fire(connection, window, "change");
    assert.deepEqual(facts, [{ kind: "ConnectionChanged", subscription: id, connection: { effectiveType: "3g", downlinkMbps: 0.4, rttMs: 400, saveData: false } }]);
  });
});

test("wasDiscarded and prerendering are read from the document", async () => {
  await withPack(undefined, async ({ ask }, document) => {
    Object.defineProperty(document, "wasDiscarded", { value: true, configurable: true });
    Object.defineProperty(document, "prerendering", { value: true, configurable: true });
    const described = await ask({ operation: "describe" });
    assert.deepEqual(described.kind === "Described" ? [described.state.wasDiscarded, described.state.prerendering] : [], [true, true]);
  });
});

// ---------------------------------------------------------------------------
// The reference workflow, through the real kernel with a scripted host
// ---------------------------------------------------------------------------

// A host whose lifecycle the test drives, and which the engine cannot tell
// from the browser.
const scripted = (initial: PageState) => {
  const cell: { state: PageState; listeners: readonly { readonly topics: readonly Topic[]; readonly onSignal: (signal: LifecycleSignal) => void }[] } = { state: initial, listeners: [] };
  const topicOf = (signal: LifecycleSignal): Topic => {
    switch (signal.kind) {
      case "connectivity": return "connectivity";
      case "visibility": return "visibility";
      case "pagehide": case "pageshow": return "pageLifecycle";
      case "freeze": case "resume": return "freezing";
      case "prerenderActivated": return "prerendering";
      case "connection": return "connection";
    }
  };
  const source: LifecycleSource = {
    state: () => cell.state,
    listen: (topics, onSignal) => {
      const listener = { topics, onSignal };
      cell.listeners = [...cell.listeners, listener];
      return () => { cell.listeners = cell.listeners.filter((candidate) => candidate !== listener); };
    },
  };
  const emit = (signal: LifecycleSignal, state: Partial<PageState> = {}): void => {
    cell.state = { ...cell.state, ...state };
    cell.listeners.filter((listener) => listener.topics.includes(topicOf(signal))).forEach((listener) => listener.onSignal(signal));
  };
  return { source, emit };
};

// The engine's decisions, as a pure transition: offline shows a banner and
// holds writes; a hidden page stops its refresh; a bfcache restore refreshes
// once, because the data may be stale. None of this is the pack's.
type Workflow = { readonly online: boolean; readonly polling: boolean; readonly refreshes: number };
const onFact = (state: Workflow, fact: LifecycleFact): Workflow => {
  switch (fact.kind) {
    case "ConnectivityChanged": return { ...state, online: fact.online };
    case "VisibilityChanged": return { ...state, polling: fact.visibility === "visible" };
    case "PageShown": return fact.persisted ? { ...state, refreshes: state.refreshes + 1 } : state;
    case "PageHidden": case "Frozen": case "Resumed": case "PrerenderActivated": case "ConnectionChanged": return state;
  }
};

test("reference workflow through the kernel: the engine decides what offline, hidden and a back/forward-cache restore mean", async () => {
  const offer = { id: LIFECYCLE_CAPABILITY.id as CapabilityId, version: LIFECYCLE_CAPABILITY.version, fingerprint: LIFECYCLE_CAPABILITY.fingerprint };
  const host = scripted({ online: true, visibility: "visible", prerendering: false, wasDiscarded: false });
  const cell: { state: Workflow } = { state: { online: true, polling: true, refreshes: 0 } };
  const view = () => ({ network: cell.state.online ? "online" : "offline — changes are held", polling: cell.state.polling ? "refreshing" : "paused", refreshes: String(cell.state.refreshes) });
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      switch (message.kind) {
        case "Initialize":
          return {
            view: view(), cancellations: [],
            effects: [{ kind: "Capability", correlationId: "life-1" as CorrelationId, capability: offer.id, version: 1, request: { operation: "subscribe", topics: ["connectivity", "visibility", "pageLifecycle"] } }],
            handshake: { kind: "Accepted", protocol: { major: 1, minor: 3 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] },
          };
        case "CapabilityFact": {
          const fact = decodeLifecycleFact(message.fact);
          cell.state = fact.ok ? onFact(cell.state, fact.value) : cell.state;
          return { view: view(), effects: [], cancellations: [] };
        }
        case "Event": case "EffectResult": case "LocationChanged":
          return { view: view(), effects: [], cancellations: [] };
      }
    },
  };
  await withDom(`<p id="network" data-text="network"></p><p id="polling" data-text="polling"></p><p id="refreshes" data-text="refreshes"></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [lifecycleCapability({ source: () => host.source })], requireHandshake: true }).start();
    const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });
    const shown = (): readonly string[] => ["network", "polling", "refreshes"].map((id) => document.getElementById(id)?.textContent ?? "");
    await settle();
    assert.deepEqual(shown(), ["online", "refreshing", "0"]);
    host.emit({ kind: "connectivity", online: false }, { online: false });
    await settle();
    assert.deepEqual(shown(), ["offline — changes are held", "refreshing", "0"]);
    host.emit({ kind: "pagehide", persisted: true });
    host.emit({ kind: "visibility", visibility: "hidden" }, { visibility: "hidden" });
    host.emit({ kind: "freeze" });
    await settle();
    assert.deepEqual(shown(), ["offline — changes are held", "paused", "0"], "freezing was not subscribed to, so it changed nothing");
    host.emit({ kind: "visibility", visibility: "visible" }, { visibility: "visible" });
    host.emit({ kind: "pageshow", persisted: true });
    host.emit({ kind: "connectivity", online: true }, { online: true });
    await settle();
    assert.deepEqual(shown(), ["online", "refreshing", "1"]);
  });
});

test("the lifecycle pack passes the shared provider conformance suite", async () => {
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await runProviderConformance(lifecycleCapability(), {
      document,
      decodeResult: decodeLifecycleResult,
      valid: [{ name: "describe", payload: { operation: "describe" } }, { name: "subscribe", payload: { operation: "subscribe", topics: ["connectivity"] } }],
      malformed: [
        { name: "unknown topic", payload: { operation: "subscribe", topics: ["battery"] } },
        { name: "missing subscription", payload: { operation: "unsubscribe" } },
      ],
      cancellable: { name: "describe", payload: { operation: "describe" } },
    }), []);
  });
});
