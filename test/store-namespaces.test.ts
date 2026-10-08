// limen.store version 2 registrations (LCP-043, LCP-048, LCP-050): the
// application namespace and the serialized-size limits, run against a
// complete in-memory IndexedDB (fake-indexeddb, a dev dependency only) in
// jsdom. One IDBFactory stands for one origin; two providers on it are two
// applications, or two tabs, on that origin. The same rules are proven in
// real browsers by test/browser/packs/store-namespaces/.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { DEFAULT_LIMITS, MAX_LIMITS, STORE_CAPABILITY, STORE_CAPABILITY_V1, STORE_CAPABILITY_V2, decodeStoreFact, decodeStoreResult, serializedBytes, storeCapability, storeOptionsProblem, type StoreOptions, type StoreRequest, type StoreSchema } from "../dist/capabilities/store/index.js";
import type { CorrelationId } from "../dist/protocol.js";
import { fingerprintOf } from "../tools/contract-gen/model.ts";

const queue: StoreSchema = { name: "entries", keyPath: "id", indexes: [] };

// A document on an origin whose IndexedDB is `factory`.
const documentOn = (factory: IDBFactory): Document => {
  const dom = new JSDOM("<!doctype html><p>store</p>", { url: "http://localhost/" });
  Reflect.set(dom.window, "indexedDB", factory);
  Reflect.set(dom.window, "IDBKeyRange", IDBKeyRange);
  return dom.window.document;
};

type Tab = { readonly ask: (request: StoreRequest) => Promise<unknown>; readonly facts: unknown[] };

const tab = (factory: IDBFactory, options?: StoreOptions): Tab => {
  const document = documentOn(factory);
  const provider = storeCapability(options);
  const facts: unknown[] = [];
  provider.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
  const ask = async (request: StoreRequest): Promise<unknown> => {
    const answer = await provider.execute(request, { correlationId: "s" as CorrelationId, signal: new AbortController().signal, document });
    const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : undefined;
    assert.ok(decoded?.ok === true, `every result decodes: ${JSON.stringify(answer)}`);
    return decoded.value;
  };
  return { ask, facts };
};

const open = (database: string, version = 1): StoreRequest => ({ operation: "open", database, version, stores: [queue], dropStores: [] });
const put = (database: string, value: Record<string, unknown>): StoreRequest => ({ operation: "transact", database, mode: "readwrite", operations: [{ op: "put", store: "entries", value }] });
const get = (database: string, key: unknown): StoreRequest => ({ operation: "transact", database, mode: "readonly", operations: [{ op: "get", store: "entries", key }] });

test("options: a namespace of letters, digits, '.', '_' or '-'; limits from 1 to the hard maximum", () => {
  assert.equal(storeOptionsProblem({ namespace: "chrona" }), undefined);
  assert.equal(storeOptionsProblem({ namespace: "arca.queue_2-x" }), undefined);
  assert.equal(storeOptionsProblem({ namespace: "a", limits: { maxValueBytes: MAX_LIMITS.maxValueBytes, maxTransactionBytes: 1 } }), undefined);
  ["", "a/b", "-lead", "has space", "x".repeat(65)].forEach((namespace) => assert.match(storeOptionsProblem({ namespace }) ?? "", /^namespace must be/, namespace));
  assert.equal(storeOptionsProblem({ namespace: "a", limits: { maxValueBytes: MAX_LIMITS.maxValueBytes + 1 } }), "maxValueBytes must be an integer from 1 to 16777216");
  assert.equal(storeOptionsProblem({ namespace: "a", limits: { maxTransactionBytes: 0 } }), "maxTransactionBytes must be an integer from 1 to 67108864");
  assert.equal(storeOptionsProblem({ namespace: "a", limits: { maxValueBytes: 1.5 } }), "maxValueBytes must be an integer from 1 to 16777216");
  assert.deepEqual(DEFAULT_LIMITS, { maxValueBytes: 1048576, maxTransactionBytes: 8388608 });
});

test("backward compatibility: storeCapability() still offers limen.store version 1 with 0.7.x's fingerprint, recomputed from the frozen 0.7.1 contract", async () => {
  const frozen: unknown = JSON.parse(await readFile(new URL("../contract/frozen/store.v1.contract.json", import.meta.url), "utf8"));
  assert.equal(fingerprintOf(frozen), STORE_CAPABILITY_V1.fingerprint);
  assert.deepEqual(STORE_CAPABILITY, STORE_CAPABILITY_V1);
  assert.deepEqual(storeCapability().descriptor, { id: "limen.store", version: 1, fingerprint: STORE_CAPABILITY_V1.fingerprint });
  assert.deepEqual(storeCapability({ namespace: "app" }).descriptor, { ...STORE_CAPABILITY_V2 });
  assert.equal(STORE_CAPABILITY_V2.version, 2);
  assert.notEqual(STORE_CAPABILITY_V2.fingerprint, STORE_CAPABILITY_V1.fingerprint);
});

test("a version 1 registration behaves as 0.7.x: the engine's name is the browser's name, and Opened carries no limits", async () => {
  const origin = new IDBFactory();
  const legacy = tab(origin);
  assert.deepEqual(await legacy.ask(open("queue")), { kind: "Opened", version: 1, upgradedFrom: 0 });
  assert.deepEqual((await origin.databases()).map((info) => info.name), ["queue"]);
});

