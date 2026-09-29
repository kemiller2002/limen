// The lifecycle pack in Chromium: the real online/offline events, the Network
// Information API's estimate under emulated conditions, and a real trip through
// the back/forward cache — pagehide (persisted), hidden, frozen, resumed,
// visible, pageshow (persisted) — each a fact tagged with its subscription.
// Prerendering cannot be proven here: Chromium refuses to prerender while
// DevTools is attached (PrerenderingDisabledByDevTools), so it is proven in
// test/lifecycle.test.ts.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { lifecycleCapability, LIFECYCLE_CAPABILITY, decodeLifecycleResult, decodeLifecycleFact } from "../../../../dist/capabilities/lifecycle/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: LIFECYCLE_CAPABILITY.id, version: LIFECYCLE_CAPABILITY.version, fingerprint: LIFECYCLE_CAPABILITY.fingerprint };
const state = { queued: [], waiting: null, answers: new Map(), facts: [], sequence: 0, undecodable: 0 };
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 3 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    if (message.kind === "CapabilityFact") { const decoded = decodeLifecycleFact(message.fact); if (decoded.ok) state.facts.push(decoded.value); else state.undecodable += 1; return { view: {}, effects: [], cancellations: [] }; }
    if (message.kind === "EffectResult") {
      const decoded = message.result.outcome.kind === "Completed" ? decodeLifecycleResult(message.result.outcome.result) : { ok: false };
      if (!decoded.ok) state.undecodable += 1;
      state.answers.set(message.result.correlationId, decoded.ok ? decoded.value : { kind: "Undecodable" });
      if (state.waiting !== null && state.waiting.ids.every((id) => state.answers.has(id))) { const { ids, resolve } = state.waiting; state.waiting = null; resolve(ids.map((id) => state.answers.get(id))); }
      return { view: {}, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => { state.sequence += 1; return { kind: "Capability", correlationId: "life-" + state.sequence, capability: offer.id, version: 1, request }; });
    state.waiting = { ids: effects.map((effect) => effect.correlationId), resolve: state.resolveNext };
    state.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};
const ask = (requests) => new Promise((resolve) => { state.queued = requests; state.resolveNext = resolve; document.getElementById("poke").click(); });
const act = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const since = (mark) => state.facts.slice(mark);
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [lifecycleCapability()], requireHandshake: true }).start();

const [described] = await ask([{ operation: "describe" }]);
expect("describe: online, visible, not prerendering, not discarded, with Chromium's advisory connection estimate", described.kind === "Described" && described.state.online === true && described.state.visibility === "visible" && described.state.prerendering === false && described.state.wasDiscarded === false && typeof described.state.connection?.effectiveType === "string", described);

const [subscribed] = await ask([{ operation: "subscribe", topics: ["connectivity", "visibility", "pageLifecycle", "freezing", "prerendering", "connection"] }]);
const id = subscribed.subscription;
expect("subscribe returns a subscription and the current state", subscribed.kind === "Subscribed" && typeof id === "string", subscribed);

const offlineMark = state.facts.length;
await act({ kind: "offline", offline: true });
await settle();
const [whileOffline] = await ask([{ operation: "describe" }]);
await act({ kind: "offline", offline: false });
await settle();
expect("the network going away and coming back: two real connectivity facts, and describe agrees while offline",
  JSON.stringify(since(offlineMark).filter((fact) => fact.kind === "ConnectivityChanged")) === JSON.stringify([{ kind: "ConnectivityChanged", subscription: id, online: false }, { kind: "ConnectivityChanged", subscription: id, online: true }]) && whileOffline.state.online === false,
  { facts: since(offlineMark), whileOffline });

const slowMark = state.facts.length;
await act({ kind: "network", latencyMs: 400, downloadBytesPerSecond: 50000, connectionType: "cellular3g" });
await settle();
const slower = since(slowMark).filter((fact) => fact.kind === "ConnectionChanged").at(-1);
// Chromium buckets and rounds the estimate (400 ms emulated reads as 350).
expect("emulated slow network: an advisory ConnectionChanged with a slower estimate", slower !== undefined && slower.subscription === id && slower.connection.rttMs > (described.state.connection.rttMs ?? 0) && slower.connection.effectiveType !== described.state.connection.effectiveType, since(slowMark));

const tripMark = state.facts.length;
await act({ kind: "backForward", url: "test/browser/packs/lifecycle/away.html" });
await settle();
const trip = since(tripMark).filter((fact) => fact.kind !== "ConnectionChanged").map((fact) => fact.kind + (fact.persisted !== undefined ? `:${fact.persisted}` : "") + (fact.visibility !== undefined ? `:${fact.visibility}` : ""));
expect("a real back/forward-cache round trip: hidden (persisted), frozen, resumed, shown (persisted) — the page and its kernel survived",
  JSON.stringify(trip) === JSON.stringify(["PageHidden:true", "VisibilityChanged:hidden", "Frozen", "Resumed", "VisibilityChanged:visible", "PageShown:true"]) && since(tripMark).every((fact) => fact.subscription === id),
  trip);

const [unsubscribed] = await ask([{ operation: "unsubscribe", subscription: id }]);
const quietMark = state.facts.length;
await act({ kind: "offline", offline: true });
await act({ kind: "offline", offline: false });
await settle();
expect("after unsubscribe the network can come and go without a fact", unsubscribed.kind === "Unsubscribed" && since(quietMark).length === 0, since(quietMark));
const [again] = await ask([{ operation: "unsubscribe", subscription: id }]);
expect("an ended subscription is refused", again.kind === "UnknownSubscription", again);
expect("every fact and answer decoded", state.undecodable === 0, state.undecodable);

window.__limenPackResult = { pack: "lifecycle", checks };
