// The files pack's real-browser scenarios. Files are chosen with Playwright's
// trusted file input and clicks (scripts/smoke-packs.ts); the engine below is
// a scripted stand-in that queues requests before each action.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { filesCapability, FILES_CAPABILITY, MAX_READ_BYTES, decodeFilesResult, decodeFilesFact } from "../../../../dist/capabilities/files/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: FILES_CAPABILITY.id, version: FILES_CAPABILITY.version, fingerprint: FILES_CAPABILITY.fingerprint };
const state = { queued: [], answers: [], facts: [], waiting: null, sequence: 0, undecodable: 0 };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "CapabilityFact") {
      const decoded = decodeFilesFact(message.fact);
      if (decoded.ok) state.facts.push(decoded.value); else state.undecodable += 1;
      return { view: {}, effects: [], cancellations: [] };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeFilesResult(outcome.result) : { ok: false };
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
      return { kind: "Capability", correlationId: "files-" + state.sequence, capability: offer.id, version: 1, request };
    });
    state.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};

// Queue requests, then act (an untrusted click by default), and wait for answers.
const ask = (requests, act = () => document.getElementById("poke").click()) => new Promise((resolve) => {
  state.queued = requests;
  state.waiting = { count: requests.length, resolve };
  act();
});
const trusted = (action) => new Promise((resolve) => {
  window.__limenPackActionDone = resolve;
  window.__limenPackAction = action;
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition) => {
  const deadline = Date.now() + 5000;
  while (!condition() && Date.now() < deadline) await sleep(20);
  return condition();
};
const takeFacts = async (count) => { await until(() => state.facts.length >= count); await sleep(50); return state.facts.splice(0); };

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const base64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

await new BrowserKernel(engine, document, undefined, { capabilities: [filesCapability()], requireHandshake: true }).start();

// --- The picker needs user activation -----------------------------------------
// First, before any trusted input: Playwright's file input and clicks grant
// user activation, which lasts a few seconds.
const [noGesture] = await ask([{ operation: "pick", input: { name: "avatar" } }]);
expect("an engine asking for a picker without user activation gets NeedsGesture, and nothing opens", noGesture.kind === "NeedsGesture", noGesture);

// --- Select one, select many -----------------------------------------------
await trusted({ kind: "setFiles", selector: "#avatar", files: [{ name: "notes.txt", mimeType: "text/plain", base64: base64("héllo, files") }] });
const [one] = await takeFacts(1);
const info = one?.files?.[0];
expect("selecting one file reports its metadata and an opaque id; no File object, path or directory", one?.kind === "Selected" && one.input.name === "avatar" && one.files.length === 1 && info.name === "notes.txt" && info.size === 13 && info.type === "text/plain" && typeof info.file === "string" && !("path" in info), one);

await trusted({ kind: "setFiles", selector: "#attachments", files: [{ name: "a.csv", mimeType: "text/csv", base64: base64("a,b\n") }, { name: "b.bin", mimeType: "application/octet-stream", base64: "AAEC" }] });
const [many] = await takeFacts(1);
expect("selecting many reports each file with its own id", many?.kind === "Selected" && many.files.map((file) => file.name).join() === "a.csv,b.bin" && many.files[0].file !== many.files[1].file, many);

const [text, bytes] = await ask([
  { operation: "read", file: info.file, format: "text", offset: 0, length: 100 },
  { operation: "read", file: many.files[1].file, format: "base64", offset: 0, length: 3 },
]);
expect("bounded reads return real text and exact bytes", text.kind === "Read" && text.data === "héllo, files" && text.eof && bytes.kind === "Read" && bytes.data === "AAEC", { text, bytes });

// --- A large file, in chunks ------------------------------------------------
const size = 8 * MAX_READ_BYTES + 5;
await trusted({ kind: "setFiles", selector: "#avatar", files: [{ name: "large.bin", mimeType: "application/octet-stream", size }] });
const [large] = await takeFacts(1);
const largeId = large.files[0].file;
const [tooLarge] = await ask([{ operation: "read", file: largeId, format: "base64", offset: 0, length: MAX_READ_BYTES + 1 }]);
const chunks = await Array.from({ length: 9 }, (_, index) => index).reduce(async (done, index) => {
  // One read at a time: the previous chunk is verified and dropped first.
  const previous = await done;
  const [chunk] = await ask([{ operation: "read", file: largeId, format: "base64", offset: index * MAX_READ_BYTES, length: MAX_READ_BYTES }]);
  const decoded = atob(chunk.data);
  // Verify each chunk against the runner's pattern, then let it go.
  const offset = index * MAX_READ_BYTES;
  const intact = Array.from({ length: decoded.length }, (_, at) => at).every((at) => decoded.charCodeAt(at) === (offset + at) % 251);
  return [...previous, { bytesRead: chunk.bytesRead, eof: chunk.eof, intact }];
}, Promise.resolve([]));
expect("a read larger than MAX_READ_BYTES is refused", tooLarge.kind === "TooLarge" && tooLarge.limit === MAX_READ_BYTES, tooLarge);
expect("an 8 MiB file is read in 1 MiB chunks, each verified, with eof on the last", large.files[0].size === size && chunks.every((chunk) => chunk.intact) && chunks.map((chunk) => chunk.bytesRead).join() === [...Array(8).fill(MAX_READ_BYTES), 5].join() && chunks.map((chunk) => chunk.eof).lastIndexOf(false) === 7 && chunks[8].eof, chunks.map((chunk) => [chunk.bytesRead, chunk.eof, chunk.intact]));

// --- The picker after a real click --------------------------------------------
const [withGesture] = await ask([{ operation: "pick", input: { name: "avatar" } }], () => { void trusted({ kind: "click", selector: "#choose" }); });
const [cleared] = await takeFacts(1);
expect("after a real click, the engine's pick opens the native picker", withGesture.kind === "PickerOpened", withGesture);
expect("dismissing the picker of an input that held a file clears it in Chromium: reported as Selected with no files", cleared?.kind === "Selected" && cleared.input.name === "avatar" && cleared.files.length === 0, cleared);

const [fresh] = await ask([{ operation: "pick", input: { name: "fresh" } }], () => { void trusted({ kind: "click", selector: "#choose" }); });
const [dismissed] = await takeFacts(1);
expect("dismissing the picker of an empty input changes nothing: a PickerCancelled fact", fresh.kind === "PickerOpened" && dismissed?.kind === "PickerCancelled" && dismissed.input.name === "fresh", { fresh, dismissed });

// --- Release, download --------------------------------------------------------
const [released, afterRelease] = await ask([{ operation: "release", file: info.file }, { operation: "read", file: info.file, format: "text", offset: 0, length: 1 }]);
expect("a released id is Stale", released.kind === "Released" && afterRelease.kind === "Stale" && afterRelease.reason === "disposed", { released, afterRelease });

const [downloaded] = await ask([{ operation: "download", fileName: "report.csv", mimeType: "text/csv", format: "text", data: "name,total\nA,1\n" }]);
const received = await until(() => (window.__limenDownloads ?? []).length > 0);
const file = (window.__limenDownloads ?? [])[0];
expect("download hands the browser a real file with the engine's name and content", downloaded.kind === "Downloaded" && received && file.name === "report.csv" && file.text === "name,total\nA,1\n", { downloaded, file });

expect("every answer and fact decoded with the generated decoders", state.undecodable === 0, state.undecodable);
window.__limenPackResult = { pack: "limen.files", checks };
