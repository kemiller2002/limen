// The IndexedDB store pack (kemiller2002/limen#28, LCP-018). The pure rules —
// request validation, schema comparison, keys and JSON equality — are tested
// here without a browser; jsdom has no IndexedDB, which is itself the
// Unavailable case. Real transactions, version and schema conflicts, blocked
// upgrades, quota, stale writes across tabs and reload persistence are proven
// in Chromium (test/browser/packs/store/).

import assert from "node:assert/strict";
import test from "node:test";
import { STORE_CAPABILITY, decodeStoreResult, isKey, jsonEqual, requestProblem, schemaProblems, storeCapability, type StoreRequest, type StoreSchema } from "../dist/capabilities/store/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CorrelationId } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const todos: StoreSchema = { name: "todos", keyPath: "id", indexes: [{ name: "byDue", keyPath: "due", unique: false, multiEntry: false }] };

test("keys are strings, finite numbers or lists of keys; nothing else", () => {
  assert.deepEqual(["a", 1, -2.5, [1, "b", [2]], []].map(isKey), [true, true, true, true, true]);
  assert.deepEqual([null, true, {}, Number.NaN, Infinity, [1, null]].map(isKey), [false, false, false, false, false, false]);
});

test("JSON equality is structural and ignores key order", () => {
  assert.equal(jsonEqual({ id: 1, tags: ["a", { x: null }] }, { tags: ["a", { x: null }], id: 1 }), true);
  assert.equal(jsonEqual({ id: 1 }, { id: 1, extra: undefined }), false);
  assert.equal(jsonEqual([1, 2], [2, 1]), false);
  assert.equal(jsonEqual(null, {}), false);
});

test("requests are validated before touching the database", () => {
  const open = (extra: Partial<Extract<StoreRequest, { operation: "open" }>>): StoreRequest => ({ operation: "open", database: "app", version: 1, stores: [todos], dropStores: [], ...extra });
  const transact = (operations: Extract<StoreRequest, { operation: "transact" }>["operations"], mode: "readonly" | "readwrite" = "readwrite"): StoreRequest => ({ operation: "transact", database: "app", mode, operations });
  assert.equal(requestProblem(open({})), undefined);
  assert.equal(requestProblem(open({ version: 0 })), "version must be a positive integer");
  assert.equal(requestProblem(open({ stores: [todos, todos] })), "store todos is declared twice");
  assert.equal(requestProblem(open({ dropStores: ["todos"] })), "a store cannot be both declared and dropped");
  assert.equal(requestProblem(open({ stores: [{ ...todos, keyPath: "" }] })), "a store needs a name and a keyPath");
  assert.equal(requestProblem(transact([])), "a transaction needs at least one operation");
  assert.equal(requestProblem(transact([{ op: "put", store: "todos", value: { id: 1 } }], "readonly")), "operation 0 writes in a readonly transaction");
  assert.equal(requestProblem(transact([{ op: "get", store: "todos", key: { not: "a key" } }])), "operation 0 has an invalid key");
  assert.equal(requestProblem(transact([{ op: "put", store: "todos", value: [1] }])), "operation 0 value is not a record");
  assert.equal(requestProblem(transact([{ op: "query", store: "todos", limit: 0, reverse: false }])), "operation 0 limit must be 1 to 1000");
  assert.equal(requestProblem(transact([{ op: "query", store: "todos", limit: 5, reverse: false, range: { lowerOpen: false, upperOpen: false } }])), "a range needs a lower or an upper bound");
  assert.equal(requestProblem(transact([{ op: "get", store: "todos", key: "a" }, { op: "query", store: "todos", index: "byDue", limit: 10, reverse: true, range: { lower: 1, lowerOpen: true, upperOpen: false } }], "readonly")), undefined);
});

