// The transfer profile in Chromium: a real picked file uploaded by id, alone
// and as multipart, with real upload progress; a real download with
// progress; a request without progress that emits none; OutcomeUnknown after
// a timeout. The engine is a scripted stand-in.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { filesCapability, FILES_CAPABILITY, decodeFilesFact } from "../../../../dist/capabilities/files/index.js";
import { transferCapability, TRANSFER_CAPABILITY, decodeTransferFact, decodeTransferResult } from "../../../../dist/capabilities/transfer/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offerOf = (capability) => ({ id: capability.id, version: capability.version, fingerprint: capability.fingerprint });
const files = filesCapability();
const state = { queued: null, waiting: null, sequence: 0, selected: [], progress: [], undecodable: 0 };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 3 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offerOf(FILES_CAPABILITY), offerOf(TRANSFER_CAPABILITY)] } };
    }
    if (message.kind === "CapabilityFact") {
      if (message.capability === FILES_CAPABILITY.id) {
        const decoded = decodeFilesFact(message.fact);
        if (decoded.ok && decoded.value.kind === "Selected") state.selected.push(...decoded.value.files); else if (!decoded.ok) state.undecodable += 1;
      } else {
        const decoded = decodeTransferFact(message.fact);
        if (decoded.ok) state.progress.push(decoded.value); else state.undecodable += 1;
      }
      return { view: {}, effects: [], cancellations: [] };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeTransferResult(outcome.result) : { ok: false };
      if (!decoded.ok) state.undecodable += 1;
      const resolve = state.waiting;
      state.waiting = null;
      resolve?.({ id: message.result.correlationId, result: decoded.ok ? decoded.value : { kind: "Outcome:" + outcome.kind } });
      return { view: {}, effects: [], cancellations: [] };
    }
    const request = state.queued;
    state.queued = null;
    if (request === null) return { view: {}, effects: [], cancellations: [] };
    state.sequence += 1;
    return { view: {}, effects: [{ kind: "Capability", correlationId: "tr-" + state.sequence, capability: TRANSFER_CAPABILITY.id, version: 1, request }], cancellations: [] };
  },
};

const send = (request) => new Promise((resolve) => {
  state.queued = { operation: "send", response: "json", timeoutMs: 10000, progress: false, progressIntervalMs: 0, ...request };
  state.waiting = resolve;
  document.getElementById("poke").click();
});
const trusted = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition) => { const deadline = Date.now() + 5000; while (!condition() && Date.now() < deadline) await sleep(20); return condition(); };
const progressFor = (id, direction) => state.progress.filter((fact) => fact.request === id && fact.direction === direction);

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [files, transferCapability({ files })], requireHandshake: true }).start();

const size = 4 * 1024 * 1024 + 11;
await trusted({ kind: "setFiles", selector: "#doc", files: [{ name: "report.bin", mimeType: "application/octet-stream", size }] });
await until(() => state.selected.length === 1);
const picked = state.selected[0];

const upload = await send({ method: "PUT", url: "/__limen/http/upload", body: { kind: "file", file: picked.file }, progress: true, progressIntervalMs: 0 });
const ups = progressFor(upload.id, "upload");
expect("a picked 4 MiB file uploads by id: the server receives every byte with the file's type", upload.result.kind === "Success" && upload.result.body.bytes === size && upload.result.body.type === "application/octet-stream", upload.result);
expect("real upload progress arrives as facts under the request id, ending at the total", ups.length >= 1 && ups.at(-1).loaded === ups.at(-1).total && ups.at(-1).total >= size, ups.map((fact) => [fact.loaded, fact.total]));

const multipart = await send({ method: "POST", url: "/__limen/http/upload", body: { kind: "multipart", parts: [{ kind: "field", name: "title", value: "Q3 report" }, { kind: "file", name: "attachment", file: picked.file, fileName: "q3.bin" }] } });
expect("multipart: a field and a picked file, built inside the pack, arrive as multipart/form-data parts", multipart.result.kind === "Success" && multipart.result.body.type === "multipart/form-data" && multipart.result.body.names.join() === "title,attachment:q3.bin" && multipart.result.body.field === "Q3 report", multipart.result);
expect("a request without progress emitted no progress facts", progressFor(multipart.id, "upload").length === 0 && progressFor(multipart.id, "download").length === 0, state.progress.filter((fact) => fact.request === multipart.id));

const download = await send({ method: "GET", url: "/__limen/http/download", body: { kind: "empty" }, response: "none", progress: true, progressIntervalMs: 20 });
const downs = progressFor(download.id, "download");
expect("real download progress is throttled and ends at the known total", download.result.kind === "Success" && downs.length >= 1 && downs.at(-1).loaded === 3 * 1024 * 1024 && downs.at(-1).total === 3 * 1024 * 1024, downs.map((fact) => [fact.loaded, fact.total]));

const unknown = await send({ method: "PUT", url: "/__limen/http/upload", body: { kind: "file", file: "not-an-id" } });
expect("an id the files pack never issued is a typed failure, and nothing is sent", unknown.result.kind === "Failure" && unknown.result.reason === "unknown-file", unknown.result);

const slow = await send({ method: "POST", url: "/__limen/http/slow", body: { kind: "text", text: "{}", contentType: "application/json" }, timeoutMs: 100 });
expect("a timeout after the request was sent is OutcomeUnknown", slow.result.kind === "OutcomeUnknown", slow.result);

expect("every answer and fact decoded with the generated decoders", state.undecodable === 0, state.undecodable);
window.__limenPackResult = { pack: "limen.transfer", checks };
