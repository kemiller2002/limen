// The optional worker host (kemiller2002/limen#41, LCP-035): WorkerTransport
// on the page side and serveEngine inside the worker, joined here by a
// scripted worker pair that structured-clones every message like a real one.
// The kernel is unchanged and blind; only serialized contract JSON crosses;
// replies are answered in order; and every way a worker can fail — cannot
// start, throws, stops answering, is terminated, its engine throws — is an
// explicit, named fault that ends the worker, which the fallback host turns
// into an error id and a restart with a new worker. The three WebAssembly
// engines in a real worker are proven in scripts/smoke-guests.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { WorkerTransport, type WorkerLike } from "../dist/hosts/worker-transport.js";
import { serveEngine } from "../dist/hosts/worker-engine.js";
import { startWithFallback } from "../dist/hosts/fallback.js";
import type { BrowserToEngineMessage, CorrelationId, EngineToBrowserMessage, EngineTransport } from "../dist/protocol.js";
import { withDom, withFetch } from "./dom-helpers.ts";

// A counter engine with one Http round trip, in plain TypeScript: which
// language the engine is written in is invisible to the host.
const counterEngine = (behaviour: { readonly throwOn?: string; readonly garbageOn?: string } = {}): EngineTransport => {
  const state = { count: 0, loaded: "not loaded" };
  const view = () => ({ count: String(state.count), loaded: state.loaded });
  return {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> => {
      if (message.kind === "Event" && message.event.name === behaviour.throwOn) throw new RangeError("the engine broke");
      if (message.kind === "Event" && message.event.name === behaviour.garbageOn) return JSON.parse('{"view":{"count":{"not":"a view value"}},"effects":[],"cancellations":[]}');
      if (message.kind === "Event" && message.event.name === "increment") state.count += 1;
      if (message.kind === "Event" && message.event.name === "load") return { view: view(), cancellations: [], effects: [{ kind: "Http", correlationId: "load-1" as CorrelationId, method: "GET", url: "/data", timeoutMs: 1000 }] };
      if (message.kind === "EffectResult" && message.result.kind === "HttpResult") state.loaded = message.result.outcome.kind === "Success" ? `loaded ${JSON.stringify(message.result.outcome.body)}` : message.result.outcome.kind;
      return { view: view(), effects: [], cancellations: [] };
    },
  };
};

type Pair = { readonly worker: WorkerLike; readonly toWorker: unknown[]; readonly terminated: () => number; readonly crash: () => void };

// A Worker and its global scope, joined asynchronously with structuredClone,
// as the browser joins them. Nothing reaches a terminated worker.
const workerPair = (createEngine: (() => EngineTransport) | undefined): Pair => {
  const scopeSide = new EventTarget();
  const pageSide = new EventTarget();
  const log = { terminated: 0, toWorker: [] as unknown[] };
  const deliver = (target: EventTarget, data: unknown): void => {
    setTimeout(() => { if (log.terminated === 0) target.dispatchEvent(Object.assign(new Event("message"), { data: structuredClone(data) })); }, 0);
  };
  if (createEngine !== undefined) serveEngine({ addEventListener: (type, listener) => scopeSide.addEventListener(type, (event) => listener(event as MessageEvent)), postMessage: (message) => deliver(pageSide, message) }, createEngine);
  const worker = Object.assign(pageSide, {
    postMessage: (message: unknown) => { log.toWorker.push(message); deliver(scopeSide, message); },
    terminate: () => { log.terminated += 1; },
  });
  return { worker, toWorker: log.toWorker, terminated: () => log.terminated, crash: () => { pageSide.dispatchEvent(new Event("error", { cancelable: true })); } };
};

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 20); });
const PAGE = `<p id="count" data-text="count"></p><p id="loaded" data-text="loaded"></p><button id="inc" data-event="increment">+</button><button id="load" data-event="load">load</button>`;
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "none");
const rejection = (promise: Promise<unknown>): Promise<string> => promise.then(() => "resolved", nameOf);

