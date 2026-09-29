// Service-worker registration, the application-update lifecycle and the
// offline worker (kemiller2002/limen#40, LCP-034). The pack against a
// scripted service-worker container: the engine names a declared worker and
// never supplies a URL; a new version waits until the engine activates it;
// first activation, update, activation and a failed install are facts. The
// worker against a scripted scope and cache: a versioned shell, stale caches
// removed, cache-first shell files, network-first navigations with an offline
// fallback, writes never touched, and no takeover it was not told to make.
// The real browser — cold offline launch, the outbox through a real
// reconnect, and a real update — is test/browser/packs/offline/.

import assert from "node:assert/strict";
import test from "node:test";
import {
  OFFLINE_CAPABILITY, decodeOfflineFact, decodeOfflineResult, offlineCapability,
  type ContainerLike, type OfflineFact, type OfflineOptions, type OfflineRequest, type OfflineResult, type RegistrationLike, type ScriptURL, type WorkerLike,
} from "../dist/capabilities/offline/index.js";
import { cacheNameFor, serveOffline, type WorkerScope } from "../dist/capabilities/offline/worker.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CorrelationId } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

// ---------------------------------------------------------------------------
// A scripted service-worker container
// ---------------------------------------------------------------------------

type FakeWorker = WorkerLike & { state: string; readonly version: string; readonly messages: unknown[]; setState(state: string): void };
type FakeRegistration = RegistrationLike & { active: FakeWorker | null; waiting: FakeWorker | null; installing: FakeWorker | null; updates: number };
type Fake = {
  readonly container: ContainerLike & { controller: FakeWorker | null };
  readonly registered: { url?: ScriptURL; options?: RegistrationOptions };
  registration?: FakeRegistration;
  // A new version appears: installing, then installed (or discarded).
  readonly deploy: (version: string, outcome: "installed" | "redundant") => FakeWorker;
};

const fakeContainer = (options: { readonly active?: string; readonly controlled?: boolean; readonly registerFails?: string; readonly updateFails?: string } = {}): Fake => {
  const container = Object.assign(new EventTarget(), {
    controller: null as FakeWorker | null,
    register: async (url: ScriptURL, registrationOptions?: RegistrationOptions): Promise<RegistrationLike> => {
      if (options.registerFails !== undefined) throw Object.assign(new Error("refused"), { name: options.registerFails });
      fake.registered.url = url;
      fake.registered.options = registrationOptions;
      return registration;
    },
  });
  const worker = (version: string, state: string): FakeWorker => {
    const self: FakeWorker = Object.assign(new EventTarget(), {
      state,
      version,
      messages: [] as unknown[],
      setState: (next: string) => { self.state = next; self.dispatchEvent(new Event("statechange")); },
      postMessage: (message: unknown, transfer: MessagePort[]) => {
        self.messages.push(message);
        const kind = typeof message === "object" && message !== null ? Reflect.get(message, "kind") : undefined;
        if (kind === "version") transfer[0]?.postMessage({ kind: "Version", version });
        // The worker takes over only when told to.
        if (kind === "activate" && registration.waiting === self) {
          registration.active = self;
          registration.waiting = null;
          self.setState("activated");
          container.controller = self;
          container.dispatchEvent(new Event("controllerchange"));
        }
      },
    });
    return self;
  };
  const registration: FakeRegistration = Object.assign(new EventTarget(), {
    active: options.active !== undefined ? worker(options.active, "activated") : null,
    waiting: null as FakeWorker | null,
    installing: null as FakeWorker | null,
    updates: 0,
    update: async () => {
      registration.updates += 1;
      if (options.updateFails !== undefined) throw Object.assign(new Error("offline"), { name: options.updateFails });
    },
  });
  container.controller = options.controlled === true ? registration.active : null;
  const fake: Fake = {
    container,
    registered: {},
    registration,
    deploy: (version, outcome) => {
      const next = worker(version, "installing");
      registration.installing = next;
      registration.dispatchEvent(new Event("updatefound"));
      registration.installing = null;
      if (outcome === "installed") registration.waiting = next;
      next.setState(outcome);
      return next;
    },
  };
  return fake;
};

type Harness = { readonly ask: (request: OfflineRequest, signal?: AbortSignal) => Promise<OfflineResult>; readonly facts: OfflineFact[] };

const WORKERS: OfflineOptions["workers"] = { app: { url: "/sw.js", scope: "/app/", module: true } };

