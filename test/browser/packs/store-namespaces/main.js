// limen.store version 2 in a real browser (LCP-048, LCP-050). The page's
// kernel registers the pack with namespace "a" and small size limits, and its
// scripted engine negotiates version 2. Two more providers on the same origin
// stand in for another application (namespace "b") and a second tab of the
// same application (namespace "a").
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { storeCapability, STORE_CAPABILITY_V2, decodeStoreResult, decodeStoreFact } from "../../../../dist/capabilities/store/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const LIMITS = { maxValueBytes: 64, maxTransactionBytes: 4096 };
const offer = { id: STORE_CAPABILITY_V2.id, version: STORE_CAPABILITY_V2.version, fingerprint: STORE_CAPABILITY_V2.fingerprint };
const state = { queued: [], waiting: null, sequence: 0, undecodable: 0, facts: [] };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "CapabilityFact") {
      const decoded = decodeStoreFact(message.fact);
      state.facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" });
      return { view: {}, effects: [], cancellations: [] };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeStoreResult(outcome.result) : { ok: false };
      if (!decoded.ok) state.undecodable += 1;
      const waiting = state.waiting;
      state.waiting = null;
      waiting?.(decoded.ok ? decoded.value : { kind: "Outcome:" + outcome.kind });
      return { view: {}, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => {
      state.sequence += 1;
      return { kind: "Capability", correlationId: "ns-" + state.sequence, capability: offer.id, version: offer.version, request };
    });
    state.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};

// Application a, tab 1: through the kernel, one request per round trip.
const ask = (request) => new Promise((resolve) => {
  state.queued = [request];
  state.waiting = resolve;
  document.getElementById("poke").click();
});
const direct = (options) => {
  const facts = [];
  const provider = storeCapability(options);
  provider.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
  const send = async (request) => {
    const answer = await provider.execute(request, { correlationId: "d", signal: new AbortController().signal, document });
    const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : { ok: false };
    return decoded.ok ? decoded.value : { kind: "Undecodable" };
  };
  return { send, facts };
};
const appB = direct({ namespace: "b" });
const tabA2 = direct({ namespace: "a", limits: LIMITS });

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const schema = [{ name: "entries", keyPath: "id", indexes: [] }];
const open = (version = 1) => ({ operation: "open", database: "queue", version, stores: schema, dropStores: [] });
const put = (value) => ({ operation: "transact", database: "queue", mode: "readwrite", operations: [{ op: "put", store: "entries", value }] });
const get = (key) => ({ operation: "transact", database: "queue", mode: "readonly", operations: [{ op: "get", store: "entries", key }] });
const names = async () => (await indexedDB.databases()).map((info) => info.name).filter((name) => name === "queue" || name.endsWith("/queue")).sort();
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const sized = (size) => ({ id: 1, pad: "x".repeat(size - bytes({ id: 1, pad: "" })) });

await new BrowserKernel(engine, document, undefined, { capabilities: [storeCapability({ namespace: "a", limits: LIMITS })], requireHandshake: true }).start();

await ask({ operation: "deleteDatabase", database: "queue" });
await appB.send({ operation: "deleteDatabase", database: "queue" });

const openedA = await ask(open());
const openedB = await appB.send(open());
expect("version 2 negotiated: Opened reports the limits in force (the registered ones for a, the defaults for b)", openedA.kind === "Opened" && openedA.limits?.maxValueBytes === 64 && openedB.limits?.maxValueBytes === 1048576 && openedB.limits?.maxTransactionBytes === 8388608, { openedA, openedB });
expect("each application's database is stored under its namespace", JSON.stringify(await names()) === JSON.stringify(["a/queue", "b/queue"]), await names());

const wrote = await ask(put({ id: 1, from: "a" }));
const inB = await appB.send(get(1));
const inA = await ask(get(1));
expect("a write in namespace a is invisible in namespace b", wrote.kind === "Committed" && inB.results?.[0]?.kind === "Missing" && inA.results?.[0]?.value?.from === "a", { wrote, inB, inA });

const deletedB = await appB.send({ operation: "deleteDatabase", database: "queue" });
const stillA = await ask(get(1));
expect("b's deleteDatabase removes only b's database; a's data is intact", deletedB.kind === "DatabaseDeleted" && stillA.results?.[0]?.value?.from === "a" && JSON.stringify(await names()) === JSON.stringify(["a/queue"]), { deletedB, stillA, names: await names() });

const outside = await ask({ operation: "deleteDatabase", database: "b/queue" });
expect("a name containing the namespace separator is InvalidRequest before anything is touched", outside.kind === "InvalidRequest" && outside.problem.includes("namespace separator"), outside);

const atLimit = await ask(put(sized(64)));
const overLimit = await ask(put(sized(65)));
const afterOver = await ask(get(1));
expect("a value at the limit commits; one byte over is InvalidRequest and the stored value is unchanged", atLimit.kind === "Committed" && overLimit.kind === "InvalidRequest" && overLimit.problem === "operation 0 value is 65 bytes, over the limit of 64" && bytes(afterOver.results?.[0]?.value) === 64, { atLimit, overLimit, afterOver });

const upgraded = await tabA2.send(open(2));
await new Promise((resolve) => setTimeout(resolve, 50));
const notOpen = await ask(get(1));
const changed = state.facts.find((fact) => fact.kind === "VersionChanged");
expect("a second tab's upgrade reaches the first engine as VersionChanged under its own name, never the physical one; it is then NotOpen", upgraded.kind === "Opened" && upgraded.version === 2 && changed?.database === "queue" && changed?.newVersion === 2 && notOpen.kind === "NotOpen", { upgraded, changed, notOpen });

await tabA2.send({ operation: "close", database: "queue" });
const cleaned = await ask({ operation: "deleteDatabase", database: "queue" });
expect("the namespace's database can be deleted", cleaned.kind === "DatabaseDeleted" && (await names()).length === 0, { cleaned, names: await names() });
expect("every answer decoded with the generated decoders", state.undecodable === 0, state.undecodable);
window.__limenPackResult = { pack: "limen.store (namespaces and limits)", checks };
