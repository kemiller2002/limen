// The TypeScript store pack against the shared vectors (LCP-075), under node:
// a complete in-memory IndexedDB (fake-indexeddb, dev only) per origin, with
// every fault the vectors name injected around it. The same runner runs the
// same vectors in Chromium (test/browser/packs/store-conformance/).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IDBFactory, IDBKeyRange, forceCloseDatabase } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { decodeStoreFact, decodeStoreResult, storeCapability } from "../dist/capabilities/store/index.js";
import type { CorrelationId } from "../dist/protocol.js";
import { kindsExpected, namespaceOf, optionsOf, runStoreVectors } from "./browser/packs/store-conformance/runner.js";

type Vector = { readonly name: string; readonly requires?: readonly string[]; readonly tabs?: Record<string, { readonly app: string }>; readonly registration?: { readonly limits?: unknown }; readonly steps: readonly Record<string, unknown>[] };
type Vectors = { readonly unit: string; readonly version: number; readonly requirements: Record<string, string>; readonly vectors: readonly Vector[] };
type Handler = ((event: unknown) => void) | null;

const vectors = JSON.parse(await readFile(new URL("../conformance/store/store.vectors.json", import.meta.url), "utf8")) as Vectors;
const contract = JSON.parse(await readFile(new URL("../contract/store.contract.json", import.meta.url), "utf8")) as { readonly version: number; readonly types: readonly { readonly name: string; readonly variants?: readonly { readonly name: string }[] }[] };

// Binds a target's methods so fake-indexeddb sees its own objects, while the
// proxy may override chosen properties.
const proxy = <T extends object>(target: T, overrides: (key: PropertyKey) => { readonly value: unknown } | undefined): T => new Proxy(target, {
  get: (object, key) => {
    const override = overrides(key);
    if (override !== undefined) return override.value;
    const value: unknown = Reflect.get(object, key, object);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value;
  },
  set: (object, key, value) => Reflect.set(object, key, value, object),
});

// A transaction that runs every operation and then fails at commit with
// QuotaExceededError, as a browser does when the commit exceeds quota. Its
// requests are counted: when a success handler returns without starting
// another request, the provider has nothing more to run, so the commit
// starts now, and the transaction is aborted instead. (Cursor continuation
// is not tracked; the quota vector uses puts.)
const quotaTransaction = (transaction: IDBTransaction): IDBTransaction => {
  const state = { pending: 0, fired: false };
  const track = (request: IDBRequest): IDBRequest => {
    state.pending += 1;
    const wrapped: { onsuccess: Handler } = { onsuccess: null };
    request.onsuccess = (event) => {
      state.pending -= 1;
      wrapped.onsuccess?.(event);
      if (state.pending === 0 && !state.fired) { state.fired = true; transaction.abort(); }
    };
    return new Proxy(request, {
      get: (object, key) => { const value: unknown = Reflect.get(object, key, object); return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(object) : value; },
      set: (object, key, value) => (key === "onsuccess" ? Reflect.set(wrapped, key, value) : Reflect.set(object, key, value, object)),
    });
  };
  const store = (name: string): IDBObjectStore => {
    const real = transaction.objectStore(name);
    const requesting = (method: "get" | "put" | "delete" | "count" | "clear") => (...args: unknown[]): IDBRequest => track((real[method] as (...rest: unknown[]) => IDBRequest).apply(real, args));
    return proxy(real, (key) => (key === "get" || key === "put" || key === "delete" || key === "count" || key === "clear" ? { value: requesting(key) } : undefined));
  };
  return proxy(transaction, (key) => {
    if (key === "objectStore") return { value: store };
    if (key === "error") return { value: state.fired ? { name: "QuotaExceededError" } : transaction.error };
    return undefined;
  });
};

type Faults = { quota: boolean; openFails: string | undefined };

