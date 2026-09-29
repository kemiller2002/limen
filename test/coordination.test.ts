// Cross-context coordination (kemiller2002/limen#46, LCP-040): channels
// between two contexts over Node's real BroadcastChannel and over the
// SharedWorker hub's relay; every message bounded and checked as JSON; Web
// Locks with a queued contender, cancellation and a steal; exact-origin frame
// messaging that refuses the wrong origin and the wrong source. Two real tabs,
// a real SharedWorker and cross-origin frames in Chromium:
// test/browser/packs/coordination/.

import assert from "node:assert/strict";
import test from "node:test";
import { coordinationCapability, decodeCoordinationFact, decodeCoordinationResult, exactOrigin, type CoordinationFact, type CoordinationRequest, type CoordinationResult } from "../dist/capabilities/coordination/index.js";
import { serveHub } from "../dist/capabilities/coordination/hub.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CapabilityProvider, CorrelationId } from "../dist/index.js";
import { withDom } from "./dom-helpers.ts";

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 30); });

type Context = { readonly ask: (request: CoordinationRequest, signal?: AbortSignal) => Promise<CoordinationResult>; readonly facts: CoordinationFact[]; readonly document: Document };

const contextIn = (document: Document, provider: CapabilityProvider): Context => {
  const facts: CoordinationFact[] = [];
  provider.activate({ document, emitFact: (fact) => { const decoded = decodeCoordinationFact(fact); assert.ok(decoded.ok, JSON.stringify(fact)); facts.push(decoded.value); } });
  const ask = async (request: CoordinationRequest, signal = new AbortController().signal): Promise<CoordinationResult> => {
    const answer = await provider.execute(request, { correlationId: "c" as CorrelationId, signal, document });
    const decoded = answer.kind === "Completed" ? decodeCoordinationResult(answer.result) : undefined;
    assert.ok(decoded?.ok === true, JSON.stringify(answer));
    return decoded.value;
  };
  return { ask, facts, document };
};

// Two contexts of one application, each with its own window.
const twoContexts = async (prepare: (window: Window) => void, act: (a: Context, b: Context) => Promise<void>, options: Parameters<typeof coordinationCapability>[0] = {}): Promise<void> => {
  await withDom("<p>a</p>", async (first) => {
    await withDom("<p>b</p>", async (second) => {
      [first, second].forEach((document) => prepare(document.defaultView ?? assert.fail("window")));
      await act(contextIn(first, coordinationCapability(options)), contextIn(second, coordinationCapability(options)));
    });
  });
};

// Node's BroadcastChannel and MessagePorts keep the process alive while open,
// as a page's do while it lives; each test closes what it opened.
const opened: { close(): void }[] = [];
test.afterEach(() => { opened.splice(0).forEach((handle) => handle.close()); });
class TestBroadcastChannel extends BroadcastChannel {
  constructor(name: string) {
    super(name);
    opened.push(this);
  }
}
const withBroadcast = (window: Window): void => { Object.defineProperty(window, "BroadcastChannel", { value: TestBroadcastChannel, configurable: true }); };
const tracked = (port: MessagePort): MessagePort => { opened.push(port); return port; };
const identity = async (context: Context): Promise<string> => { const answer = await context.ask({ operation: "identity" }); return answer.kind === "Identity" ? answer.context : assert.fail("identity"); };

// --- channels ------------------------------------------------------------------------

test("a broadcast reaches the other context, tagged with the sender's identity, and never comes back to the sender", async () => {
  await twoContexts(withBroadcast, async (a, b) => {
    assert.equal((await a.ask({ operation: "open", channel: "cart", via: "broadcast" })).kind, "Opened");
    assert.equal((await b.ask({ operation: "open", channel: "cart", via: "broadcast" })).kind, "Opened");
    assert.equal((await a.ask({ operation: "open", channel: "cart", via: "broadcast" })).kind, "AlreadyOpen");
    assert.deepEqual(await a.ask({ operation: "broadcast", channel: "cart", message: { items: 3 } }), { kind: "Sent" });
    await settle();
    assert.deepEqual(b.facts, [{ kind: "Received", channel: "cart", from: await identity(a), message: { items: 3 } }]);
    assert.deepEqual(a.facts, []);
    assert.notEqual(await identity(a), await identity(b));
  });
});