test("the unchanged kernel drives an engine in a worker: state transitions and an Http round trip, with only contract JSON crossing", async () => {
  const pair = workerPair(() => counterEngine());
  const fetchImpl = (async () => Response.json({ rows: 3 })) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(PAGE, async (document) => {
    const transport = new WorkerTransport({ createWorker: () => pair.worker });
    await new BrowserKernel(transport, document).start();
    await settle();
    assert.equal(transport.status, "running");
    document.getElementById("inc")?.click();
    document.getElementById("inc")?.click();
    document.getElementById("load")?.click();
    await settle();
    await settle();
    assert.equal(document.getElementById("count")?.textContent, "2");
    assert.equal(document.getElementById("loaded")?.textContent, 'loaded {"rows":3}', "the Http effect ran on the main thread and its result went back to the worker");
    const dispatched = pair.toWorker.filter((message) => typeof message === "object" && message !== null && Reflect.get(message, "kind") === "dispatch");
    assert.ok(dispatched.length >= 4);
    assert.ok(dispatched.every((message) => typeof Reflect.get(message as object, "message") === "string"), "every message crossed as serialized JSON, nothing else");
  }));
});

test("replies come back in the order the requests were sent, even when they are all in flight at once", async () => {
  const pair = workerPair(() => counterEngine());
  const transport = new WorkerTransport({ createWorker: () => pair.worker });
  await transport.start();
  const replies = await Promise.all(Array.from({ length: 5 }, () => transport.dispatch({ kind: "Event", event: { kind: "Event", name: "increment" } })));
  assert.deepEqual(replies.map((reply) => reply.view.count), ["1", "2", "3", "4", "5"]);
});

test("an engine that throws is WorkerEngineFailed: the worker is ended, and every later dispatch is refused the same way", async () => {
  const pair = workerPair(() => counterEngine({ throwOn: "explode" }));
  const transport = new WorkerTransport({ createWorker: () => pair.worker });
  await transport.start();
  assert.equal(await rejection(transport.dispatch({ kind: "Event", event: { kind: "Event", name: "explode" } })), "WorkerEngineFailed");
  assert.equal(await rejection(transport.dispatch({ kind: "Event", event: { kind: "Event", name: "increment" } })), "WorkerEngineFailed");
  assert.deepEqual([transport.status, pair.terminated()], ["faulted", 1]);
});

test("a worker that throws is WorkerCrashed, and what was in flight is rejected, not left hanging", async () => {
  const pair = workerPair(undefined);
  pair.worker.addEventListener("message", () => {});
  const transport = new WorkerTransport({ createWorker: () => pair.worker, startTimeoutMs: 1000 });
  const starting = rejection(transport.start());
  pair.crash();
  assert.equal(await starting, "WorkerStartFailed", "a throw before the engine started is a start failure");
  const running = workerPair(() => counterEngine());
  const second = new WorkerTransport({ createWorker: () => running.worker });
  await second.start();
  const inFlight = rejection(second.dispatch({ kind: "Event", event: { kind: "Event", name: "increment" } }));
  running.crash();
  assert.equal(await inFlight, "WorkerCrashed");
  assert.equal(running.terminated(), 1);
});

test("a worker that stops answering is WorkerTimeout, and is terminated rather than left running", async () => {
  const silent = workerPair(undefined);
  const transport = new WorkerTransport({ createWorker: () => silent.worker, startTimeoutMs: 30 });
  assert.equal(await rejection(transport.start()), "WorkerStartFailed");
  const answersStartOnly = workerPair(() => ({ start: async () => {}, dispatch: () => new Promise<EngineToBrowserMessage>(() => {}) }));
  const hung = new WorkerTransport({ createWorker: () => answersStartOnly.worker, dispatchTimeoutMs: 30 });
  await hung.start();
  assert.equal(await rejection(hung.dispatch({ kind: "Event", event: { kind: "Event", name: "x" } })), "WorkerTimeout");
  assert.deepEqual([hung.status, answersStartOnly.terminated()], ["faulted", 1]);
});

test("an engine that cannot load is WorkerStartFailed", async () => {
  const pair = workerPair(() => ({ start: async () => { throw new TypeError("no module"); }, dispatch: async () => ({ view: {}, effects: [], cancellations: [] }) }));
  const transport = new WorkerTransport({ createWorker: () => pair.worker });
  assert.equal(await rejection(transport.start()), "WorkerStartFailed");
  assert.equal(transport.status, "faulted");
});