// One origin: one in-memory IndexedDB that every tab shares.
const origin = (vector: Vector, index: number) => {
  const factory = new IDBFactory();
  const connections: IDBDatabase[] = [];
  const holdouts = new Map<string, IDBDatabase>();
  const tabs = new Map<string, { readonly ask: (request: unknown, options: { cancelled: boolean }) => Promise<unknown>; readonly facts: unknown[]; readonly faults: Faults; readonly document: Document }>();
  const storagePresent = vector.requires?.includes("storage:present") === true;

  // Each tab's view of the shared IndexedDB, with its own armed faults.
  const tabFactory = (faults: Faults): unknown => ({
    open: (name: string, version?: number) => {
      if (faults.openFails !== undefined) {
        const error = { name: faults.openFails };
        faults.openFails = undefined;
        const failing: { error: unknown; result: undefined; transaction: null; onerror: Handler; onsuccess: Handler; onupgradeneeded: Handler; onblocked: Handler } = { error, result: undefined, transaction: null, onerror: null, onsuccess: null, onupgradeneeded: null, onblocked: null };
        setTimeout(() => failing.onerror?.({ preventDefault: () => {} }), 1);
        return failing;
      }
      const request = factory.open(name, version);
      request.addEventListener("success", () => connections.push(request.result));
      return proxy(request, (key) => {
        if (key !== "result") return undefined;
        const database = request.result;
        return { value: proxy(database, (inner) => (inner === "transaction" ? { value: (...args: unknown[]) => {
          const transaction = (database.transaction as (...rest: unknown[]) => IDBTransaction).apply(database, args);
          if (!faults.quota) return transaction;
          faults.quota = false;
          return quotaTransaction(transaction);
        } } : undefined)) };
      });
    },
    deleteDatabase: (name: string) => factory.deleteDatabase(name),
    databases: () => factory.databases(),
    cmp: (left: unknown, right: unknown) => factory.cmp(left, right),
  });

  const tab = (name: string) => {
    const existing = tabs.get(name);
    if (existing !== undefined) return existing;
    const dom = new JSDOM("<!doctype html><p>store</p>", { url: "http://localhost/" });
    const faults: Faults = { quota: false, openFails: undefined };
    Reflect.set(dom.window, "indexedDB", tabFactory(faults));
    Reflect.set(dom.window, "IDBKeyRange", IDBKeyRange);
    if (storagePresent) Object.defineProperty(dom.window.navigator, "storage", { configurable: true, value: { persist: async () => true, persisted: async () => false, estimate: async () => ({ usage: 4096, quota: 1073741824 }) } });
    const document = dom.window.document;
    const provider = storeCapability(optionsOf("v", index, vector, name));
    const facts: unknown[] = [];
    provider.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
    const ask = async (request: unknown, options: { cancelled: boolean }): Promise<unknown> => {
      const controller = new AbortController();
      if (options.cancelled) controller.abort();
      const answer = await provider.execute(request, { correlationId: "v" as CorrelationId, signal: controller.signal, document });
      if (answer.kind !== "Completed") return answer;
      const decoded = decodeStoreResult(answer.result);
      return decoded.ok ? decoded.value : { kind: "Undecodable", result: answer.result };
    };
    const made = { ask, facts, faults, document };
    tabs.set(name, made);
    return made;
  };

  return {
    tab,
    inject: async (step: { readonly inject: string; readonly tab: string; readonly error?: string }): Promise<void> => {
      const target = tab(step.tab);
      switch (step.inject) {
        case "quota": target.faults.quota = true; return;
        case "openFails": target.faults.openFails = step.error ?? "UnknownError"; return;
        case "missing": Reflect.deleteProperty(target.document.defaultView ?? {}, "indexedDB"); return;
        case "storageCleared": {
          connections.forEach((database) => forceCloseDatabase(database));
          await new Promise((resolve) => setTimeout(resolve, 5));
          const names = (await factory.databases()).map((info) => info.name ?? "");
          await Promise.all(names.map((name) => new Promise((resolve) => { const deleting = factory.deleteDatabase(name); deleting.onsuccess = resolve; deleting.onerror = resolve; })));
          return;
        }
        default: throw new Error(`unknown injection ${step.inject}`);
      }
    },
    holdOpen: (database: string, tabName: string): Promise<void> => new Promise((resolve) => {
      const request = factory.open(`${namespaceOf("v", index, vector, tabName)}/${database}`);
      request.onsuccess = () => { holdouts.set(database, request.result); resolve(); };
    }),
    release: async (database: string): Promise<void> => { holdouts.get(database)?.close(); holdouts.delete(database); await new Promise((resolve) => setTimeout(resolve, 20)); },
    dispose: async (): Promise<void> => { holdouts.forEach((database) => database.close()); },
  };
};

const environment = {
  supports: new Set(["holdOpen", "inject:quota", "inject:openFails", "inject:storageCleared", "inject:missing", "storage:present", "storage:absent"]),
  origin: async (vector: Vector, index: number) => origin(vector, index),
};

test("the vector set targets limen.store at the contract's version, and every requirement it names is described", () => {
  assert.equal(vectors.unit, "limen.store");
  assert.equal(vectors.version, contract.version);
  const named = new Set(vectors.vectors.flatMap((vector) => vector.requires ?? []));
  assert.deepEqual([...named].filter((requirement) => !(requirement in vectors.requirements)), []);
});

test("LCP-075: every StoreResult and StoreFact variant is expected by at least one vector", () => {
  const variants = contract.types.filter((type) => type.name === "StoreResult" || type.name === "StoreFact").flatMap((type) => (type.variants ?? []).map((variant) => variant.name));
  const expected = kindsExpected(vectors.vectors);
  assert.deepEqual(variants.filter((variant) => !expected.has(variant)), []);
});

test("LCP-075: the TypeScript pack passes every store vector under node, with every fault injected; none is unsupported here", async () => {
  const outcome = await runStoreVectors(vectors.vectors, environment);
  const failures = outcome.results.filter((result) => result.status !== "passed").map((result) => `${result.status}: ${result.name} — ${result.detail}`);
  assert.deepEqual(failures, []);
  assert.equal(outcome.passed, vectors.vectors.length);
  console.log(`store vectors under node: ${String(outcome.passed)} passed, ${String(outcome.failed)} failed, ${String(outcome.unsupported)} unsupported`);
});

test("the runner is not vacuous: a wrong expectation fails, and a requirement the environment lacks is unsupported, never passed", async () => {
  const [first] = vectors.vectors;
  assert.ok(first !== undefined);
  const wrong: Vector = { ...first, name: "wrong", steps: first.steps.map((step, index) => (index === 0 ? { ...step, expect: { kind: "Blocked" } } : step)) };
  const lacking: Vector = { ...first, name: "lacking", requires: ["inject:teleport"] };
  const outcome = await runStoreVectors([wrong, lacking], environment);
  assert.deepEqual(outcome.results.map((result) => result.status), ["failed", "unsupported"]);
  assert.deepEqual([outcome.passed, outcome.failed, outcome.unsupported], [0, 1, 1]);
});