test("a closed channel is explicit: nothing more arrives, and sending on it is NotOpen", async () => {
  await twoContexts(withBroadcast, async (a, b) => {
    await a.ask({ operation: "open", channel: "cart", via: "broadcast" });
    await b.ask({ operation: "open", channel: "cart", via: "broadcast" });
    assert.deepEqual(await b.ask({ operation: "close", channel: "cart" }), { kind: "Closed" });
    await a.ask({ operation: "broadcast", channel: "cart", message: 1 });
    await settle();
    assert.deepEqual(b.facts, []);
    assert.deepEqual(await b.ask({ operation: "broadcast", channel: "cart", message: 1 }), { kind: "NotOpen" });
    assert.deepEqual(await b.ask({ operation: "close", channel: "cart" }), { kind: "NotOpen" });
  });
});

test("everything on a channel is validated before an engine sees it: a foreign shape, text that is not JSON, and text over the limit", async () => {
  await twoContexts(withBroadcast, async (a, b) => {
    await b.ask({ operation: "open", channel: "cart", via: "broadcast" });
    const raw = new BroadcastChannel("limen:cart");
    raw.postMessage({ something: "else" });
    raw.postMessage({ envelope: "limen.coordination/1", from: "context-x", text: "{not json" });
    raw.postMessage({ envelope: "limen.coordination/1", from: "context-x", text: JSON.stringify("x".repeat(200)) });
    await settle();
    raw.close();
    assert.deepEqual(b.facts.map((fact) => (fact.kind === "Undeliverable" ? fact.reason : fact.kind)), ["malformed", "not-json", "too-large"]);
    await a.ask({ operation: "open", channel: "cart", via: "broadcast" });
    assert.deepEqual(await a.ask({ operation: "broadcast", channel: "cart", message: "y".repeat(200) }), { kind: "TooLarge", limit: 100 });
  }, { maxMessageChars: 100 });
});

// --- the SharedWorker hub --------------------------------------------------------------

test("the hub relays a channel between contexts through a SharedWorker; without a declared hub it is Unsupported", async () => {
  const hubScope = new EventTarget();
  serveHub({ addEventListener: (type, listener) => hubScope.addEventListener(type, (event) => listener(event as MessageEvent)) });
  const created: string[] = [];
  // A SharedWorker whose port is joined to the one hub, as the browser does.
  const withHub = (window: Window): void => {
    class FakeSharedWorker {
      readonly port: MessagePort;
      constructor(url: { toString(): string }) {
        created.push(String(url));
        const channel = new MessageChannel();
        this.port = tracked(channel.port1);
        hubScope.dispatchEvent(Object.assign(new Event("connect"), { ports: [tracked(channel.port2)] }));
      }
    }
    Object.defineProperty(window, "SharedWorker", { value: FakeSharedWorker, configurable: true });
    Object.defineProperty(window, "MessagePort", { value: MessagePort, configurable: true });
  };
  await twoContexts(withHub, async (a, b) => {
    assert.equal((await a.ask({ operation: "open", channel: "presence", via: "hub" })).kind, "Opened");
    assert.equal((await b.ask({ operation: "open", channel: "presence", via: "hub" })).kind, "Opened");
    await settle();
    await a.ask({ operation: "broadcast", channel: "presence", message: { here: true } });
    await settle();
    assert.deepEqual(b.facts, [{ kind: "Received", channel: "presence", from: await identity(a), message: { here: true } }]);
    assert.deepEqual(a.facts, []);
    await b.ask({ operation: "close", channel: "presence" });
    await settle();
    await a.ask({ operation: "broadcast", channel: "presence", message: { here: false } });
    await settle();
    assert.equal(b.facts.length, 1, "a context that left the hub hears nothing more");
    assert.deepEqual(created, ["/hub.js", "/hub.js"], "the host's URL, vouched for by its policy; the engine never supplies one");
  }, { hub: { url: "/hub.js", scriptURL: (url) => ({ toString: () => url }) } });
  await twoContexts(withBroadcast, async (a) => {
    assert.deepEqual(await a.ask({ operation: "open", channel: "presence", via: "hub" }), { kind: "Unsupported" });
  });
});