const withPack = async (options: Partial<OfflineOptions> & { readonly fake?: Fake }, act: (harness: Harness, document: Document) => Promise<void>): Promise<void> => {
  await withDom("<p></p>", async (document) => {
    const facts: OfflineFact[] = [];
    const provider = offlineCapability({ workers: WORKERS, versionTimeoutMs: 50, ...options, ...(options.fake !== undefined ? { container: () => options.fake?.container } : {}) });
    provider.activate({ document, emitFact: (fact) => { const decoded = decodeOfflineFact(fact); assert.ok(decoded.ok, JSON.stringify(fact)); facts.push(decoded.value); } });
    const ask = async (request: OfflineRequest, signal = new AbortController().signal): Promise<OfflineResult> => {
      const answer = await provider.execute(request, { correlationId: "o" as CorrelationId, signal, document });
      const decoded = answer.kind === "Completed" ? decodeOfflineResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true, JSON.stringify(answer));
      return decoded.value;
    };
    await act({ ask, facts }, document);
  });
};

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 20); });
const statusOf = (result: OfflineResult) => (result.kind === "Registered" || result.kind === "Described" || result.kind === "UpdateChecked" ? result.status : assert.fail(JSON.stringify(result)));

test("without service workers (jsdom has none, nor does an insecure page) every request is Unsupported", async () => {
  await withPack({}, async ({ ask }) => {
    assert.deepEqual(await ask({ operation: "register", worker: "app" }), { kind: "Unsupported" });
    assert.deepEqual(await ask({ operation: "status" }), { kind: "Unsupported" });
  });
});

test("the engine names a declared worker; the host's URL, scope, module type and Trusted Types vouching are what reach the browser", async () => {
  const fake = fakeContainer({ active: "v1" });
  const vouched = { toString: () => "/sw.js", trusted: true };
  await withPack({ fake, scriptURL: (url) => (url === "/sw.js" ? vouched : assert.fail(url)) }, async ({ ask }) => {
    assert.deepEqual(await ask({ operation: "register", worker: "https://evil.example/sw.js" }), { kind: "UnknownWorker" });
    assert.deepEqual(await ask({ operation: "register", worker: "toString" }), { kind: "UnknownWorker" }, "an inherited name is not a declared worker");
    assert.equal(fake.registered.url, undefined, "nothing was registered for an undeclared name");
    const registered = await ask({ operation: "register", worker: "app" });
    assert.equal(fake.registered.url, vouched);
    assert.deepEqual(fake.registered.options, { scope: "/app/", type: "module" });
    assert.deepEqual(statusOf(registered), { supported: true, registered: true, controlled: false, activeVersion: "v1", installing: false, push: false, backgroundSync: false });
  });
});

test("first activation is not an update: no UpdateReady, then ControllerChanged when the worker claims the page", async () => {
  const fake = fakeContainer();
  await withPack({ fake }, async ({ ask, facts }) => {
    await ask({ operation: "register", worker: "app" });
    const first = fake.deploy("v1", "installed");
    await settle();
    assert.deepEqual(facts, [], "nothing controlled the page, so nothing is waiting on the engine");
    first.postMessage({ kind: "activate" }, []);
    await settle();
    assert.deepEqual(facts, [{ kind: "ControllerChanged", version: "v1" }]);
  });
});

test("an update installs and waits: UpdateReady, nothing takes over until the engine activates, then ControllerChanged", async () => {
  const fake = fakeContainer({ active: "v1", controlled: true });
  await withPack({ fake }, async ({ ask, facts }) => {
    await ask({ operation: "register", worker: "app" });
    assert.deepEqual(await ask({ operation: "activateUpdate" }), { kind: "NothingWaiting" });
    const checked = await ask({ operation: "checkForUpdate" });
    assert.equal(fake.registration?.updates, 1);
    assert.equal(statusOf(checked).waitingVersion, undefined);
    fake.deploy("v2", "installed");
    await settle();
    assert.deepEqual(facts, [{ kind: "UpdateReady", version: "v2" }]);
    const waiting = statusOf(await ask({ operation: "status" }));
    assert.deepEqual([waiting.activeVersion, waiting.waitingVersion, waiting.controlled], ["v1", "v2", true]);
    await settle();
    assert.equal(fake.container.controller?.version, "v1", "the new version did not take over on its own");
    assert.deepEqual(await ask({ operation: "activateUpdate" }), { kind: "Activating", version: "v2" });
    await settle();
    assert.deepEqual(facts, [{ kind: "UpdateReady", version: "v2" }, { kind: "ControllerChanged", version: "v2" }]);
    const after = statusOf(await ask({ operation: "status" }));
    assert.deepEqual([after.activeVersion, after.waitingVersion], ["v2", undefined]);
  });
});