test("schema comparison names every difference: missing, extra, a changed keyPath, a changed or undeclared index", () => {
  assert.deepEqual(schemaProblems([todos], [todos]), []);
  assert.deepEqual(schemaProblems([todos], []), ["store todos is declared but not stored"]);
  assert.deepEqual(schemaProblems([todos], [todos, { name: "old", keyPath: "id", indexes: [] }]), ["store old is stored but not declared"]);
  assert.deepEqual(schemaProblems([todos], [{ ...todos, keyPath: "uuid" }]), ["store todos keyPath is uuid, declared id"]);
  assert.deepEqual(schemaProblems([todos], [{ ...todos, indexes: [{ name: "byDue", keyPath: "due", unique: true, multiEntry: false }, { name: "byTag", keyPath: "tag", unique: false, multiEntry: true }] }]), [
    "index todos.byDue differs from its declaration",
    "index todos.byTag is stored but not declared",
  ]);
});

const ask = async (request: StoreRequest): Promise<unknown> => withDom("<p>store</p>", async (document) => {
  const answer = await storeCapability().execute(request, { correlationId: "s" as CorrelationId, signal: new AbortController().signal, document });
  const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : undefined;
  assert.ok(decoded?.ok === true, "every result decodes with the generated decoder");
  return decoded.value;
});

test("a context without IndexedDB answers Unavailable; an invalid request is refused first", async () => {
  assert.deepEqual(await ask({ operation: "open", database: "app", version: 1, stores: [todos], dropStores: [] }), { kind: "Unavailable", reason: "unsupported" });
  assert.deepEqual(await ask({ operation: "open", database: "", version: 1, stores: [], dropStores: [] }), { kind: "InvalidRequest", problem: "a database needs a name" });
});

test("the store pack passes the shared provider conformance suite", async () => {
  assert.equal(STORE_CAPABILITY.id, "limen.store");
  await withDom("<p>store</p>", async (document) => {
    assert.deepEqual(await runProviderConformance(storeCapability(), {
      document,
      decodeResult: decodeStoreResult,
      valid: [{ name: "close", payload: { operation: "close", database: "app" } }, { name: "open", payload: { operation: "open", database: "app", version: 1, stores: [], dropStores: [] } }],
      malformed: [
        { name: "no mode", payload: { operation: "transact", database: "app", operations: [] } },
        { name: "unknown op", payload: { operation: "transact", database: "app", mode: "readwrite", operations: [{ op: "clear", store: "todos" }] } },
        { name: "extra", payload: { operation: "close", database: "app", force: true } },
      ],
      cancellable: { name: "close", payload: { operation: "close", database: "app" } },
    }), []);
  });
});

// ---------------------------------------------------------------------------
// A scripted IndexedDB: just enough of one database with one store for the
// provider's own transaction code to meet outcomes a real browser will not
// produce on demand — the quota (Chromium's DevTools quota override is not
// enforced for IndexedDB; see docs/41) and a cancellation mid-transaction.
// ---------------------------------------------------------------------------

type Handler = ((event: { preventDefault(): void }) => void) | null;
type FakeRequest = { result?: unknown; error?: { name: string }; onsuccess: Handler; onerror: Handler; onupgradeneeded?: Handler; onblocked?: Handler; transaction: null };
const names = (list: readonly string[]) => ({ contains: (name: string) => list.includes(name), [Symbol.iterator]: () => list[Symbol.iterator](), length: list.length });
const later = (act: () => void, ms = 1): void => { setTimeout(act, ms); };
const event = { preventDefault: () => {} };

