// The store pack's LCP-078 rows, through the real kernel and the JSON
// boundary every WebAssembly transport pays: the engine's messages are
// serialized and parsed both ways and strictly decoded with the generated
// codecs, as bench/pages/bench.ts's json boundary and the .NET and Rust
// transports do. Each sample runs from the engine's request (a DOM event that
// makes the engine emit the effect) to its decoded result in the engine, so it
// is the cost an engine sees. Plain JavaScript: no build step.
import { BrowserKernel } from "../../../dist/kernel/browser-kernel.js";
import { decodeEngineResponse } from "../../../dist/hosts/dotnet-wasm-transport.js";
import { storeCapability, STORE_CAPABILITY_V2, decodeStoreResult } from "../../../dist/capabilities/store/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../dist/protocol.js";

const offer = { id: STORE_CAPABILITY_V2.id, version: STORE_CAPABILITY_V2.version, fingerprint: STORE_CAPABILITY_V2.fingerprint };
const state = { queued: null, waiting: null, sequence: 0 };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeStoreResult(outcome.result) : { ok: false };
      const waiting = state.waiting;
      state.waiting = null;
      waiting?.(decoded.ok ? decoded.value : { kind: "Undecodable" });
      return { view: {}, effects: [], cancellations: [] };
    }
    const request = state.queued;
    state.queued = null;
    state.sequence += 1;
    return { view: {}, effects: request === null ? [] : [{ kind: "Capability", correlationId: "s" + state.sequence, capability: offer.id, version: offer.version, request }], cancellations: [] };
  },
};

// The WebAssembly boundary without a WebAssembly runtime (bench/pages/bench.ts).
const jsonBoundary = (inner) => ({
  start: () => inner.start(),
  dispatch: async (message) => decodeEngineResponse(JSON.stringify(await inner.dispatch(JSON.parse(JSON.stringify(message)))), "bench"),
});

const ask = (request) => new Promise((resolve) => {
  state.queued = request;
  state.waiting = resolve;
  document.getElementById("poke").click();
});

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
const round = (value) => Math.round(value * 1000) / 1000;
const summarize = (samples) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return { n: sorted.length, median: round(quantile(sorted, 0.5)), p95: round(quantile(sorted, 0.95)), min: round(sorted[0]), max: round(sorted.at(-1)) };
};
const expectKind = (result, kind, what) => { if (result.kind !== kind) throw new Error(`${what}: expected ${kind}, got ${JSON.stringify(result).slice(0, 200)}`); return result; };
// Timed samples of an async step, after setup that is not timed.
const sample = async (count, setup, step) => {
  const times = [];
  for (let index = 0; index < count; index += 1) {
    await setup(index);
    const started = performance.now();
    await step(index);
    times.push(performance.now() - started);
  }
  return summarize(times);
};

const stores = ["a", "b", "c", "d", "e"].map((name) => ({ name, keyPath: "id", indexes: name === "a" ? [{ name: "byAt", keyPath: "at", unique: false, multiEntry: false }] : [] }));
const open = (database) => ({ operation: "open", database, version: 1, stores, dropStores: [] });
const transact = (database, mode, operations) => ({ operation: "transact", database, mode, operations });
const text = (bytes) => "x".repeat(bytes);
// A snapshot like Arca's: about 100 entries in 64 KB, or as many as fill 1 MB.
const snapshot = (bytes) => {
  const per = 640;
  const count = Math.max(1, Math.floor(bytes / per));
  return { id: "queue", epoch: 1, entries: Array.from({ length: count }, (_, seq) => ({ seq, change: text(per - 40) })) };
};
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

