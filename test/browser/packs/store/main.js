// The IndexedDB store pack's real-browser scenarios. "Tab A" is the page's
// kernel with a scripted engine; "tab B" is a second provider instance with
// its own connection, standing in for another tab of the same origin. The
// page reloads itself once (a runner action) to prove persistence; checks
// made before the reload travel in sessionStorage.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { storeCapability, STORE_CAPABILITY, decodeStoreResult, decodeStoreFact } from "../../../../dist/capabilities/store/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const DB = "limen-smoke";
const offer = { id: STORE_CAPABILITY.id, version: STORE_CAPABILITY.version, fingerprint: STORE_CAPABILITY.fingerprint };
const state = { queued: [], answers: [], waiting: null, sequence: 0, undecodable: 0 };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeStoreResult(outcome.result) : { ok: false };
      if (!decoded.ok) state.undecodable += 1;
      state.answers.push(decoded.ok ? decoded.value : { kind: "Outcome:" + outcome.kind });
      if (state.waiting !== null && state.answers.length >= state.waiting.count) {
        const { resolve } = state.waiting;
        state.waiting = null;
        resolve(state.answers.splice(0));
      }
      return { view: {}, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => {
      state.sequence += 1;
      return { kind: "Capability", correlationId: "store-" + state.sequence, capability: offer.id, version: 1, request };
    });
    state.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};

