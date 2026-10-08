// limen.store version 2: durability and availability evidence (LCP-061..064).
// persist, persisted and estimate over a scripted navigator.storage; the
// availability classes over scripted and in-memory IndexedDBs; creation
// evidence and ConnectionLost over fake-indexeddb, whose forceCloseDatabase
// closes a connection the way a browser does when storage is cleared. The
// Chromium page test/browser/packs/store-durability proves the real thing.

import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange, forceCloseDatabase } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { decodeStoreFact, decodeStoreResult, storeCapability, type StoreRequest, type StoreSchema } from "../dist/capabilities/store/index.js";
import type { CorrelationId } from "../dist/protocol.js";

type Setup = { readonly indexedDB?: unknown; readonly storage?: unknown; readonly versioned?: boolean };
type Tab = { readonly ask: (request: unknown) => Promise<unknown>; readonly facts: unknown[] };

const tab = (setup: Setup): Tab => {
  const dom = new JSDOM("<!doctype html><p>store</p>", { url: "http://localhost/" });
  if (setup.indexedDB !== undefined) Reflect.set(dom.window, "indexedDB", setup.indexedDB);
  Reflect.set(dom.window, "IDBKeyRange", IDBKeyRange);
  if (setup.storage !== undefined) Object.defineProperty(dom.window.navigator, "storage", { value: setup.storage, configurable: true });
  const document = dom.window.document;
  const provider = setup.versioned === false ? storeCapability() : storeCapability({ namespace: "app" });
  const facts: unknown[] = [];
  provider.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
  const ask = async (request: unknown): Promise<unknown> => {
    const answer = await provider.execute(request, { correlationId: "s" as CorrelationId, signal: new AbortController().signal, document });
    if (answer.kind === "Rejected") return answer;
    const decoded = decodeStoreResult(answer.result);
    assert.ok(decoded.ok, `every result decodes: ${JSON.stringify(answer)}`);
    return decoded.value;
  };
  return { ask, facts };
};

// A factory whose connections the test can force closed, as a browser does.
const recording = (factory: IDBFactory): { readonly factory: unknown; readonly opened: IDBDatabase[] } => {
  const opened: IDBDatabase[] = [];
  return {
    opened,
    factory: {
      open: (name: string, version?: number) => {
        const request = factory.open(name, version);
        request.addEventListener("success", () => opened.push(request.result));
        return request;
      },
      deleteDatabase: (name: string) => factory.deleteDatabase(name),
      databases: () => factory.databases(),
      cmp: (left: unknown, right: unknown) => factory.cmp(left, right),
    },
  };
};

const schema: StoreSchema = { name: "entries", keyPath: "id", indexes: [] };
const open: StoreRequest = { operation: "open", database: "queue", version: 1, stores: [schema], dropStores: [] };
const put: StoreRequest = { operation: "transact", database: "queue", mode: "readwrite", operations: [{ op: "put", store: "entries", value: { id: 1 } }] };
const limits = { maxValueBytes: 1048576, maxTransactionBytes: 8388608 };

test("LCP-061/063: with no navigator.storage, persist, persisted and estimate are Unsupported, never a refusal", async () => {
  const { ask } = tab({ indexedDB: new IDBFactory() });
  for (const operation of ["persist", "persisted", "estimate"]) assert.deepEqual(await ask({ operation }), { kind: "Unsupported" }, operation);
});

test("LCP-061: persist answers the browser's decision; a rejected promise is granted false; persisted answers Persistence", async () => {
  const calls: string[] = [];
  const granting = tab({ storage: { persist: async () => { calls.push("persist"); return true; }, persisted: async () => true } });
  assert.deepEqual(calls, [], "the pack asks nothing on its own");
  assert.deepEqual(await granting.ask({ operation: "persist" }), { kind: "Persisted", granted: true });
  assert.deepEqual(await granting.ask({ operation: "persisted" }), { kind: "Persistence", persistent: true });
  assert.deepEqual(calls, ["persist"]);
  const refusing = tab({ storage: { persist: async () => false, persisted: async () => false } });
  assert.deepEqual(await refusing.ask({ operation: "persist" }), { kind: "Persisted", granted: false });
  assert.deepEqual(await refusing.ask({ operation: "persisted" }), { kind: "Persistence", persistent: false });
  const rejecting = tab({ storage: { persist: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })) } });
  assert.deepEqual(await rejecting.ask({ operation: "persist" }), { kind: "Persisted", granted: false });
  assert.deepEqual(await rejecting.ask({ operation: "persisted" }), { kind: "Unsupported" });
});

test("LCP-063: estimate reports non-negative integer bytes; a count the browser did not report is absent, never zero", async () => {
  assert.deepEqual(await tab({ storage: { estimate: async () => ({ usage: 1234.4, quota: 5e9 }) } }).ask({ operation: "estimate" }), { kind: "Estimate", usage: 1234, quota: 5000000000 });
  assert.deepEqual(await tab({ storage: { estimate: async () => ({ usage: 10 }) } }).ask({ operation: "estimate" }), { kind: "Estimate", usage: 10 });
  assert.deepEqual(await tab({ storage: { estimate: async () => ({ usage: -1, quota: Number.NaN }) } }).ask({ operation: "estimate" }), { kind: "Estimate" });
  assert.deepEqual(await tab({ storage: { estimate: () => Promise.reject(new Error("x")) } }).ask({ operation: "estimate" }), { kind: "Unsupported" });
});