test("a version that fails to install is UpdateFailed, and the current one keeps control", async () => {
  const fake = fakeContainer({ active: "v1", controlled: true });
  await withPack({ fake }, async ({ ask, facts }) => {
    await ask({ operation: "register", worker: "app" });
    fake.deploy("v2", "redundant");
    await settle();
    assert.deepEqual(facts, [{ kind: "UpdateFailed" }]);
    assert.equal(fake.container.controller?.version, "v1");
  });
});

test("illegal and failed requests: not registered, the browser refusing, an unreachable update, an aborted request", async () => {
  await withPack({ fake: fakeContainer() }, async ({ ask }) => {
    assert.deepEqual(await ask({ operation: "checkForUpdate" }), { kind: "NotRegistered" });
    assert.deepEqual(await ask({ operation: "activateUpdate" }), { kind: "NotRegistered" });
    const aborted = new AbortController();
    aborted.abort();
    assert.deepEqual(await ask({ operation: "register", worker: "app" }, aborted.signal), { kind: "Cancelled" });
  });
  await withPack({ fake: fakeContainer({ registerFails: "SecurityError" }) }, async ({ ask }) => {
    assert.deepEqual(await ask({ operation: "register", worker: "app" }), { kind: "Failed", problem: "SecurityError" });
  });
  await withPack({ fake: fakeContainer({ active: "v1", controlled: true, updateFails: "TypeError" }) }, async ({ ask }) => {
    await ask({ operation: "register", worker: "app" });
    assert.deepEqual(await ask({ operation: "checkForUpdate" }), { kind: "Failed", problem: "TypeError" });
  });
});

test("the offline pack passes the shared provider conformance suite", async () => {
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await runProviderConformance(offlineCapability({ workers: WORKERS, container: () => fakeContainer({ active: "v1" }).container, versionTimeoutMs: 50 }), {
      document,
      decodeResult: decodeOfflineResult,
      valid: [{ name: "register", payload: { operation: "register", worker: "app" } }, { name: "status", payload: { operation: "status" } }],
      malformed: [
        { name: "a URL instead of a worker name", payload: { operation: "register", url: "/sw.js" } },
        { name: "unknown operation", payload: { operation: "unregister" } },
      ],
      cancellable: { name: "status", payload: { operation: "status" } },
    }), []);
  });
  assert.equal(OFFLINE_CAPABILITY.id, "limen.offline");
});

// ---------------------------------------------------------------------------
// The worker, against a scripted scope and cache storage
// ---------------------------------------------------------------------------

const ORIGIN = "https://app.example";

const fakeScope = (network: (request: Request) => Promise<Response>) => {
  const stores = new Map<string, Map<string, Response>>();
  const listeners = new Map<string, (event: Event) => void>();
  const calls = { skipWaiting: 0, claim: 0, fetched: [] as string[] };
  const cacheFor = (name: string): Cache => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    const keyOf = (request: RequestInfo | URL, options?: CacheQueryOptions): string => {
      const url = new URL(request instanceof Request ? request.url : String(request), ORIGIN);
      return options?.ignoreSearch === true ? `${url.origin}${url.pathname}` : url.href;
    };
    return {
      match: async (request: RequestInfo | URL, options?: CacheQueryOptions) => store.get(keyOf(request, options))?.clone(),
      addAll: async (requests: RequestInfo[]) => {
        const answers = await Promise.all(requests.map(async (request) => [keyOf(request), await scope.fetch(new Request(new URL(String(request), ORIGIN)))] as const));
        answers.forEach(([key, response]) => store.set(key, response));
      },
    } as Cache;
  };
  const scope: WorkerScope = {
    addEventListener: (type, listener) => { listeners.set(type, listener); },
    skipWaiting: async () => { calls.skipWaiting += 1; },
    clients: { claim: async () => { calls.claim += 1; } },
    caches: {
      open: async (name: string) => cacheFor(name),
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    } as CacheStorage,
    location: { href: `${ORIGIN}/sw.js` },
    fetch: async (request) => { calls.fetched.push(`${request.method} ${request.url}`); return network(request); },
  };
  // Dispatches an extendable event and waits for what it asked to wait for.
  const dispatch = async (type: string, extra: Record<string, unknown>): Promise<{ readonly responded?: Response }> => {
    const waits: Promise<unknown>[] = [];
    const answer: { responded?: Promise<Response> } = {};
    const event = Object.assign(new Event(type), { waitUntil: (promise: Promise<unknown>) => { waits.push(promise); }, respondWith: (response: Promise<Response>) => { answer.responded = response; } }, extra);
    listeners.get(type)?.(event);
    await Promise.all(waits);
    return answer.responded === undefined ? {} : { responded: await answer.responded };
  };
  return { scope, stores, calls, dispatch };
};

