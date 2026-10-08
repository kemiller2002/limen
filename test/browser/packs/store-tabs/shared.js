// What both tabs of the store-tabs page share: the schema, the channel and a
// direct store provider (the kernel path is proven by store-namespaces).
import { storeCapability, decodeStoreResult, decodeStoreFact } from "../../../../dist/capabilities/store/index.js";

export const STORES = ["records", "batch", "big"].map((name) => ({ name, keyPath: "id", indexes: [] }));
export const open = (version) => ({ operation: "open", database: "db", version, stores: STORES, dropStores: [] });
export const transact = (operations, mode = "readwrite") => ({ operation: "transact", database: "db", mode, operations });
export const BATCH = 500;
export const BIG = 4000;

export const store = () => {
  const facts = [];
  const provider = storeCapability({ namespace: "tabs" });
  provider.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
  const ask = async (request) => {
    const answer = await provider.execute(request, { correlationId: "t", signal: new AbortController().signal, document });
    const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : { ok: false };
    return decoded.ok ? decoded.value : { kind: "Undecodable", answer };
  };
  return { ask, facts };
};

export const channel = () => {
  const port = new BroadcastChannel("limen-store-tabs");
  const waiting = [];
  const inbox = [];
  // One waiter per call, for any of its kinds; a message nobody waits for
  // yet is kept until someone does.
  port.onmessage = (event) => {
    const index = waiting.findIndex((entry) => entry.kinds.includes(event.data.kind));
    if (index >= 0) { const [entry] = waiting.splice(index, 1); entry.resolve(event.data); } else inbox.push(event.data);
  };
  const next = (...kinds) => {
    const index = inbox.findIndex((message) => kinds.includes(message.kind));
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve) => waiting.push({ kinds, resolve }));
  };
  return { send: (message) => port.postMessage(message), next };
};