// Tab A, through the kernel: one request per round trip, in order.
const ask = (request) => new Promise((resolve) => {
  state.queued = [request];
  state.waiting = { count: 1, resolve: ([answer]) => resolve(answer) };
  document.getElementById("poke").click();
});
// Tab B: a second provider with its own connection and its own facts.
const tabBFacts = [];
const tabB = storeCapability();
tabB.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); tabBFacts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
const askB = async (request) => {
  const answer = await tabB.execute(request, { correlationId: "b", signal: new AbortController().signal, document });
  const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : { ok: false };
  return decoded.ok ? decoded.value : { kind: "Undecodable" };
};
const trusted = (action) => new Promise((resolve) => {
  window.__limenPackActionDone = resolve;
  window.__limenPackAction = action;
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const saved = JSON.parse(sessionStorage.getItem("limen-store-checks") ?? "null");
const checks = saved ?? [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

const todos = { name: "todos", keyPath: "id", indexes: [{ name: "byDue", keyPath: "due", unique: false, multiEntry: false }] };
const users = { name: "users", keyPath: "id", indexes: [{ name: "byEmail", keyPath: "email", unique: true, multiEntry: false }] };
const open = (version, stores, dropStores = []) => ({ operation: "open", database: DB, version, stores, dropStores });
const transact = (mode, operations) => ({ operation: "transact", database: DB, mode, operations });

await new BrowserKernel(engine, document, undefined, { capabilities: [storeCapability()], requireHandshake: true }).start();

if (saved === null) {
  await ask({ operation: "deleteDatabase", database: DB });

  // --- Versioned schema ------------------------------------------------------
  const created = await ask(open(1, [todos]));
  expect("a new database is created at the declared version with the declared stores", created.kind === "Opened" && created.version === 1 && created.upgradedFrom === 0, created);

  // --- Atomic transactions --------------------------------------------------
  const committed = await ask(transact("readwrite", [
    { op: "put", store: "todos", value: { id: 1, title: "write tests", due: 3, rev: 1 } },
    { op: "put", store: "todos", value: { id: 2, title: "ship", due: 1, rev: 1 } },
    { op: "put", store: "todos", value: { id: 3, title: "rest", due: 2, rev: 1 } },
    { op: "get", store: "todos", key: 2 },
    { op: "get", store: "todos", key: 99 },
    { op: "query", store: "todos", index: "byDue", limit: 2, reverse: false },
    { op: "delete", store: "todos", key: 3 },
  ]));
  expect("a transaction commits every operation, in order, with typed results", committed.kind === "Committed" && committed.results.map((result) => result.kind).join() === "Put,Put,Put,Found,Missing,Queried,Deleted" && committed.results[3].value.title === "ship" && committed.results[5].values.map((todo) => todo.id).join() === "2,3", committed);

  const aborted = await ask(transact("readwrite", [
    { op: "put", store: "todos", value: { id: 10, title: "never stored", due: 9, rev: 1 } },
    { op: "put", store: "todos", value: { title: "no key" } },
  ]));
  const afterAbort = await ask(transact("readonly", [{ op: "get", store: "todos", key: 10 }]));
  expect("a failing operation aborts the whole transaction: its earlier put is not applied", aborted.kind === "Aborted" && aborted.reason === "invalidKey" && aborted.operation === 1 && afterAbort.results[0].kind === "Missing", { aborted, afterAbort });

  // --- Upgrade, constraint, schema and version conflicts ---------------------
  const upgraded = await ask(open(2, [todos, users]));
  const unique = await ask(transact("readwrite", [
    { op: "put", store: "users", value: { id: "a", email: "same@example.test" } },
    { op: "put", store: "users", value: { id: "b", email: "same@example.test" } },
  ]));
  expect("an upgrade adds the declared store; a unique index violation aborts as constraint", upgraded.kind === "Opened" && upgraded.upgradedFrom === 1 && upgraded.version === 2 && unique.kind === "Aborted" && unique.reason === "constraint" && unique.operation === 1, { upgraded, unique });

  const mismatch = await ask(open(2, [todos]));
  expect("opening the stored version with a different declared schema is SchemaMismatch, naming the difference", mismatch.kind === "SchemaMismatch" && mismatch.problems.join() === "store users is stored but not declared", mismatch);
  const older = await ask(open(1, [todos]));
  expect("opening an older version than the stored one is VersionConflict with the stored version", older.kind === "VersionConflict" && older.stored === 2, older);
  const keyPathChange = await ask(open(3, [{ ...todos, keyPath: "uuid" }, users]));
  expect("an upgrade cannot change a store's keyPath in place: SchemaMismatch, and nothing is upgraded", keyPathChange.kind === "SchemaMismatch" && keyPathChange.problems[0].startsWith("store todos keyPath is id, declared uuid"), keyPathChange);
  const reopened = await ask(open(2, [todos, users]));
  const notOpenAfter = reopened.kind === "Opened" && reopened.version === 2 && reopened.upgradedFrom === 2;
  expect("the failed upgrade left the database at version 2", notOpenAfter, reopened);

  // --- A stale write from another tab ----------------------------------------
  const openedB = await askB(open(2, [todos, users]));
  const readA = await ask(transact("readonly", [{ op: "get", store: "todos", key: 1 }]));
  const seen = readA.results[0].value;
  const writeB = await askB(transact("readwrite", [{ op: "putIf", store: "todos", value: { ...seen, title: "B's edit", rev: 2 }, expected: seen }]));
  const writeA = await ask(transact("readwrite", [{ op: "putIf", store: "todos", value: { ...seen, title: "A's stale edit", rev: 2 }, expected: seen }]));
  const final = await ask(transact("readonly", [{ op: "get", store: "todos", key: 1 }]));
  expect("tab B's compare-and-put against what it read commits", openedB.kind === "Opened" && writeB.kind === "Committed", { openedB, writeB });
  expect("tab A's write based on the same, now stale, read aborts as conflict and reports what is stored", writeA.kind === "Aborted" && writeA.reason === "conflict" && writeA.current?.title === "B's edit" && final.results[0].value.title === "B's edit", { writeA, final });
  const absent = await ask(transact("readwrite", [{ op: "putIf", store: "todos", value: { id: 50, title: "new", due: 5, rev: 1 }, expected: null }, { op: "putIf", store: "todos", value: { id: 50, title: "again", due: 5, rev: 1 }, expected: null }]));
  const fifty = await ask(transact("readonly", [{ op: "get", store: "todos", key: 50 }]));
expect("putIf with expected null inserts only if absent: the second insert conflicts with the first, and both roll back", absent.kind === "Aborted" && absent.reason === "conflict" && absent.operation === 1 && absent.current?.title === "new" && fifty.results[0].kind === "Missing", { absent, fifty });

  // --- Another tab's upgrade: VersionChanged; a holdout: Blocked -------------
  const toThree = await ask(open(3, [todos, users]));
  const changed = tabBFacts.find((fact) => fact.kind === "VersionChanged");
  const staleB = await askB(transact("readonly", [{ op: "get", store: "todos", key: 1 }]));
  expect("tab A's upgrade is not blocked by tab B: B's pack steps aside and reports VersionChanged; B is then NotOpen", toThree.kind === "Opened" && toThree.version === 3 && changed?.newVersion === 3 && staleB.kind === "NotOpen", { toThree, changed, staleB });
  const holdout = await new Promise((resolve) => { const request = indexedDB.open(DB); request.onsuccess = () => resolve(request.result); });
  const blocked = await ask(open(4, [todos, users]));
  holdout.close();
  await sleep(100);
  const stillThree = await ask(open(3, [todos, users]));
  expect("a connection that ignores version changes blocks an upgrade: Blocked, and the abandoned upgrade never applies", blocked.kind === "Blocked" && stillThree.kind === "Opened" && stillThree.version === 3, { blocked, stillThree });

  // Quota is not exercised here: Chromium's DevTools quota override is not
  // enforced for IndexedDB in this browser context (measured: 11 MB committed
  // against a 256 KB override). test/store.test.ts proves the quota outcome
  // through the provider's own code with a scripted IndexedDB; see docs/41.

  // --- Reload ------------------------------------------------------------------
  const persisted = await ask(transact("readwrite", [{ op: "put", store: "todos", value: { id: "persist", title: "survives a reload", due: 0, rev: 1 } }]));
  expect("a record is written before the reload", persisted.kind === "Committed", persisted);
  expect("every answer decoded with the generated decoders (before the reload)", state.undecodable === 0, state.undecodable);
  sessionStorage.setItem("limen-store-checks", JSON.stringify(checks));
  await trusted({ kind: "reload" });
} else {
  sessionStorage.removeItem("limen-store-checks");
  const reopened = await ask(open(3, [todos, users]));
  const read = await ask(transact("readonly", [{ op: "get", store: "todos", key: "persist" }, { op: "get", store: "todos", key: 1 }]));
  expect("after a reload the database reopens at its stored version with its data", reopened.kind === "Opened" && reopened.upgradedFrom === 3 && read.kind === "Committed" && read.results[0].value?.title === "survives a reload" && read.results[1].value?.title === "B's edit", { reopened, read });
  await ask({ operation: "close", database: DB });
  const deleted = await ask({ operation: "deleteDatabase", database: DB });
  expect("the database can be closed and deleted", deleted.kind === "DatabaseDeleted", deleted);
  expect("every answer decoded with the generated decoders (after the reload)", state.undecodable === 0, state.undecodable);
  window.__limenPackResult = { pack: "limen.store", checks };
}
