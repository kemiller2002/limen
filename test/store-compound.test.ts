// limen.store version 2: compound key paths (LCP-047), count and deleteRange
// (LCP-054), against a complete in-memory IndexedDB (fake-indexeddb, a dev
// dependency only) in jsdom. The same rules are proven in Chromium by
// test/browser/packs/store-compound/.

import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { decodeStoreResult, requestProblem, schemaProblems, storeCapability, type Operation, type StoreRequest, type StoreSchema } from "../dist/capabilities/store/index.js";
import type { CorrelationId } from "../dist/protocol.js";

const documentOn = (factory: IDBFactory): Document => {
  const dom = new JSDOM("<!doctype html><p>store</p>", { url: "http://localhost/" });
  Reflect.set(dom.window, "indexedDB", factory);
  Reflect.set(dom.window, "IDBKeyRange", IDBKeyRange);
  return dom.window.document;
};

const tab = (factory: IDBFactory, versioned = true): ((request: unknown) => Promise<unknown>) => {
  const document = documentOn(factory);
  const provider = versioned ? storeCapability({ namespace: "app" }) : storeCapability();
  return async (request) => {
    const answer = await provider.execute(request, { correlationId: "s" as CorrelationId, signal: new AbortController().signal, document });
    if (answer.kind === "Rejected") return answer;
    const decoded = decodeStoreResult(answer.result);
    assert.ok(decoded.ok, `every result decodes: ${JSON.stringify(answer)}`);
    return decoded.value;
  };
};

// Entries keyed [namespace, sequence]; a compound unique index on [owner, slot].
const entries: StoreSchema = {
  name: "entries", keyPath: "", keyPaths: ["ns", "seq"],
  indexes: [{ name: "bySlot", keyPath: "", keyPaths: ["owner", "slot"], unique: true, multiEntry: false }, { name: "byOwner", keyPath: "owner", unique: false, multiEntry: false }],
};
const open = (stores: readonly StoreSchema[] = [entries], version = 1): StoreRequest => ({ operation: "open", database: "db", version, stores: [...stores], dropStores: [] });
const transact = (operations: readonly Operation[], mode: "readonly" | "readwrite" = "readwrite"): StoreRequest => ({ operation: "transact", database: "db", mode, operations: [...operations] });
const row = (ns: string, seq: number, owner = "o", slot = seq): Record<string, unknown> => ({ ns, seq, owner, slot });
const seeded = async (): Promise<(request: unknown) => Promise<unknown>> => {
  const ask = tab(new IDBFactory());
  assert.deepEqual(await ask(open()), { kind: "Opened", version: 1, upgradedFrom: 0, limits: { maxValueBytes: 1048576, maxTransactionBytes: 8388608 } });
  const rows = [row("b", 1, "p"), row("a", 10), row("a", 2), row("b", 0, "p"), row("a", 1)];
  const put = await ask(transact(rows.map((value) => ({ op: "put", store: "entries", value }))));
  assert.equal((put as { kind: string }).kind, "Committed");
  return ask;
};
const keys = (result: unknown): string => ((result as { results: { values: { ns: string; seq: number }[] }[] }).results[0]?.values ?? []).map((value) => `${value.ns}${String(value.seq)}`).join(",");

test("LCP-047: a compound-key store returns a put's key as the tuple, gets by tuple, and queries in lexicographic tuple order", async () => {
  const ask = await seeded();
  assert.deepEqual(await ask(transact([{ op: "put", store: "entries", value: row("c", 5, "q") }, { op: "get", store: "entries", key: ["a", 2] }])), {
    kind: "Committed", results: [{ kind: "Put", key: ["c", 5] }, { kind: "Found", value: row("a", 2) }],
  });
  assert.equal(keys(await ask(transact([{ op: "query", store: "entries", limit: 100, reverse: false }], "readonly"))), "a1,a2,a10,b0,b1,c5");
  assert.equal(keys(await ask(transact([{ op: "query", store: "entries", limit: 100, reverse: true }], "readonly"))), "c5,b1,b0,a10,a2,a1");
});

