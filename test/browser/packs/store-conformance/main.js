// The shared store vectors (conformance/store/store.vectors.json, LCP-075)
// in a real browser, through the same runner node uses. Each vector gets its
// own namespaces; a tab is a provider instance with its own connections. A
// fault the browser cannot be made to produce on demand is reported
// unsupported, never passed: quota (not enforced for IndexedDB under
// DevTools overrides, docs/41), a failing or missing indexedDB, and an
// absent navigator.storage. Storage cleared mid-session is the runner's
// clearSiteData action where the engine has the DevTools protocol.
import { storeCapability, decodeStoreResult, decodeStoreFact } from "../../../../dist/capabilities/store/index.js";
import { namespaceOf, optionsOf, runStoreVectors } from "./runner.js";

const engine = window.__limenPackEngine ?? "chromium";
const PREFIX = "cv";
const trusted = (action) => new Promise((resolve) => {
  window.__limenPackActionDone = resolve;
  window.__limenPackAction = action;
});
const physical = async () => (await indexedDB.databases()).map((info) => info.name).filter((name) => name.startsWith(PREFIX));
const removeAll = async () => {
  await Promise.all((await physical()).map((name) => new Promise((resolve) => {
    const deleting = indexedDB.deleteDatabase(name);
    deleting.onsuccess = resolve; deleting.onerror = resolve; deleting.onblocked = resolve;
  })));
};

const storage = navigator.storage;
const supports = new Set([
  "holdOpen",
  ...(typeof storage?.persist === "function" && typeof storage?.persisted === "function" && typeof storage?.estimate === "function" ? ["storage:present"] : []),
  ...(engine === "chromium" ? ["inject:storageCleared"] : []),
]);

const origin = async (vector, index) => {
  const tabs = new Map();
  const holdouts = new Map();
  const databases = new Set();
  const tab = (name) => {
    if (tabs.has(name)) return tabs.get(name);
    const provider = storeCapability(optionsOf(PREFIX, index, vector, name));
    const facts = [];
    provider.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
    const ask = async (request, { cancelled }) => {
      if ("database" in request) databases.add(request.database);
      const controller = new AbortController();
      if (cancelled) controller.abort();
      const answer = await provider.execute(request, { correlationId: "v", signal: controller.signal, document });
      if (answer.kind !== "Completed") return answer;
      const decoded = decodeStoreResult(answer.result);
      return decoded.ok ? decoded.value : { kind: "Undecodable", result: answer.result };
    };
    const made = { ask, facts, provider };
    tabs.set(name, made);
    return made;
  };
  return {
    tab,
    inject: async (step) => {
      if (step.inject !== "storageCleared") throw new Error(`cannot inject ${step.inject} here`);
      await trusted({ kind: "clearSiteData" });
      if (window.__limenPackActionError !== null) throw new Error(`clearSiteData failed: ${window.__limenPackActionError}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    holdOpen: (database, tabName) => new Promise((resolve, reject) => {
      const request = indexedDB.open(`${namespaceOf(PREFIX, index, vector, tabName)}/${database}`);
      request.onsuccess = () => { holdouts.set(database, request.result); resolve(); };
      request.onerror = () => reject(request.error);
    }),
    release: async (database) => { holdouts.get(database)?.close(); holdouts.delete(database); await new Promise((resolve) => setTimeout(resolve, 50)); },
    dispose: async () => {
      holdouts.forEach((database) => database.close());
      for (const made of tabs.values()) for (const database of databases) await made.ask({ operation: "close", database }, { cancelled: false });
      await removeAll();
    },
  };
};

await removeAll();
const vectors = await (await fetch("../../../../conformance/store/store.vectors.json")).json();
const outcome = await runStoreVectors(vectors.vectors, { supports, origin });
const checks = outcome.results.filter((result) => result.status !== "unsupported").map((result) => ({ name: `vector: ${result.name}`, ok: result.status === "passed", detail: JSON.stringify(result.detail) }));
const unsupported = outcome.results.filter((result) => result.status === "unsupported");
checks.push({ name: `${engine}: ${outcome.passed} passed, ${outcome.failed} failed, ${outcome.unsupported} unsupported of ${vectors.vectors.length} vectors (unsupported: ${unsupported.map((result) => `${result.name} [${result.detail}]`).join("; ") || "none"})`, ok: outcome.failed === 0 && outcome.passed + outcome.unsupported === vectors.vectors.length && outcome.passed > 0, detail: JSON.stringify(outcome.results.map((result) => result.status)) });
checks.push({ name: "no database of the run is left behind", ok: (await physical()).length === 0, detail: JSON.stringify(await physical()) });
window.__limenPackResult = { pack: "limen.store (conformance vectors)", checks };
