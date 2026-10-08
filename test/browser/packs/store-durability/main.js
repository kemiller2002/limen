// limen.store version 2 in a real browser: durability and availability
// evidence (LCP-061..064). The runner clears the origin's IndexedDB through
// the DevTools protocol mid-session (the clearSiteData action), which is what
// a person clearing site data, or the browser evicting it, does.
import { storeCapability, decodeStoreResult, decodeStoreFact } from "../../../../dist/capabilities/store/index.js";

const facts = [];
const provider = storeCapability({ namespace: "durable" });
provider.activate({ document, emitFact: (fact) => { const decoded = decodeStoreFact(fact); facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); } });
const state = { undecodable: 0 };
const ask = async (request) => {
  const answer = await provider.execute(request, { correlationId: "d", signal: new AbortController().signal, document });
  const decoded = answer.kind === "Completed" ? decodeStoreResult(answer.result) : { ok: false };
  if (!decoded.ok) state.undecodable += 1;
  return decoded.ok ? decoded.value : { kind: "Undecodable", answer };
};
const trusted = (action) => new Promise((resolve) => {
  window.__limenPackActionDone = resolve;
  window.__limenPackAction = action;
});
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const open = { operation: "open", database: "queue", version: 1, stores: [{ name: "entries", keyPath: "id", indexes: [] }], dropStores: [] };
const put = { operation: "transact", database: "queue", mode: "readwrite", operations: [{ op: "put", store: "entries", value: { id: 1 } }] };
const isCount = (value) => Number.isInteger(value) && value >= 0;

// Each answer must match what this browser has: its decision where the API
// exists, Unsupported where it does not (Playwright's WebKit on Linux has no
// persist, persisted or estimate; measured, docs/41).
const engine = window.__limenPackEngine ?? "chromium";
const api = (name) => typeof navigator.storage?.[name] === "function";
const persisted = await ask({ operation: "persisted" });
const persist = await ask({ operation: "persist" });
expect(`persisted and persist answer the browser's decision where it has the API, Unsupported where it has none (${engine}: persist ${api("persist") ? "present" : "absent"}, persisted ${api("persisted") ? "present" : "absent"})`,
  (api("persisted") ? persisted.kind === "Persistence" && typeof persisted.persistent === "boolean" : persisted.kind === "Unsupported")
  && (api("persist") ? persist.kind === "Persisted" && typeof persist.granted === "boolean" : persist.kind === "Unsupported"), { persisted, persist });

const estimate = await ask({ operation: "estimate" });
expect(`estimate reports non-negative integer bytes where the browser has the API, Unsupported where it has none (${engine}: estimate ${api("estimate") ? "present" : "absent"})`,
  api("estimate") ? estimate.kind === "Estimate" && isCount(estimate.usage) && isCount(estimate.quota) && estimate.quota > 0 : estimate.kind === "Unsupported", estimate);

const available = await ask({ operation: "availability" });
const probes = (await indexedDB.databases()).filter((info) => info.name === "durable/");
expect("availability is Available, and the probe database is gone again", available.kind === "Availability" && available.availability === "Available" && available.reason === undefined && probes.length === 0, { available, probes });

await ask({ operation: "deleteDatabase", database: "queue" });
const first = await ask(open);
const again = await ask(open);
expect("Opened says created on first use, and not on a reopen", first.kind === "Opened" && first.created === true && again.created === false, { first, again });
const wrote = await ask(put);

await trusted({ kind: "clearSiteData" });
if (window.__limenPackActionError === "Unsupported") {
  // WebKit: Playwright gives WebKit no DevTools protocol, so the runner
  // cannot clear site data under the page. A named skip, never a pass.
  expect(`${engine}: storage cleared mid-session NOT RUN: the runner has no DevTools protocol for ${engine} to clear site data (evidence: docs/41-indexeddb.md, "Measured limits"; Chromium runs it)`, wrote.kind === "Committed", { wrote, actionError: window.__limenPackActionError });
} else {
  await new Promise((resolve) => setTimeout(resolve, 200));
  const lost = facts.find((fact) => fact.kind === "ConnectionLost");
  const afterLoss = await ask(put);
  expect("clearing site data mid-session is ConnectionLost for the open database, and the next write is NotOpen, never silently reopened", wrote.kind === "Committed" && window.__limenPackActionError === null && lost?.database === "queue" && afterLoss.kind === "NotOpen", { wrote, actionError: window.__limenPackActionError, facts, afterLoss });

  const reopened = await ask(open);
  const read = await ask({ operation: "transact", database: "queue", mode: "readonly", operations: [{ op: "count", store: "entries" }] });
  expect("reopening after the loss finds the database newly created and empty: the evidence an application needs to tell 'lost' from 'first use'", reopened.kind === "Opened" && reopened.created === true && read.results?.[0]?.count === 0, { reopened, read });
}

await ask({ operation: "close", database: "queue" });
await ask({ operation: "deleteDatabase", database: "queue" });
expect("every answer and fact decoded with the generated decoders", state.undecodable === 0 && facts.every((fact) => fact.kind !== "Undecodable"), { undecodable: state.undecodable, facts });
window.__limenPackResult = { pack: "limen.store (durability and availability)", checks };