test("LCP-047: a range over a tuple prefix: [ns] to [ns, []] holds every key in that namespace, and nothing else", async () => {
  const ask = await seeded();
  const prefix = { lower: ["a"], upper: ["a", []], lowerOpen: false, upperOpen: false };
  assert.equal(keys(await ask(transact([{ op: "query", store: "entries", range: prefix, limit: 100, reverse: false }], "readonly"))), "a1,a2,a10");
  const after = { lower: ["a", 2], upper: ["a", []], lowerOpen: true, upperOpen: false };
  assert.equal(keys(await ask(transact([{ op: "query", store: "entries", range: after, limit: 100, reverse: false }], "readonly"))), "a10");
});

test("LCP-047: a duplicate tuple in a compound unique index aborts as constraint, and nothing in the transaction is applied", async () => {
  const ask = await seeded();
  assert.deepEqual(await ask(transact([{ op: "put", store: "entries", value: row("z", 1, "solo", 1) }, { op: "put", store: "entries", value: row("z", 2, "p", 1) }])), { kind: "Aborted", reason: "constraint", operation: 1 });
  assert.deepEqual(await ask(transact([{ op: "get", store: "entries", key: ["z", 1] }], "readonly")), { kind: "Committed", results: [{ kind: "Missing" }] });
});

test("LCP-047: a record missing part of a compound key aborts as invalidKey", async () => {
  const ask = await seeded();
  assert.deepEqual(await ask(transact([{ op: "put", store: "entries", value: { ns: "a" } }])), { kind: "Aborted", reason: "invalidKey", operation: 0 });
});

test("LCP-047: a change from a single to a compound key path is SchemaMismatch, at the stored version and as an upgrade", async () => {
  const single: StoreSchema = { name: "entries", keyPath: "ns", indexes: [] };
  const compound: StoreSchema = { name: "entries", keyPath: "", keyPaths: ["ns", "seq"], indexes: [] };
  assert.deepEqual(schemaProblems([compound], [single]), ["store entries keyPath is ns, declared [ns,seq]"]);
  assert.deepEqual(schemaProblems([compound], [compound]), []);
  assert.deepEqual(schemaProblems([{ ...compound, keyPaths: ["seq", "ns"] }], [compound]), ["store entries keyPath is [ns,seq], declared [seq,ns]"]);
  const ask = tab(new IDBFactory());
  await ask(open([single]));
  assert.deepEqual(await ask(open([compound])), { kind: "SchemaMismatch", problems: ["store entries keyPath is ns, declared [ns,seq]"] });
  assert.deepEqual(await ask(open([compound], 2)), { kind: "SchemaMismatch", problems: ["store entries keyPath is ns, declared [ns,seq]; drop it to change it"] });
  assert.deepEqual(await ask(open([single])), { kind: "Opened", version: 1, upgradedFrom: 1, limits: { maxValueBytes: 1048576, maxTransactionBytes: 8388608 } });
});

test("LCP-047: a compound path needs two or more non-empty parts and an empty keyPath; a compound index cannot be multiEntry", () => {
  const openWith = (store: StoreSchema): StoreRequest => ({ operation: "open", database: "db", version: 1, stores: [store], dropStores: [] });
  assert.equal(requestProblem(openWith({ name: "s", keyPath: "", keyPaths: ["only"], indexes: [] })), "store s needs two or more non-empty keyPaths, and an empty keyPath");
  assert.equal(requestProblem(openWith({ name: "s", keyPath: "id", keyPaths: ["a", "b"], indexes: [] })), "store s needs two or more non-empty keyPaths, and an empty keyPath");
  assert.equal(requestProblem(openWith({ name: "s", keyPath: "", keyPaths: ["a", ""], indexes: [] })), "store s needs two or more non-empty keyPaths, and an empty keyPath");
  assert.equal(requestProblem(openWith({ name: "s", keyPath: "id", indexes: [{ name: "i", keyPath: "", keyPaths: ["a"], unique: false, multiEntry: false }] })), "store s has an unnamed, pathless or repeated index");
  assert.equal(requestProblem(openWith({ name: "s", keyPath: "id", indexes: [{ name: "i", keyPath: "", keyPaths: ["a", "b"], unique: false, multiEntry: true }] })), "index s.i is compound and multiEntry; IndexedDB allows only one");
});

