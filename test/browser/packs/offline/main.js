// The offline reference application in Chromium (kemiller2002/limen#40).
// This file is the page's engine: application meaning lives here, and the
// browser only reports and carries out effects.
//
//   first load   register the worker; lose the network; queue three
//                operations offline, persisted with Core Storage; reload with
//                no network.
//   offline load the page starts from the worker's cache (a cold offline
//                launch) and restores its outbox; the network returns: the
//                first operation is confirmed, the second conflicts and the
//                engine rebases it, the third's connection is lost after the
//                server applied it (OutcomeUnknown) and the engine reconciles
//                it by asking the server about its idempotency key.
//   update       a new version is deployed; it installs and waits (UpdateReady)
//                until the engine activates it (ControllerChanged).
//
// Phases and checks survive the reloads in sessionStorage: that is the test's
// state, not the engine's. The engine's own state survives in Core Storage.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { lifecycleCapability, LIFECYCLE_CAPABILITY, decodeLifecycleFact, decodeLifecycleResult } from "../../../../dist/capabilities/lifecycle/index.js";
import { offlineCapability, OFFLINE_CAPABILITY, decodeOfflineFact, decodeOfflineResult } from "../../../../dist/capabilities/offline/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";
import * as Outbox from "./outbox.js";

const WORKER_URL = "/__limen/offline/sw.js";
// The host's one Trusted Types policy: it vouches for this worker and nothing else.
const policy = trustedTypes.createPolicy("limen-offline", {
  createScriptURL: (url) => { if (url !== WORKER_URL) throw new TypeError(`not a declared worker: ${url}`); return url; },
});

const offer = (capability) => ({ id: capability.id, version: capability.version, fingerprint: capability.fingerprint });
const LIFECYCLE = offer(LIFECYCLE_CAPABILITY);
const OFFLINE = offer(OFFLINE_CAPABILITY);

// --- the test's own state, across reloads ----------------------------------
const PHASE = "limen-offline-phase";
const CHECKS = "limen-offline-checks";
const checks = JSON.parse(sessionStorage.getItem(CHECKS) ?? "[]");
const expect = (name, ok, detail) => { checks.push({ name, ok, detail: JSON.stringify(detail) }); sessionStorage.setItem(CHECKS, JSON.stringify(checks)); };

// --- a small engine harness: effects out, results and facts in --------------
const bridge = { queued: [], waiting: new Map(), facts: [], sequence: 0, view: { status: "starting" } };
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: bridge.view, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [LIFECYCLE, OFFLINE] } };
    if (message.kind === "CapabilityFact") {
      const decoded = message.capability === LIFECYCLE.id ? decodeLifecycleFact(message.fact) : decodeOfflineFact(message.fact);
      bridge.facts.push(decoded.ok ? { capability: message.capability, ...decoded.value } : { kind: "Undecodable" });
    }
    if (message.kind === "EffectResult") bridge.waiting.get(message.result.correlationId)?.(message.result);
    const effects = bridge.queued;
    bridge.queued = [];
    return { view: bridge.view, effects, cancellations: [] };
  },
};
const send = (effects) => {
  const answers = Promise.all(effects.map((effect) => new Promise((resolve) => bridge.waiting.set(effect.correlationId, resolve))));
  bridge.queued = effects;
  document.getElementById("poke").click();
  return answers;
};
const nextId = (prefix) => `${prefix}-${(bridge.sequence += 1)}`;
const capability = async (target, request) => {
  const [result] = await send([{ kind: "Capability", correlationId: nextId("cap"), capability: target.id, version: 1, request }]);
  const decoded = result.outcome.kind === "Completed" ? (target === LIFECYCLE ? decodeLifecycleResult : decodeOfflineResult)(result.outcome.result) : { ok: false };
  return decoded.ok ? decoded.value : { kind: "Undecodable", result };
};
const storage = async (request) => (await send([{ kind: "Storage", correlationId: nextId("store"), ...request }]))[0].outcome;
const http = async (request) => (await send([{ kind: "Http", correlationId: nextId("http"), timeoutMs: 5000, ...request }]))[0].outcome;
const project = (status) => { bridge.view = { status }; };

const factsSince = (mark) => bridge.facts.slice(mark);
const waitFor = async (predicate, ms = 5000) => {
  const deadline = Date.now() + ms;
  const poll = async () => (predicate() || Date.now() > deadline ? predicate() : (await new Promise((resolve) => setTimeout(resolve, 50)), poll()));
  return poll();
};
const act = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- the engine's outbox: persisted, and driven by effect outcomes ----------
const persist = (outbox) => storage({ operation: "set", key: "outbox", value: JSON.stringify(outbox.operations) });