// --- locks -----------------------------------------------------------------------------

// The Web Locks semantics the pack relies on: ifAvailable, a queue, abort
// while waiting, steal (the holder's request rejects with AbortError), and
// release when the callback's promise settles.
const fakeLocks = () => {
  type Waiter = { readonly mode: string; readonly grant: () => void };
  const state: { holder: { readonly abort: (error: Error) => void } | null; queue: Waiter[] } = { holder: null, queue: [] };
  const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });
  const grant = (callback: (lock: unknown) => unknown, resolve: (value: unknown) => void, reject: (error: unknown) => void): void => {
    const held = Promise.resolve(callback({ name: "x" }));
    state.holder = { abort: (error) => reject(error) };
    void held.then((value) => { if (state.holder !== null) { state.holder = null; resolve(value); state.queue.shift()?.grant(); } });
  };
  return {
    request: (_name: string, options: LockOptions, callback: (lock: unknown) => unknown) => new Promise((resolve, reject) => {
      if (options.steal === true) { state.holder?.abort(abortError()); state.holder = null; grant(callback, resolve, reject); return; }
      if (state.holder === null) { grant(callback, resolve, reject); return; }
      if (options.ifAvailable === true) { resolve(callback(null)); return; }
      const waiter: Waiter = { mode: String(options.mode), grant: () => grant(callback, resolve, reject) };
      state.queue.push(waiter);
      options.signal?.addEventListener("abort", () => { state.queue = state.queue.filter((item) => item !== waiter); reject(abortError()); });
    }),
  };
};

test("locks: exclusive acquisition, Busy for a contender that will not wait, and a queued contender that acquires when the holder releases", async () => {
  const locks = fakeLocks();
  await twoContexts((window) => Object.defineProperty(window.navigator, "locks", { value: locks, configurable: true }), async (a, b) => {
    const leader = await a.ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: true, steal: false });
    assert.equal(leader.kind, "Acquired");
    assert.deepEqual(await b.ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: false, steal: false }), { kind: "Busy" });
    const queued = b.ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: true, steal: false });
    await settle();
    assert.deepEqual(await a.ask({ operation: "release", lock: leader.kind === "Acquired" ? leader.lock : assert.fail("lock") }), { kind: "Released" });
    assert.equal((await queued).kind, "Acquired", "the queued contender acquires once the holder releases");
    assert.deepEqual(await a.ask({ operation: "release", lock: leader.kind === "Acquired" ? leader.lock : assert.fail("lock") }), { kind: "UnknownLock" });
  });
});

test("locks: a contender the engine cancels while it waits is Cancelled; a steal is LockLost for the holder", async () => {
  const locks = fakeLocks();
  await twoContexts((window) => Object.defineProperty(window.navigator, "locks", { value: locks, configurable: true }), async (a, b) => {
    const held = await a.ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: true, steal: false });
    const controller = new AbortController();
    const waiting = b.ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: true, steal: false }, controller.signal);
    await settle();
    controller.abort();
    assert.deepEqual(await waiting, { kind: "Cancelled" });
    const stolen = await b.ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: false, steal: true });
    await settle();
    assert.equal(stolen.kind, "Acquired");
    assert.deepEqual(a.facts, [{ kind: "LockLost", lock: held.kind === "Acquired" ? held.lock : assert.fail("lock") }]);
  });
});

test("locks: a browser without Web Locks is Unsupported", async () => {
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await contextIn(document, coordinationCapability()).ask({ operation: "acquire", name: "x", mode: "shared", wait: false, steal: false }), { kind: "Unsupported" });
  });
});

// --- frames ----------------------------------------------------------------------------

test("an origin must be exact: no wildcard, no opaque origin, no path, only http(s)", () => {
  assert.equal(exactOrigin("https://pay.example"), "https://pay.example");
  assert.equal(exactOrigin("http://localhost:4194"), "http://localhost:4194");
  ["*", "null", "https://pay.example/", "https://pay.example/checkout", "ftp://pay.example", "pay.example", "https://PAY.example"].forEach((origin) => assert.equal(exactOrigin(origin), undefined, origin));
});