// An IndexedDB whose open fails: by throwing, or through onerror.
const failing = (name: string, how: "throw" | "error"): unknown => ({
  open: () => {
    if (how === "throw") throw Object.assign(new Error(name), { name });
    const request: { error: { name: string }; onerror: ((event: { preventDefault(): void }) => void) | null; onsuccess: null } = { error: { name }, onerror: null, onsuccess: null };
    setTimeout(() => request.onerror?.({ preventDefault: () => {} }), 1);
    return request;
  },
});

test("LCP-064: availability classifies Missing, Available, Refused and Broken, with the exception name only", async () => {
  assert.deepEqual(await tab({}).ask({ operation: "availability" }), { kind: "Availability", availability: "Missing" });
  const factory = new IDBFactory();
  assert.deepEqual(await tab({ indexedDB: factory }).ask({ operation: "availability" }), { kind: "Availability", availability: "Available" });
  assert.deepEqual(await factory.databases(), [], "the probe database is deleted again");
  assert.deepEqual(await tab({ indexedDB: failing("SecurityError", "throw") }).ask({ operation: "availability" }), { kind: "Availability", availability: "Refused", reason: "SecurityError" });
  assert.deepEqual(await tab({ indexedDB: failing("InvalidStateError", "error") }).ask({ operation: "availability" }), { kind: "Availability", availability: "Refused", reason: "InvalidStateError" });
  assert.deepEqual(await tab({ indexedDB: failing("UnknownError", "error") }).ask({ operation: "availability" }), { kind: "Availability", availability: "Broken", reason: "UnknownError" });
});

test("LCP-062: Opened says whether this open created the database: on first use, not on a reopen, and again after the database is gone", async () => {
  const factory = new IDBFactory();
  const { ask } = tab({ indexedDB: factory });
  assert.deepEqual(await ask(open), { kind: "Opened", version: 1, upgradedFrom: 0, limits, created: true });
  assert.deepEqual(await ask(open), { kind: "Opened", version: 1, upgradedFrom: 1, limits, created: false });
  assert.deepEqual(await ask({ operation: "deleteDatabase", database: "queue" }), { kind: "DatabaseDeleted" });
  assert.deepEqual(await ask(open), { kind: "Opened", version: 1, upgradedFrom: 0, limits, created: true });
});

test("LCP-062: a connection the browser closes under the page is ConnectionLost; later writes are NotOpen, never silently reopened", async () => {
  const { factory, opened } = recording(new IDBFactory());
  const { ask, facts } = tab({ indexedDB: factory });
  await ask(open);
  assert.deepEqual(await ask(put), { kind: "Committed", results: [{ kind: "Put", key: 1 }] });
  opened.forEach((database) => forceCloseDatabase(database));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(facts, [{ kind: "ConnectionLost", database: "queue" }]);
  assert.deepEqual(await ask(put), { kind: "NotOpen" });
  assert.deepEqual(opened.length, 1, "the pack did not reopen on its own");
  assert.deepEqual(await ask(open), { kind: "Opened", version: 1, upgradedFrom: 1, limits, created: false });
  assert.deepEqual(await ask(put), { kind: "Committed", results: [{ kind: "Put", key: 1 }] });
});

test("a version 1 registration refuses the durability requests as malformed and emits no ConnectionLost (0.7.x has no such fact)", async () => {
  const { factory, opened } = recording(new IDBFactory());
  const { ask, facts } = tab({ indexedDB: factory, versioned: false, storage: { persist: async () => true } });
  for (const operation of ["persist", "persisted", "estimate", "availability"]) assert.deepEqual(await ask({ operation }), { kind: "Rejected", reason: "malformed-request" }, operation);
  assert.deepEqual(await ask(open), { kind: "Opened", version: 1, upgradedFrom: 0 });
  opened.forEach((database) => forceCloseDatabase(database));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(facts, []);
  assert.deepEqual(await ask(put), { kind: "NotOpen" });
});

test("before opening or deleting again, the pack waits for the transactions of a connection it closed (WebKit reports blocked otherwise)", async () => {
  const factory = new IDBFactory();
  const log: string[] = [];
  const watched = {
    open: (name: string, version?: number) => {
      log.push(`open ${String(version ?? "")}`);
      const request = factory.open(name, version);
      request.addEventListener("success", () => {
        const database = request.result;
        const transaction = database.transaction.bind(database);
        Reflect.set(database, "transaction", (...args: Parameters<IDBDatabase["transaction"]>) => {
          const made = transaction(...args);
          made.addEventListener("complete", () => log.push("transaction finished"));
          return made;
        });
      });
      return request;
    },
    deleteDatabase: (name: string) => { log.push("delete"); return factory.deleteDatabase(name); },
    databases: () => factory.databases(),
    cmp: (left: unknown, right: unknown) => factory.cmp(left, right),
  };
  const { ask } = tab({ indexedDB: watched });
  assert.deepEqual(await ask(open), { kind: "Opened", version: 1, upgradedFrom: 0, limits, created: true });
  assert.deepEqual(await ask({ ...open, version: 2 }), { kind: "Opened", version: 2, upgradedFrom: 1, limits, created: false });
  assert.deepEqual(await ask({ operation: "deleteDatabase", database: "queue" }), { kind: "DatabaseDeleted" });
  assert.deepEqual(log, ["open 1", "transaction finished", "open 2", "transaction finished", "delete"]);
});