test("terminate ends the worker: in flight and later dispatches are WorkerTerminated", async () => {
  const pair = workerPair(() => ({ start: async () => {}, dispatch: () => new Promise<EngineToBrowserMessage>(() => {}) }));
  const transport = new WorkerTransport({ createWorker: () => pair.worker });
  await transport.start();
  const inFlight = rejection(transport.dispatch({ kind: "Event", event: { kind: "Event", name: "x" } }));
  transport.terminate();
  assert.equal(await inFlight, "WorkerTerminated");
  assert.equal(await rejection(transport.dispatch({ kind: "Event", event: { kind: "Event", name: "x" } })), "WorkerTerminated");
  assert.deepEqual([transport.status, pair.terminated()], ["terminated", 1]);
});

test("a reply outside the contract is refused by the generated decoder on the page side", async () => {
  const pair = workerPair(() => counterEngine({ garbageOn: "garbage" }));
  const transport = new WorkerTransport({ createWorker: () => pair.worker });
  await transport.start();
  const refused = await transport.dispatch({ kind: "Event", event: { kind: "Event", name: "garbage" } }).then(() => "accepted", (error: unknown) => String(error));
  assert.match(refused, /outside the Limen contract at \$\.view\["count"\]/);
});

test("inside the worker, a message outside the contract or before start is reported, never passed to the engine", async () => {
  const scopeSide = new EventTarget();
  const posted: unknown[] = [];
  const calls: string[] = [];
  serveEngine({ addEventListener: (type, listener) => scopeSide.addEventListener(type, (event) => listener(event as MessageEvent)), postMessage: (message) => posted.push(message) }, () => ({ start: async () => {}, dispatch: async (message) => { calls.push(message.kind); return { view: {}, effects: [], cancellations: [] }; } }));
  const send = (data: unknown): void => { scopeSide.dispatchEvent(Object.assign(new Event("message"), { data })); };
  send({ kind: "dispatch", id: 1, message: JSON.stringify({ kind: "Event", event: { kind: "Event", name: "early" } }) });
  send({ kind: "start" });
  send({ kind: "dispatch", id: 2, message: "{not json" });
  send({ kind: "dispatch", id: 3, message: JSON.stringify({ kind: "Teleport" }) });
  send({ kind: "dispatch", id: 4, message: JSON.stringify({ kind: "Event", event: { kind: "Event", name: "fine" } }) });
  await settle();
  assert.deepEqual(posted, [
    { kind: "failed", id: 1, name: "NotStarted" },
    { kind: "started" },
    { kind: "failed", id: 2, name: "MalformedMessage" },
    { kind: "failed", id: 3, name: "MalformedMessage" },
    { kind: "reply", id: 4, message: JSON.stringify({ view: {}, effects: [], cancellations: [] }) },
  ]);
  assert.deepEqual(calls, ["Event"]);
});

test("with the fallback host: a terminated worker is a redacted error id, and a restart is a new worker", async () => {
  const workers: Pair[] = [];
  await withDom(`<main id="app">${PAGE}</main>`, async (document) => {
    const transports: WorkerTransport[] = [];
    const host = await startWithFallback({
      document,
      connect: (guard) => {
        const transport = new WorkerTransport({ createWorker: () => { const pair = workerPair(() => counterEngine()); workers.push(pair); return pair.worker; } });
        transports.push(transport);
        return new BrowserKernel(guard(transport), document);
      },
    });
    assert.equal(host.health().kind, "available");
    transports[0]?.terminate();
    document.getElementById("inc")?.click();
    await settle();
    assert.deepEqual(host.health(), { kind: "unavailable", attempt: 1, id: "LIMEN-DISPATCH-WorkerTerminated", phase: "dispatch", restartable: true });
    assert.equal((await host.restart()).kind, "available");
    assert.equal(workers.length, 2, "the restart started a new worker");
    document.getElementById("inc")?.click();
    await settle();
    assert.equal(document.getElementById("count")?.textContent, "1", "the new worker's engine starts from its own initial state");
  });
});