const page = (body: string): Response => new Response(body, { headers: { "Content-Type": "text/html" } });
const CONFIG = { version: "v2", shell: ["/index.html", "/app.js"], fallback: "/index.html" };
const navigation = (url: string): Request => Object.defineProperty(new Request(url), "mode", { value: "navigate" });

test("install caches the declared shell under a cache named for the version, and never takes over on its own", async () => {
  const worker = fakeScope(async (request) => page(`network ${new URL(request.url).pathname}`));
  worker.stores.set("limen-offline-v1", new Map());
  serveOffline(worker.scope, CONFIG);
  await worker.dispatch("install", {});
  assert.equal(cacheNameFor(CONFIG), "limen-offline-v2");
  assert.deepEqual([...(worker.stores.get("limen-offline-v2")?.keys() ?? [])], [`${ORIGIN}/index.html`, `${ORIGIN}/app.js`]);
  assert.equal(worker.calls.skipWaiting, 0);
});

test("activate deletes this pack's other versions only, then claims the pages", async () => {
  const worker = fakeScope(async () => page("x"));
  ["limen-offline-v1", "limen-offline-v2", "someone-elses-cache"].forEach((name) => worker.stores.set(name, new Map()));
  serveOffline(worker.scope, CONFIG);
  await worker.dispatch("activate", {});
  assert.deepEqual([...worker.stores.keys()].sort(), ["limen-offline-v2", "someone-elses-cache"]);
  assert.equal(worker.calls.claim, 1);
});

test("fetch: shell files from the cache; navigations network-first with the cached page when the network fails; writes and other origins untouched", async () => {
  const online = { value: true };
  const worker = fakeScope(async (request) => {
    if (!online.value) throw new TypeError("Failed to fetch");
    return page(`network ${new URL(request.url).pathname}`);
  });
  serveOffline(worker.scope, CONFIG);
  await worker.dispatch("install", {});
  worker.calls.fetched.length = 0;
  const script = await worker.dispatch("fetch", { request: new Request(`${ORIGIN}/app.js`) });
  assert.equal(await script.responded?.text(), "network /app.js", "the installed copy");
  assert.deepEqual(worker.calls.fetched, [], "a shell file is answered from the cache");
  assert.equal(await (await worker.dispatch("fetch", { request: navigation(`${ORIGIN}/index.html?tab=2`) })).responded?.text(), "network /index.html", "online, a navigation goes to the network");
  online.value = false;
  assert.equal(await (await worker.dispatch("fetch", { request: navigation(`${ORIGIN}/index.html?tab=2`) })).responded?.text(), "network /index.html", "offline, the cached page");
  assert.equal(await (await worker.dispatch("fetch", { request: navigation(`${ORIGIN}/reports/7`) })).responded?.text(), "network /index.html", "offline, an uncached page gets the fallback");
  assert.deepEqual(await worker.dispatch("fetch", { request: new Request(`${ORIGIN}/api/orders`, { method: "POST", body: "{}" }) }), {}, "a write is never answered, queued or replayed by the worker");
  assert.deepEqual(await worker.dispatch("fetch", { request: new Request("https://cdn.example/lib.js") }), {}, "another origin passes through");
  assert.deepEqual(await worker.dispatch("fetch", { request: new Request(`${ORIGIN}/api/orders`) }), {}, "a GET outside the shell passes through");
});

test("message: the worker reports its version, takes over only when told to, and ignores anything else", async () => {
  const worker = fakeScope(async () => page("x"));
  serveOffline(worker.scope, CONFIG);
  const channel = new MessageChannel();
  const reply = new Promise<unknown>((resolve) => { channel.port1.onmessage = (event) => resolve(event.data); });
  await worker.dispatch("message", { data: { kind: "version" }, ports: [channel.port2] });
  assert.deepEqual(await reply, { kind: "Version", version: "v2" });
  channel.port1.close();
  await worker.dispatch("message", { data: { kind: "unregister" }, ports: [] });
  await worker.dispatch("message", { data: "activate", ports: [] });
  assert.equal(worker.calls.skipWaiting, 0);
  await worker.dispatch("message", { data: { kind: "activate" }, ports: [] });
  assert.equal(worker.calls.skipWaiting, 1);
});