// What an Http outcome means for an operation: application meaning, here.
const outcomeOf = (effect) => {
  switch (effect.kind) {
    case "Success":
      if (effect.status === 200) return { kind: "confirmed" };
      if (effect.status === 409) return { kind: "conflict", version: String(effect.body?.version ?? "") };
      return { kind: "rejected", reason: `status-${effect.status}` };
    case "OutcomeUnknown": return { kind: "unknown" };
    case "Failure": case "Cancelled": return { kind: "failed" };
    default: return { kind: "unknown" };
  }
};

const cell = { outbox: Outbox.empty, lastUnknownReason: null };
// Applies one outbox command and carries out what it emitted, until nothing is
// emitted: each send is one Http effect with the operation's idempotency key.
const drive = async ([outbox, emitted]) => {
  cell.outbox = outbox;
  await persist(outbox);
  project(`${outbox.operations.length} pending`);
  const next = emitted[0]?.send;
  if (next === undefined) return outbox;
  const effect = await http({ method: "POST", url: "/__limen/offline/ops", headers: { "Idempotency-Key": next.id, "Content-Type": "application/json" }, body: JSON.stringify({ kind: next.kind, payload: next.payload }) });
  if (effect.kind === "OutcomeUnknown") cell.lastUnknownReason = effect.reason;
  return drive(Outbox.result(next.id, outcomeOf(effect), outbox));
};
const statusesOf = (outbox) => outbox.operations.map((o) => `${o.id}:${o.status}${o.version !== undefined ? `@${o.version}` : ""}`).join(" ");

await new BrowserKernel(engine, document, undefined, {
  capabilities: [lifecycleCapability(), offlineCapability({ workers: { app: { url: WORKER_URL, scope: "/test/browser/packs/offline/", module: true } }, scriptURL: (url) => policy.createScriptURL(url) })],
  requireHandshake: true,
}).start();

const phase = sessionStorage.getItem(PHASE) ?? "first";