test("LCP-054: count agrees with a query of the same range, on the store and on an index; an absent range counts everything", async () => {
  const ask = await seeded();
  const prefix = { lower: ["a"], upper: ["a", []], lowerOpen: false, upperOpen: false };
  const owner = { lower: "p", upper: "p", lowerOpen: false, upperOpen: false };
  assert.deepEqual(await ask(transact([
    { op: "count", store: "entries" },
    { op: "count", store: "entries", range: prefix },
    { op: "query", store: "entries", range: prefix, limit: 1000, reverse: false },
    { op: "count", store: "entries", index: "byOwner", range: owner },
    { op: "count", store: "entries", index: "nope" },
  ], "readonly")), { kind: "Aborted", reason: "unknownStore", operation: 4 });
  const counted = await ask(transact([
    { op: "count", store: "entries" },
    { op: "count", store: "entries", range: prefix },
    { op: "query", store: "entries", range: prefix, limit: 1000, reverse: false },
    { op: "count", store: "entries", index: "byOwner", range: owner },
  ], "readonly")) as { results: { count?: number; values?: unknown[] }[] };
  assert.deepEqual(counted.results.map((result) => result.count ?? result.values?.length), [5, 3, 3, 2]);
});

test("LCP-054: deleteRange removes exactly the range; without a range it clears the store", async () => {
  const ask = await seeded();
  const prefix = { lower: ["a"], upper: ["a", []], lowerOpen: false, upperOpen: false };
  assert.deepEqual(await ask(transact([{ op: "deleteRange", store: "entries", range: prefix }, { op: "count", store: "entries" }])), { kind: "Committed", results: [{ kind: "RangeDeleted" }, { kind: "Counted", count: 2 }] });
  assert.equal(keys(await ask(transact([{ op: "query", store: "entries", limit: 100, reverse: false }], "readonly"))), "b0,b1");
  assert.deepEqual(await ask(transact([{ op: "deleteRange", store: "entries" }, { op: "count", store: "entries" }])), { kind: "Committed", results: [{ kind: "RangeDeleted" }, { kind: "Counted", count: 0 }] });
});

test("LCP-054: deleteRange inside an aborted transaction removes nothing; in a readonly transaction it is refused before anything runs", async () => {
  const ask = await seeded();
  assert.deepEqual(await ask(transact([{ op: "deleteRange", store: "entries" }, { op: "put", store: "entries", value: { ns: "x" } }])), { kind: "Aborted", reason: "invalidKey", operation: 1 });
  assert.deepEqual(await ask(transact([{ op: "count", store: "entries" }], "readonly")), { kind: "Committed", results: [{ kind: "Counted", count: 5 }] });
  assert.deepEqual(await ask(transact([{ op: "deleteRange", store: "entries" }], "readonly")), { kind: "InvalidRequest", problem: "operation 0 writes in a readonly transaction" });
  assert.deepEqual(await ask(transact([{ op: "count", store: "entries", range: { lowerOpen: false, upperOpen: false } }], "readonly")), { kind: "InvalidRequest", problem: "a range needs a lower or an upper bound" });
});

test("a version 1 registration refuses compound key paths, count and deleteRange as malformed, exactly as 0.7.x's decoder did", async () => {
  const ask = tab(new IDBFactory(), false);
  const malformed = { kind: "Rejected", reason: "malformed-request" };
  assert.deepEqual(await ask(open()), malformed);
  assert.deepEqual(await ask(transact([{ op: "count", store: "entries" }], "readonly")), malformed);
  assert.deepEqual(await ask(transact([{ op: "deleteRange", store: "entries" }])), malformed);
  assert.deepEqual(await ask(open([{ name: "plain", keyPath: "id", indexes: [] }])), { kind: "Opened", version: 1, upgradedFrom: 0 });
});