test("LCP-048: two applications on one origin, namespaces a and b, each open 'queue'; neither sees the other's writes, and b's delete leaves a's database intact", async () => {
  const origin = new IDBFactory();
  const a = tab(origin, { namespace: "a" });
  const b = tab(origin, { namespace: "b" });
  assert.deepEqual(await a.ask(open("queue")), { kind: "Opened", version: 1, upgradedFrom: 0, limits: DEFAULT_LIMITS });
  assert.deepEqual(await b.ask(open("queue")), { kind: "Opened", version: 1, upgradedFrom: 0, limits: DEFAULT_LIMITS });
  assert.deepEqual(await a.ask(put("queue", { id: 1, from: "a" })), { kind: "Committed", results: [{ kind: "Put", key: 1 }] });
  assert.deepEqual(await b.ask(get("queue", 1)), { kind: "Committed", results: [{ kind: "Missing" }] });
  assert.deepEqual(await a.ask(get("queue", 1)), { kind: "Committed", results: [{ kind: "Found", value: { id: 1, from: "a" } }] });
  assert.deepEqual(await b.ask({ operation: "deleteDatabase", database: "queue" }), { kind: "DatabaseDeleted" });
  assert.deepEqual((await origin.databases()).map((info) => info.name), ["a/queue"]);
  assert.deepEqual(await a.ask(get("queue", 1)), { kind: "Committed", results: [{ kind: "Found", value: { id: 1, from: "a" } }] });
});

test("LCP-048: the engine never names or sees the physical name; another tab's upgrade is reported under the engine's own name", async () => {
  const origin = new IDBFactory();
  const first = tab(origin, { namespace: "app" });
  const second = tab(origin, { namespace: "app" });
  await first.ask(open("queue"));
  assert.deepEqual(await second.ask(open("queue", 2)), { kind: "Opened", version: 2, upgradedFrom: 1, limits: DEFAULT_LIMITS });
  assert.deepEqual(first.facts, [{ kind: "VersionChanged", database: "queue", newVersion: 2 }]);
  assert.deepEqual(await first.ask(open("app/queue")), { kind: "InvalidRequest", problem: 'a database name may not contain "/" (the namespace separator)' });
  assert.deepEqual(await first.ask({ operation: "deleteDatabase", database: "../queue" }), { kind: "InvalidRequest", problem: 'a database name may not contain "/" (the namespace separator)' });
  assert.deepEqual(await first.ask({ operation: "close", database: "" }), { kind: "InvalidRequest", problem: "a database needs a name" });
  assert.deepEqual((await origin.databases()).map((info) => info.name), ["app/queue"]);
});

// A record whose UTF-8 JSON is exactly `bytes` long: {"id":1,"pad":"…"}.
const sized = (bytes: number): Record<string, unknown> => ({ id: 1, pad: "x".repeat(bytes - serializedBytes({ id: 1, pad: "" })) });

test("LCP-050: a value at limit-1 and at the limit commits; at limit+1 it is InvalidRequest and the database is unchanged", async () => {
  const limits = { maxValueBytes: 64, maxTransactionBytes: 4096 };
  const app = tab(new IDBFactory(), { namespace: "app", limits });
  assert.deepEqual(await app.ask(open("db")), { kind: "Opened", version: 1, upgradedFrom: 0, limits });
  assert.equal(serializedBytes(sized(64)), 64);
  assert.deepEqual(await app.ask(put("db", sized(63))), { kind: "Committed", results: [{ kind: "Put", key: 1 }] });
  assert.deepEqual(await app.ask(put("db", sized(64))), { kind: "Committed", results: [{ kind: "Put", key: 1 }] });
  assert.deepEqual(await app.ask(put("db", { ...sized(65), id: 1 })), { kind: "InvalidRequest", problem: "operation 0 value is 65 bytes, over the limit of 64" });
  assert.deepEqual(await app.ask(get("db", 1)), { kind: "Committed", results: [{ kind: "Found", value: sized(64) }] });
});

test("LCP-050: a transaction whose operations together exceed the limit is InvalidRequest, and nothing in it is applied", async () => {
  const app = tab(new IDBFactory(), { namespace: "app", limits: { maxValueBytes: 64, maxTransactionBytes: 200 } });
  await app.ask(open("db"));
  const operations = [1, 2, 3, 4].map((id) => ({ op: "put" as const, store: "entries", value: { id, pad: "x".repeat(20) } }));
  const total = operations.reduce((sum, operation) => sum + serializedBytes(operation), 0);
  assert.ok(total > 200);
  assert.deepEqual(await app.ask({ operation: "transact", database: "db", mode: "readwrite", operations }), { kind: "InvalidRequest", problem: `the transaction is ${String(total)} bytes, over the limit of 200` });
  assert.deepEqual(await app.ask({ operation: "transact", database: "db", mode: "readwrite", operations: operations.slice(0, 2) }), { kind: "Committed", results: [{ kind: "Put", key: 1 }, { kind: "Put", key: 2 }] });
  assert.deepEqual(await app.ask(get("db", 3)), { kind: "Committed", results: [{ kind: "Missing" }] });
});

test("LCP-050: the default limits apply when none are given; a host's invalid options make every request InvalidRequest, never a silent default", async () => {
  const app = tab(new IDBFactory(), { namespace: "app" });
  await app.ask(open("db"));
  const big = sized(DEFAULT_LIMITS.maxValueBytes + 1);
  assert.deepEqual(await app.ask(put("db", big)), { kind: "InvalidRequest", problem: `operation 0 value is ${String(DEFAULT_LIMITS.maxValueBytes + 1)} bytes, over the limit of ${String(DEFAULT_LIMITS.maxValueBytes)}` });
  const broken = tab(new IDBFactory(), { namespace: "no/slash" });
  assert.deepEqual(await broken.ask(open("db")), { kind: "InvalidRequest", problem: "the host registered the store pack with invalid options: namespace must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit" });
});