test("frames: accepted only from the declared frame at the declared origin; the wrong origin and the wrong source are refused, as facts", async () => {
  await withDom(`<iframe data-frame-target="payment"></iframe><iframe data-frame-target="other"></iframe>`, async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const context = contextIn(document, coordinationCapability());
    assert.equal((await context.ask({ operation: "listen", target: { kind: "frame", name: "payment" }, origin: "*" })).kind, "InvalidOrigin");
    assert.equal((await context.ask({ operation: "listen", target: { kind: "frame", name: "missing" }, origin: "https://pay.example" })).kind, "NotFound");
    assert.equal((await context.ask({ operation: "listen", target: { kind: "parent" }, origin: "https://pay.example" })).kind, "NotFound", "a top-level page has no parent");
    const listening = await context.ask({ operation: "listen", target: { kind: "frame", name: "payment" }, origin: "https://pay.example" });
    const peer = listening.kind === "Listening" ? listening.peer : assert.fail("listen");
    const [payment, other] = Array.from(document.querySelectorAll("iframe"), (frame) => frame.contentWindow);
    const arrive = (data: unknown, origin: string, source: Window | null): void => { window.dispatchEvent(new window.MessageEvent("message", { data, origin, source })); };
    arrive({ paid: true }, "https://pay.example", payment ?? null);
    arrive({ paid: true }, "https://evil.example", payment ?? null);
    arrive({ paid: true }, "https://pay.example", other ?? null);
    arrive({ when: new Date(0) }, "https://pay.example", payment ?? null);
    arrive({ unrelated: true }, "https://analytics.example", other ?? null);
    assert.deepEqual(context.facts, [
      { kind: "PeerMessage", peer, message: { paid: true } },
      { kind: "PeerRefused", peer, origin: "https://evil.example", reason: "wrong-origin" },
      { kind: "PeerRefused", peer, origin: "https://pay.example", reason: "wrong-source" },
      { kind: "PeerRefused", peer, origin: "https://pay.example", reason: "not-json" },
    ], "a message from neither the peer's window nor its origin is somebody else's, and left alone");
  });
});

test("frames: posting names the exact origin as the target; a removed frame is PeerGone; an unlistened peer is unknown", async () => {
  await withDom(`<iframe data-frame-target="payment"></iframe>`, async (document) => {
    const context = contextIn(document, coordinationCapability());
    const frame = document.querySelector("iframe") ?? assert.fail("frame");
    const targets: string[] = [];
    Object.defineProperty(frame.contentWindow ?? assert.fail("window"), "postMessage", { value: (_message: unknown, origin: string) => { targets.push(origin); }, configurable: true });
    const listening = await context.ask({ operation: "listen", target: { kind: "frame", name: "payment" }, origin: "https://pay.example" });
    const peer = listening.kind === "Listening" ? listening.peer : assert.fail("listen");
    assert.deepEqual(await context.ask({ operation: "post", peer, message: { amount: 10 } }), { kind: "Sent" });
    assert.deepEqual(targets, ["https://pay.example"]);
    frame.remove();
    assert.deepEqual(await context.ask({ operation: "post", peer, message: { amount: 10 } }), { kind: "PeerGone" });
    assert.deepEqual(await context.ask({ operation: "unlisten", peer }), { kind: "Unlistened" });
    assert.deepEqual(await context.ask({ operation: "post", peer, message: 1 }), { kind: "UnknownPeer" });
  });
});

test("the coordination pack passes the shared provider conformance suite", async () => {
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await runProviderConformance(coordinationCapability(), {
      document, decodeResult: decodeCoordinationResult,
      valid: [{ name: "identity", payload: { operation: "identity" } }],
      malformed: [{ name: "a wildcard target shape", payload: { operation: "listen", target: { kind: "window" }, origin: "*" } }, { name: "open without via", payload: { operation: "open", channel: "x" } }],
      cancellable: { name: "identity", payload: { operation: "identity" } },
    }), []);
  });
});