const scriptedIndexedDb = (finish: "commit" | "quota", putDelay = 1) => {
  const rows = new Map<unknown, unknown>();
  const transaction = () => {
    const state = { pending: 0, aborted: false, finished: false };
    const tx: { error: { name: string } | null; oncomplete: (() => void) | null; onabort: (() => void) | null; abort: () => void; objectStore: (name: string) => unknown } = {
      error: null, oncomplete: null, onabort: null,
      abort: () => {
        if (state.finished) throw Object.assign(new Error("finished"), { name: "InvalidStateError" });
        state.aborted = true;
        state.finished = true;
        tx.error ??= { name: "AbortError" };
        later(() => tx.onabort?.());
      },
      objectStore: () => store,
    };
    const settleLater = (): void => later(() => {
      if (state.pending > 0 || state.finished) return;
      state.finished = true;
      if (finish === "quota") { tx.error = { name: "QuotaExceededError" }; tx.onabort?.(); } else tx.oncomplete?.();
    }, 3);
    const request = (produce: () => unknown, delay = 1): FakeRequest => {
      const made: FakeRequest = { onsuccess: null, onerror: null, transaction: null };
      state.pending += 1;
      later(() => {
        state.pending -= 1;
        if (state.aborted) return;
        made.result = produce();
        made.onsuccess?.(event);
        settleLater();
      }, delay);
      return made;
    };
    const store = {
      keyPath: "id", indexNames: names([]),
      get: (key: unknown) => request(() => rows.get(key)),
      put: (value: { id: unknown }) => request(() => { if (finish === "commit") rows.set(value.id, value); return value.id; }, putDelay),
      delete: (key: unknown) => request(() => { rows.delete(key); return undefined; }),
    };
    return tx;
  };
  const database = { version: 1, objectStoreNames: names(["todos"]), transaction, close: () => {}, onversionchange: null };
  return {
    rows,
    open: () => {
      const made: FakeRequest = { onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null, transaction: null };
      later(() => { made.result = database; made.onsuccess?.(event); });
      return made;
    },
  };
};

const plainTodos: StoreSchema = { name: "todos", keyPath: "id", indexes: [] };

const withScripted = async (finish: "commit" | "quota", act: (ask: (request: StoreRequest, signal?: AbortSignal) => Promise<unknown>, rows: Map<unknown, unknown>) => Promise<void>, putDelay = 1): Promise<void> =>
  withDom("<p>store</p>", async (document) => {
    const fake = scriptedIndexedDb(finish, putDelay);
    Reflect.set(document.defaultView ?? {}, "indexedDB", fake);
    const provider = storeCapability();
    const ask = async (request: StoreRequest, signal = new AbortController().signal): Promise<unknown> => {
      const answer = await provider.execute(request, { correlationId: "s" as CorrelationId, signal, document });
      const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true);
      return decoded.value;
    };
    assert.deepEqual(await ask({ operation: "open", database: "app", version: 1, stores: [plainTodos], dropStores: [] }), { kind: "Opened", version: 1, upgradedFrom: 1 });
    await act(ask, fake.rows);
  });

test("a transaction the browser aborts for quota answers Aborted with reason quota and no failing operation (the whole commit failed)", async () => {
  await withScripted("quota", async (ask, rows) => {
    assert.deepEqual(await ask({ operation: "transact", database: "app", mode: "readwrite", operations: [{ op: "put", store: "todos", value: { id: 1, big: "…" } }] }), { kind: "Aborted", reason: "quota" });
    assert.equal(rows.size, 0);
  });
});

test("the same transaction without the quota commits, which is what makes the quota case distinguishable", async () => {
  await withScripted("commit", async (ask, rows) => {
    assert.deepEqual(await ask({ operation: "transact", database: "app", mode: "readwrite", operations: [{ op: "put", store: "todos", value: { id: 1 } }, { op: "get", store: "todos", key: 1 }] }), { kind: "Committed", results: [{ kind: "Put", key: 1 }, { kind: "Found", value: { id: 1 } }] });
    assert.equal(rows.size, 1);
  });
});

test("cancelling a running transaction aborts it: Cancelled, and nothing is applied", async () => {
  await withScripted("commit", async (ask, rows) => {
    const controller = new AbortController();
    const pending = ask({ operation: "transact", database: "app", mode: "readwrite", operations: [{ op: "put", store: "todos", value: { id: 2 } }] }, controller.signal);
    later(() => controller.abort(), 5);
    assert.deepEqual(await pending, { kind: "Cancelled" });
    assert.equal(rows.size, 0);
    assert.deepEqual(await ask({ operation: "transact", database: "app", mode: "readonly", operations: [{ op: "get", store: "nope", key: 1 }] }), { kind: "Aborted", reason: "unknownStore", operation: 0 });
    assert.deepEqual(await ask({ operation: "transact", database: "other", mode: "readonly", operations: [{ op: "get", store: "todos", key: 1 }] }), { kind: "NotOpen" });
  }, 30);
});