if (phase === "first") {
  await fetch("/__limen/offline/reset", { method: "POST" });
  await storage({ operation: "remove", key: "outbox" });
  expect("a worker the host did not declare is refused; the engine never supplies a URL", (await capability(OFFLINE, { operation: "register", worker: "/evil.js" })).kind === "UnknownWorker", null);
  const factMark = bridge.facts.length;
  const registered = await capability(OFFLINE, { operation: "register", worker: "app" });
  await waitFor(() => factsSince(factMark).some((fact) => fact.kind === "ControllerChanged"));
  const status = await capability(OFFLINE, { operation: "status" });
  expect("the declared worker registers through the host's Trusted Types policy, installs v1 and claims the page (ControllerChanged v1)",
    registered.kind === "Registered" && status.status.controlled === true && status.status.activeVersion === "v1" && factsSince(factMark).some((fact) => fact.kind === "ControllerChanged" && fact.version === "v1"),
    { registered, status, facts: factsSince(factMark) });
  expect("push and background sync are reported, not enabled", typeof status.status.push === "boolean" && typeof status.status.backgroundSync === "boolean", status.status);

  await capability(LIFECYCLE, { operation: "subscribe", topics: ["connectivity"] });
  const offlineMark = bridge.facts.length;
  await act({ kind: "offline", offline: true });
  await waitFor(() => factsSince(offlineMark).some((fact) => fact.kind === "ConnectivityChanged" && fact.online === false));
  const [queued] = [["a", "rename", "Alpha"], ["b", "rename", "conflict:Beta"], ["c", "pay", "drop:10.00"]]
    .reduce(([outbox], [id, kind, payload]) => Outbox.enqueue(id, kind, payload, outbox), [Outbox.connectivity(false, cell.outbox)[0]]);
  await drive([queued, []]);
  expect("offline, three operations are queued and persisted, and none is sent", statusesOf(cell.outbox) === "a:queued b:queued c:queued", statusesOf(cell.outbox));
  sessionStorage.setItem(PHASE, "offline");
  await act({ kind: "reload" });
} else if (phase === "offline") {
  const described = await capability(LIFECYCLE, { operation: "describe" });
  // An application registers on every start; with the same script this only
  // hands back the existing registration, so it works offline.
  const registered = await capability(OFFLINE, { operation: "register", worker: "app" });
  expect("cold offline launch: the page and every module came from the worker's cache while the browser was offline, and registering again works offline",
    described.state.online === false && registered.kind === "Registered" && registered.status.controlled === true && registered.status.activeVersion === "v1", { described, registered });

  const saved = await storage({ operation: "get", key: "outbox" });
  const restored = Outbox.restore(saved.kind === "Success" && saved.value !== null ? JSON.parse(saved.value) : []);
  await drive(restored);
  expect("the pending operations survived the reload, in order, still queued", statusesOf(cell.outbox) === "a:queued b:queued c:queued", statusesOf(cell.outbox));

  await capability(LIFECYCLE, { operation: "subscribe", topics: ["connectivity"] });
  const onlineMark = bridge.facts.length;
  await act({ kind: "offline", offline: false });
  await waitFor(() => factsSince(onlineMark).some((fact) => fact.kind === "ConnectivityChanged" && fact.online === true));
  await drive(Outbox.connectivity(true, cell.outbox));
  const cBeforeConflict = (await http({ method: "GET", url: "/__limen/offline/ops/c" })).body;
  expect("back online: a is confirmed, b conflicts at v7 and stops the queue, and c is never sent behind it",
    statusesOf(cell.outbox) === "b:conflict@v7 c:queued" && cBeforeConflict.received === 0, { outbox: statusesOf(cell.outbox), c: cBeforeConflict });

  // The engine's conflict policy: rebase its change on the server's version.
  await drive(Outbox.resolve("b", { kind: "replace", payload: "conflict:Beta rebased on v7" }, cell.outbox));
  await pause(500);
  const cAfterLoss = (await http({ method: "GET", url: "/__limen/offline/ops/c" })).body;
  expect("b, rebased, is confirmed; c's connection is lost after the server applied it: OutcomeUnknown(connection-lost), held as unknown, never resent",
    statusesOf(cell.outbox) === "c:unknown" && cell.lastUnknownReason === "connection-lost" && cAfterLoss.applied === true && cAfterLoss.received >= 1,
    { outbox: statusesOf(cell.outbox), reason: cell.lastUnknownReason, c: cAfterLoss });

  // The engine reconciles by asking the server about the idempotency key.
  const answer = await http({ method: "GET", url: "/__limen/offline/ops/c" });
  await drive(Outbox.reconcile("c", answer.body.applied === true, cell.outbox));
  const persisted = await storage({ operation: "get", key: "outbox" });
  const cFinal = (await http({ method: "GET", url: "/__limen/offline/ops/c" })).body;
  expect("reconciled: the server applied c once however often it arrived, and the persisted outbox is empty",
    cell.outbox.operations.length === 0 && persisted.value === "[]" && cFinal.applied === true && cFinal.received === cAfterLoss.received, { persisted, c: cFinal });

  // --- the application update ------------------------------------------------
  expect("nothing is waiting before a deploy", (await capability(OFFLINE, { operation: "activateUpdate" })).kind === "NothingWaiting", null);
  await fetch("/__limen/offline/deploy", { method: "POST" });
  const updateMark = bridge.facts.length;
  const checked = await capability(OFFLINE, { operation: "checkForUpdate" });
  await waitFor(() => factsSince(updateMark).some((fact) => fact.kind === "UpdateReady"));
  await pause(300);
  const waiting = await capability(OFFLINE, { operation: "status" });
  expect("a deployed version installs and waits: UpdateReady v2, while v1 still controls the page",
    checked.kind === "UpdateChecked" && factsSince(updateMark).some((fact) => fact.kind === "UpdateReady" && fact.version === "v2") && waiting.status.activeVersion === "v1" && waiting.status.waitingVersion === "v2" && !factsSince(updateMark).some((fact) => fact.kind === "ControllerChanged"),
    { checked, waiting, facts: factsSince(updateMark) });
  const activateMark = bridge.facts.length;
  const activating = await capability(OFFLINE, { operation: "activateUpdate" });
  await waitFor(() => factsSince(activateMark).some((fact) => fact.kind === "ControllerChanged"));
  const after = await capability(OFFLINE, { operation: "status" });
  // controllerchange fires as v2 starts activating; its activate handler then
  // deletes v1's cache, so wait for that rather than read it at once.
  const onlyCurrent = { names: [] };
  await waitFor(() => { void caches.keys().then((names) => { onlyCurrent.names = names; }); return JSON.stringify(onlyCurrent.names) === JSON.stringify(["limen-offline-v2"]); }, 3000);
  const cacheNames = onlyCurrent.names;
  expect("the engine activates it: Activating v2, ControllerChanged v2, and only v2's cache remains",
    activating.kind === "Activating" && activating.version === "v2" && factsSince(activateMark).some((fact) => fact.kind === "ControllerChanged" && fact.version === "v2") && after.status.activeVersion === "v2" && after.status.waitingVersion === undefined && JSON.stringify(cacheNames) === JSON.stringify(["limen-offline-v2"]),
    { activating, after, cacheNames });
  expect("every fact decoded", !bridge.facts.some((fact) => fact.kind === "Undecodable"), bridge.facts);

  sessionStorage.removeItem(PHASE);
  sessionStorage.removeItem(CHECKS);
  window.__limenPackResult = { pack: "offline", checks };
}
