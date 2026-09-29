// The HTTP transfer profile (kemiller2002/limen#47, LCP-041). A scripted
// XMLHttpRequest on the jsdom window plays the network: progress only when
// asked (and no listener otherwise), throttled progress with the final value
// always delivered, uploads of picked files by id and as multipart, and the
// four outcomes with OutcomeUnknown intact. Real uploads and downloads with
// real progress are proven in Chromium (test/browser/packs/transfer/).

import assert from "node:assert/strict";
import test from "node:test";
import { TRANSFER_CAPABILITY, decodeTransferFact, decodeTransferResult, transferCapability, type FileSource, type TransferFact, type TransferRequest, type TransferResult } from "../dist/capabilities/transfer/index.js";
import { filesCapability } from "../dist/capabilities/files/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CorrelationId } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

type Listener = (event: Record<string, unknown>) => void;
type Scripted = {
  method?: string; url?: string; body?: unknown; withCredentials: boolean; responseType: string;
  readonly headers: Record<string, string>;
  readonly listeners: Record<string, Listener[]>;
  readonly uploadListeners: Record<string, Listener[]>;
  status: number; response: unknown; responseHeaders: Record<string, string>; aborted: boolean;
};
const sent: Scripted[] = [];

const installXhr = (document: Document): void => {
  const view = document.defaultView;
  assert.ok(view !== null);
  Reflect.set(view, "XMLHttpRequest", class {
    readonly #record: Scripted = { withCredentials: false, responseType: "", headers: {}, listeners: {}, uploadListeners: {}, status: 0, response: null, responseHeaders: {}, aborted: false };
    readonly upload = { addEventListener: (type: string, listener: Listener) => { (this.#record.uploadListeners[type] ??= []).push(listener); } };
    constructor() { sent.push(this.#record); }
    set withCredentials(value: boolean) { this.#record.withCredentials = value; }
    set responseType(value: string) { this.#record.responseType = value; }
    get status(): number { return this.#record.status; }
    get response(): unknown { return this.#record.response; }
    open(method: string, url: string): void { this.#record.method = method; this.#record.url = url; }
    setRequestHeader(name: string, value: string): void { this.#record.headers[name] = value; }
    getResponseHeader(name: string): string | null { return this.#record.responseHeaders[name.toLowerCase()] ?? null; }
    addEventListener(type: string, listener: Listener): void { (this.#record.listeners[type] ??= []).push(listener); }
    send(body: unknown): void { this.#record.body = body; }
    abort(): void { this.#record.aborted = true; (this.#record.listeners.abort ?? []).forEach((listener) => listener({})); }
  });
};

// The test plays the server for the latest request.
const server = {
  latest: (): Scripted => { const found = sent.at(-1); assert.ok(found !== undefined); return found; },
  progress: (direction: "upload" | "download", loaded: number, total?: number): void => {
    const record = server.latest();
    const listeners = direction === "upload" ? record.uploadListeners.progress : record.listeners.progress;
    (listeners ?? []).forEach((listener) => listener({ loaded, total: total ?? 0, lengthComputable: total !== undefined }));
  },
  respond: (status: number, body: Uint8Array | string, headers: Record<string, string> = {}): void => {
    const record = server.latest();
    record.status = status;
    record.response = (typeof body === "string" ? new TextEncoder().encode(body) : body).buffer;
    record.responseHeaders = headers;
    (record.listeners.load ?? []).forEach((listener) => listener({}));
  },
  fail: (): void => { (server.latest().listeners.error ?? []).forEach((listener) => listener({})); },
};

type Harness = { readonly facts: TransferFact[]; readonly start: (request: Omit<Extract<TransferRequest, { operation: "send" }>, "operation">, signal?: AbortSignal) => Promise<TransferResult>; readonly document: Document };

const withTransfer = async (act: (harness: Harness) => Promise<void>, files?: FileSource): Promise<void> => {
  sent.length = 0;
  await withDom("<p>transfer</p>", async (document) => {
    installXhr(document);
    const facts: TransferFact[] = [];
    const provider = transferCapability(files === undefined ? {} : { files });
    provider.activate({ document, emitFact: (fact) => {
      const decoded = decodeTransferFact(fact);
      assert.ok(decoded.ok);
      facts.push(decoded.value);
    } });
    const start = async (request: Omit<Extract<TransferRequest, { operation: "send" }>, "operation">, signal = new AbortController().signal): Promise<TransferResult> => {
      const answer = await provider.execute({ operation: "send", ...request }, { correlationId: "t1" as CorrelationId, signal, document });
      const decoded = answer.kind === "Completed" ? decodeTransferResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true, `decodes: ${JSON.stringify(answer)}`);
      return decoded.value;
    };
    await act({ facts, start, document });
  });
};

const base = { method: "POST", url: "/upload", body: { kind: "empty" }, response: "json", timeoutMs: 1000, progress: false, progressIntervalMs: 0 } as const;

test("without progress, no progress listener is registered at all; the JSON outcome matches Core Http", async () => {
  await withTransfer(async ({ start, facts }) => {
    const pending = start({ ...base, method: "GET", responseHeaders: ["ETag"] });
    await sleep(0);
    assert.deepEqual([server.latest().uploadListeners.progress, server.latest().listeners.progress], [undefined, undefined]);
    server.respond(200, "{\"ok\":true}", { etag: "\"v1\"" });
    assert.deepEqual(await pending, { kind: "Success", status: 200, body: { ok: true }, headers: { etag: "\"v1\"" } });
    assert.deepEqual(facts, []);
  });
});

test("with progress, facts carry the request id and direction; they are throttled per interval, and the final value always arrives", async () => {
  await withTransfer(async ({ start, facts }) => {
    const pending = start({ ...base, body: { kind: "text", text: "x".repeat(100), contentType: "text/plain" }, progress: true, progressIntervalMs: 50 });
    await sleep(0);
    [10, 20, 30, 40].forEach((loaded) => server.progress("upload", loaded, 100));
    server.progress("upload", 100, 100);
    server.progress("download", 5);
    server.respond(200, "{}");
    await pending;
    // Each direction is throttled on its own.
    assert.deepEqual(facts.filter((fact) => fact.direction === "upload"), [
      { kind: "Progress", request: "t1", direction: "upload", loaded: 10, total: 100 },
      { kind: "Progress", request: "t1", direction: "upload", loaded: 100, total: 100 },
    ]);
    assert.deepEqual(facts.filter((fact) => fact.direction === "download"), [{ kind: "Progress", request: "t1", direction: "download", loaded: 5 }]);
    assert.equal(server.latest().headers["content-type"], "text/plain");
  });
});

test("a picked file uploads by id: the File is resolved inside the pack; unknown ids and a missing files pack are typed failures", async () => {
  await withDom("<p>files</p>", async (document) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    const picked = new view.File(["hello"], "hello.txt", { type: "text/plain" });
    const files: FileSource = { fileFor: (id) => (id === "s.1" ? picked : undefined) };
    await withTransfer(async ({ start }) => {
      const pending = start({ ...base, method: "PUT", body: { kind: "file", file: "s.1" } });
      await sleep(0);
      assert.equal(server.latest().body, picked, "the File goes to the browser, never to the engine");
      server.respond(201, "{}");
      assert.equal((await pending).kind, "Success");
      assert.deepEqual(await start({ ...base, body: { kind: "file", file: "s.9" } }), { kind: "Failure", reason: "unknown-file" });
    }, files);
  });
  await withTransfer(async ({ start }) => {
    assert.deepEqual(await start({ ...base, body: { kind: "file", file: "s.1" } }), { kind: "Failure", reason: "no-files" });
  });
});

test("multipart: fields and picked files become FormData inside the pack, with the file's own name unless given", async () => {
  await withDom("<p>files</p>", async (document) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    const picked = new view.File(["a,b"], "data.csv", { type: "text/csv" });
    await withTransfer(async ({ start }) => {
      const pending = start({ ...base, body: { kind: "multipart", parts: [{ kind: "field", name: "title", value: "Q3" }, { kind: "file", name: "sheet", file: "s.1" }, { kind: "file", name: "copy", file: "s.1", fileName: "renamed.csv" }] } });
      await sleep(0);
      const form = server.latest().body;
      assert.ok(form !== null && typeof form === "object" && "getAll" in form);
      const entries = Array.from((form as FormData).entries(), ([name, value]) => [name, typeof value === "string" ? value : value.name]);
      assert.deepEqual(entries, [["title", "Q3"], ["sheet", "data.csv"], ["copy", "renamed.csv"]]);
      assert.equal("content-type" in server.latest().headers, false, "the browser sets the multipart boundary itself");
      server.respond(200, "{}");
      await pending;
    }, { fileFor: (id) => (id === "s.1" ? picked : undefined) });
  });
});

test("the files pack's own accessor resolves the ids it issued, and nothing after release", async () => {
  await withDom(`<input id="f" type="file" data-files-input="doc">`, async (document) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    const files = filesCapability();
    const issued: string[] = [];
    files.activate({ document, emitFact: (fact) => { const selected = fact as { kind: string; files?: { file: string }[] }; issued.push(...(selected.files ?? []).map((info) => info.file)); } });
    const input = document.getElementById("f");
    assert.ok(input !== null);
    const picked = new view.File(["x"], "x.txt");
    Object.defineProperty(input, "files", { value: [picked] });
    input.dispatchEvent(new view.Event("change", { bubbles: true }));
    const [id] = issued;
    assert.ok(id !== undefined);
    assert.equal(files.fileFor(id), picked);
    await files.execute({ operation: "release", file: id }, { correlationId: "r" as CorrelationId, signal: new AbortController().signal, document });
    assert.equal(files.fileFor(id), undefined);
  });
});

test("outcomes: text, base64, none, invalid-response, network failure, engine cancel, and OutcomeUnknown after a timeout", async () => {
  await withTransfer(async ({ start }) => {
    const text = start({ ...base, method: "GET", response: "text" });
    await sleep(0);
    server.respond(200, "plain");
    assert.deepEqual(await text, { kind: "Success", status: 200, body: "plain" });
    const bytes = start({ ...base, method: "GET", response: "base64" });
    await sleep(0);
    server.respond(200, new Uint8Array([0, 1, 255]));
    assert.deepEqual(await bytes, { kind: "Success", status: 200, body: "AAH/" });
    const none = start({ ...base, method: "DELETE", response: "none" });
    await sleep(0);
    server.respond(204, "");
    assert.deepEqual(await none, { kind: "Success", status: 204, body: null });
    const invalid = start({ ...base, method: "GET" });
    await sleep(0);
    server.respond(502, "<html>bad gateway</html>");
    assert.deepEqual(await invalid, { kind: "Failure", reason: "invalid-response", status: 502 });
    const network = start({ ...base });
    await sleep(0);
    server.fail();
    assert.deepEqual(await network, { kind: "Failure", reason: "network" });
    const controller = new AbortController();
    const cancelled = start({ ...base }, controller.signal);
    await sleep(0);
    controller.abort();
    assert.deepEqual(await cancelled, { kind: "Cancelled" });
    const timedOut = start({ ...base, timeoutMs: 5 });
    assert.deepEqual(await timedOut, { kind: "OutcomeUnknown" });
    assert.equal(server.latest().aborted, true);
  });
});

test("requests are validated: a body on GET, omit credentials (XHR cannot omit), and bad timings are refused; include sets withCredentials", async () => {
  await withTransfer(async ({ start }) => {
    assert.deepEqual(await start({ ...base, method: "GET", body: { kind: "text", text: "x", contentType: "text/plain" } }), { kind: "InvalidRequest", problem: "a GET request has no body" });
    assert.deepEqual(await start({ ...base, credentials: "omit" }), { kind: "InvalidRequest", problem: "credentials omit is not available for transfers; use the Core Http effect" });
    assert.deepEqual(await start({ ...base, timeoutMs: 0 }), { kind: "InvalidRequest", problem: "timeoutMs must be a positive integer" });
    const pending = start({ ...base, credentials: "include" });
    await sleep(0);
    assert.equal(server.latest().withCredentials, true);
    server.respond(200, "{}");
    await pending;
  });
});

test("the transfer pack passes the shared provider conformance suite", async () => {
  assert.equal(TRANSFER_CAPABILITY.id, "limen.transfer");
  await withDom("<p>transfer</p>", async (document) => {
    assert.deepEqual(await runProviderConformance(transferCapability(), {
      document,
      decodeResult: decodeTransferResult,
      valid: [{ name: "invalid timing", payload: { operation: "send", ...base, timeoutMs: 0 } }],
      malformed: [
        { name: "no body", payload: { operation: "send", method: "POST", url: "/", response: "json", timeoutMs: 1, progress: false, progressIntervalMs: 0 } },
        { name: "a File object", payload: { operation: "send", ...base, body: { kind: "file", file: {} } } },
        { name: "unknown method", payload: { operation: "send", ...base, method: "PROPFIND" } },
      ],
      cancellable: { name: "invalid timing", payload: { operation: "send", ...base, timeoutMs: 0 } },
    }), []);
  });
});