const run = async () => {
await new BrowserKernel(jsonBoundary(engine), document, undefined, { capabilities: [storeCapability({ namespace: "bench" })], requireHandshake: true }).start();

const result = {};
for (const name of ["existing", "fresh", "data"]) await ask({ operation: "deleteDatabase", database: name });

// Open an existing database whose schema matches (5 stores).
expectKind(await ask(open("existing")), "Opened", "create existing");
result["open-existing"] = await sample(40, async () => { await ask({ operation: "close", database: "existing" }); }, async () => { expectKind(await ask(open("existing")), "Opened", "open existing"); });

// Open and create a new database (5 stores).
result["open-create"] = await sample(25, async () => { await ask({ operation: "close", database: "fresh" }); await ask({ operation: "deleteDatabase", database: "fresh" }); }, async () => { const opened = expectKind(await ask(open("fresh")), "Opened", "create"); if (opened.created !== true) throw new Error("not created"); });

// One small put and one small get (a 4 KB record).
expectKind(await ask(open("data")), "Opened", "open data");
const small = (id) => ({ id: "r" + id, at: id, payload: text(4000) });
result["put-4k"] = await sample(100, async () => {}, async (index) => { expectKind(await ask(transact("data", "readwrite", [{ op: "put", store: "b", value: small(index) }])), "Committed", "put"); });
result["get-4k"] = await sample(100, async () => {}, async (index) => { const read = expectKind(await ask(transact("data", "readonly", [{ op: "get", store: "b", key: "r" + index }])), "Committed", "get"); if (read.results[0].kind !== "Found") throw new Error("missing"); });

// A query of 100 records of 1 KB each.
expectKind(await ask(transact("data", "readwrite", Array.from({ length: 100 }, (_, index) => ({ op: "put", store: "c", value: { id: "q" + String(index).padStart(3, "0"), payload: text(1000) } })))), "Committed", "seed query");
result["query-100"] = await sample(60, async () => {}, async () => { const read = expectKind(await ask(transact("data", "readonly", [{ op: "query", store: "c", limit: 100, reverse: false }])), "Committed", "query"); if (read.results[0].values.length !== 100) throw new Error("not 100"); });

// Arca's snapshot: one record holding the whole queue, saved with putIf
// against the stored epoch and loaded with get.
for (const [label, bytes, count] of [["64k", 64 * 1024, 60], ["1m", 1000000, 25]]) {
  const value = snapshot(bytes);
  const measured = size(value);
  let stored = null;
  result[`snapshot-${label}-save`] = await sample(count, async () => {}, async () => {
    const next = { ...value, epoch: (stored?.epoch ?? 0) + 1 };
    expectKind(await ask(transact("data", "readwrite", [{ op: "putIf", store: "d", value: next, expected: stored }])), "Committed", "save");
    stored = next;
  });
  result[`snapshot-${label}-load`] = await sample(count, async () => {}, async () => { const read = expectKind(await ask(transact("data", "readonly", [{ op: "get", store: "d", key: "queue" }])), "Committed", "load"); if (read.results[0].value.entries.length !== value.entries.length) throw new Error("short load"); });
  result[`snapshot-${label}-bytes`] = measured;
  await ask(transact("data", "readwrite", [{ op: "delete", store: "d", key: "queue" }]));
}

// The one-time localStorage migration of a 1 MB snapshot: read the
// localStorage text, putIf the decoded queue with its marker into an empty
// store, read it back, compare, remove the localStorage key.
const legacy = JSON.stringify(snapshot(1000000));
result["migration-1m"] = await sample(12, async () => {
  localStorage.setItem("arca.queue.bench", legacy);
  await ask(transact("data", "readwrite", [{ op: "deleteRange", store: "e" }]));
}, async () => {
  const textValue = localStorage.getItem("arca.queue.bench");
  const queue = JSON.parse(textValue);
  expectKind(await ask(transact("data", "readwrite", [{ op: "putIf", store: "e", value: { ...queue, id: "queue" }, expected: null }, { op: "put", store: "e", value: { id: "migration", digest: textValue.length } }])), "Committed", "migrate");
  const back = expectKind(await ask(transact("data", "readonly", [{ op: "get", store: "e", key: "queue" }])), "Committed", "read back");
  if (back.results[0].value.entries.length !== queue.entries.length) throw new Error("read back differs");
  localStorage.removeItem("arca.queue.bench");
});

for (const name of ["existing", "fresh", "data"]) { await ask({ operation: "close", database: name }); await ask({ operation: "deleteDatabase", database: name }); }
return result;
};

// A failure is reported, never left to time out.
window.limenBench = await run().then((result) => ({ result }), (error) => ({ error: error instanceof Error ? error.message : String(error) }));
