// limen.store version 2 in a real browser: compound key paths (LCP-047),
// count and deleteRange (LCP-054). A provider registered with a namespace,
// driven directly; version 2 negotiation through the kernel is proven by the
// store-namespaces page.
import { storeCapability, decodeStoreResult } from "../../../../dist/capabilities/store/index.js";

const provider = storeCapability({ namespace: "compound" });
const state = { undecodable: 0 };
const ask = async (request) => {
  const answer = await provider.execute(request, { correlationId: "c", signal: new AbortController().signal, document });
  const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : { ok: false };
  if (!decoded.ok) state.undecodable += 1;
  return decoded.ok ? decoded.value : { kind: "Undecodable", answer };
};
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

const entries = {
  name: "entries", keyPath: "", keyPaths: ["ns", "seq"],
  indexes: [{ name: "bySlot", keyPath: "", keyPaths: ["owner", "slot"], unique: true, multiEntry: false }, { name: "byOwner", keyPath: "owner", unique: false, multiEntry: false }],
};
const single = { name: "entries", keyPath: "ns", indexes: [] };
const open = (stores, version = 1, database = "db") => ({ operation: "open", database, version, stores, dropStores: [] });
const transact = (operations, mode = "readwrite") => ({ operation: "transact", database: "db", mode, operations });
const row = (ns, seq, owner = "o", slot = seq) => ({ ns, seq, owner, slot });
const keys = (result) => (result.results?.[0]?.values ?? []).map((value) => value.ns + value.seq).join(",");
const prefix = { lower: ["a"], upper: ["a", []], lowerOpen: false, upperOpen: false };

await ask({ operation: "deleteDatabase", database: "db" });
await ask({ operation: "deleteDatabase", database: "single" });
const opened = await ask(open([entries]));
const seeded = await ask(transact([row("b", 1, "p"), row("a", 10), row("a", 2), row("b", 0, "p"), row("a", 1)].map((value) => ({ op: "put", store: "entries", value }))));
expect("a compound-key store is created, and a put's key is the tuple", opened.kind === "Opened" && seeded.kind === "Committed" && JSON.stringify(seeded.results[0].key) === '["b",1]', { opened, seeded });

const ordered = await ask(transact([{ op: "query", store: "entries", limit: 100, reverse: false }], "readonly"));
const byTuple = await ask(transact([{ op: "get", store: "entries", key: ["a", 2] }], "readonly"));
expect("records come back in lexicographic tuple order (numbers compared as numbers), and a get by tuple finds one", keys(ordered) === "a1,a2,a10,b0,b1" && byTuple.results[0].value?.seq === 2, { ordered: keys(ordered), byTuple });

const inPrefix = await ask(transact([{ op: "query", store: "entries", range: prefix, limit: 100, reverse: false }], "readonly"));
expect("a range from [ns] to [ns, []] holds exactly that namespace's keys", keys(inPrefix) === "a1,a2,a10", keys(inPrefix));

const unique = await ask(transact([{ op: "put", store: "entries", value: row("z", 1, "solo", 1) }, { op: "put", store: "entries", value: row("z", 2, "p", 1) }]));
const noZ = await ask(transact([{ op: "count", store: "entries", range: { lower: ["z"], upper: ["z", []], lowerOpen: false, upperOpen: false } }], "readonly"));
expect("a duplicate tuple in a compound unique index aborts as constraint; nothing is applied", unique.kind === "Aborted" && unique.reason === "constraint" && unique.operation === 1 && noZ.results?.[0]?.count === 0, { unique, noZ });

const counted = await ask(transact([
  { op: "count", store: "entries" },
  { op: "count", store: "entries", range: prefix },
  { op: "query", store: "entries", range: prefix, limit: 1000, reverse: false },
  { op: "count", store: "entries", index: "byOwner", range: { lower: "p", upper: "p", lowerOpen: false, upperOpen: false } },
], "readonly"));
expect("count agrees with a query of the same range, on the store and on an index", counted.kind === "Committed" && counted.results[0].count === 5 && counted.results[1].count === 3 && counted.results[2].values.length === 3 && counted.results[3].count === 2, counted);

const abortedDelete = await ask(transact([{ op: "deleteRange", store: "entries" }, { op: "put", store: "entries", value: { ns: "x" } }]));
const stillFive = await ask(transact([{ op: "count", store: "entries" }], "readonly"));
expect("deleteRange in an aborted transaction removes nothing", abortedDelete.kind === "Aborted" && abortedDelete.operation === 1 && stillFive.results[0].count === 5, { abortedDelete, stillFive });

const deleted = await ask(transact([{ op: "deleteRange", store: "entries", range: prefix }, { op: "count", store: "entries" }]));
const left = await ask(transact([{ op: "query", store: "entries", limit: 100, reverse: false }], "readonly"));
const cleared = await ask(transact([{ op: "deleteRange", store: "entries" }, { op: "count", store: "entries" }]));
expect("deleteRange removes exactly the range; without a range it clears the store", deleted.kind === "Committed" && deleted.results[1].count === 2 && keys(left) === "b0,b1" && cleared.results[1].count === 0, { deleted, left: keys(left), cleared });

await ask({ operation: "close", database: "db" });
const singleOpened = await ask(open([single], 1, "single"));
const toCompound = await ask(open([{ ...entries, indexes: [] }], 1, "single"));
const upgradeTo = await ask(open([{ ...entries, indexes: [] }], 2, "single"));
expect("a change from a single to a compound key path is SchemaMismatch, at the stored version and as an upgrade", singleOpened.kind === "Opened" && toCompound.kind === "SchemaMismatch" && toCompound.problems[0] === "store entries keyPath is ns, declared [ns,seq]" && upgradeTo.kind === "SchemaMismatch", { toCompound, upgradeTo });

await ask({ operation: "deleteDatabase", database: "db" });
await ask({ operation: "deleteDatabase", database: "single" });
expect("every answer decoded with the generated decoders", state.undecodable === 0, state.undecodable);
window.__limenPackResult = { pack: "limen.store (compound keys, count, deleteRange)", checks };
