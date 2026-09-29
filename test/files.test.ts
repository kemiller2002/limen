// The user-mediated file pack (kemiller2002/limen#27, LCP-017). In jsdom a
// selection is simulated by setting an input's files and dispatching change;
// showPicker and object URLs are missing, which is itself the Unsupported case.
// The real picker, its gesture rule, a real cancel, chunked reads of a large
// file and a real download are proven in Chromium (test/browser/packs/files/).

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import {
  FILES_CAPABILITY, MAX_READ_BYTES, decodeFilesFact, decodeFilesResult, filesCapability, type FileId, type FilesFact, type FilesRequest, type FilesResult,
} from "../dist/capabilities/files/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineTransport } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const offer = { id: FILES_CAPABILITY.id as CapabilityId, version: FILES_CAPABILITY.version, fingerprint: FILES_CAPABILITY.fingerprint };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const PAGE = `
  <input id="one" type="file" data-files-input="avatar">
  <input id="many" type="file" multiple data-files-input="attachments">
  <ul><li data-files-key="r1"><input type="file" data-files-input="rowFile"></li><li data-files-key="r2"><input type="file" data-files-input="rowFile"></li></ul>
  <input id="text" type="text" data-files-input="notAFile">
  <input type="file" id="undeclared">`;

type Harness = { readonly ask: (request: FilesRequest, signal?: AbortSignal) => Promise<FilesResult>; readonly facts: FilesFact[]; readonly document: Document; readonly choose: (id: string, files: readonly File[]) => void; readonly file: (parts: readonly (string | Uint8Array)[], name: string, type?: string) => File };

const withProvider = async (act: (harness: Harness) => Promise<void>): Promise<void> => {
  await withDom(PAGE, async (document) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    const facts: FilesFact[] = [];
    const provider = filesCapability();
    provider.activate({ document, emitFact: (fact) => {
      const decoded = decodeFilesFact(fact);
      assert.ok(decoded.ok, "every fact decodes with the generated decoder");
      assert.deepEqual(JSON.parse(JSON.stringify(fact)), fact, "every fact is plain JSON: no File object crosses");
      facts.push(decoded.value);
    } });
    const ask = async (request: FilesRequest, signal = new AbortController().signal): Promise<FilesResult> => {
      const answer = await provider.execute(request, { correlationId: "f" as CorrelationId, signal, document });
      const decoded = answer.kind === "Completed" ? decodeFilesResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true, "every result decodes with the generated decoder");
      return decoded.value;
    };
    const choose = (selector: string, files: readonly File[]): void => {
      const input = document.querySelector(selector);
      assert.ok(input !== null);
      Object.defineProperty(input, "files", { value: files, configurable: true });
      input.dispatchEvent(new view.Event("change", { bubbles: true }));
    };
    const file = (parts: readonly (string | Uint8Array)[], name: string, type = ""): File => new view.File([...parts], name, { type, lastModified: 1700000000000 });
    await act({ ask, facts, document, choose, file });
  });
};

const selected = (facts: readonly FilesFact[], index = 0) => {
  const fact = facts[index];
  assert.ok(fact?.kind === "Selected");
  return fact;
};
const idOf = (facts: readonly FilesFact[], index = 0, file = 0): FileId => {
  const info = selected(facts, index).files[file];
  assert.ok(info !== undefined);
  return info.file;
};

test("select one and many: metadata and opaque ids, never a File, a path or a directory", async () => {
  await withProvider(async ({ facts, choose, file }) => {
    choose("#one", [file(["hello"], "hello.txt", "text/plain")]);
    choose("#many", [file(["a"], "a.csv", "text/csv"), file([new Uint8Array([1, 2, 3])], "b.bin")]);
    const [one, many] = [selected(facts, 0), selected(facts, 1)];
    assert.deepEqual(one.input, { name: "avatar" });
    assert.deepEqual(one.files.map(({ file: _id, ...info }) => info), [{ name: "hello.txt", size: 5, type: "text/plain", lastModified: 1700000000000 }]);
    assert.deepEqual(many.files.map((info) => [info.name, info.size, info.type]), [["a.csv", 1, "text/csv"], ["b.bin", 3, ""]]);
    assert.equal(new Set([...one.files, ...many.files].map((info) => info.file)).size, 3, "each file has its own id");
  });
});

test("a row's input reports its key; an undeclared file input and a non-file input are ignored", async () => {
  await withProvider(async ({ facts, choose, file, document }) => {
    choose("li[data-files-key=r2] input", [file(["x"], "x.txt")]);
    choose("#undeclared", [file(["y"], "y.txt")]);
    assert.deepEqual(facts.map((fact) => fact.input), [{ name: "rowFile", key: "r2" }]);
    const view = document.defaultView;
    assert.ok(view !== null);
    document.getElementById("text")?.dispatchEvent(new view.Event("change", { bubbles: true }));
    assert.equal(facts.length, 1);
  });
});

test("cancelling the picker is a PickerCancelled fact (the cancel event does not bubble, and is still heard)", async () => {
  await withProvider(async ({ facts, document }) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    document.getElementById("one")?.dispatchEvent(new view.Event("cancel", { bubbles: false }));
    assert.deepEqual(facts, [{ kind: "PickerCancelled", input: { name: "avatar" } }]);
  });
});

test("bounded reads: text and exact base64 bytes by offset and length; eof; reads past the end return what there is", async () => {
  await withProvider(async ({ ask, facts, choose, file }) => {
    choose("#one", [file(["héllo, world"], "greeting.txt")]);
    const id = idOf(facts);
    assert.deepEqual(await ask({ operation: "read", file: id, format: "text", offset: 0, length: 6 }), { kind: "Read", data: "héllo", bytesRead: 6, eof: false });
    assert.deepEqual(await ask({ operation: "read", file: id, format: "text", offset: 8, length: 100 }), { kind: "Read", data: "world", bytesRead: 5, eof: true });
    assert.deepEqual(await ask({ operation: "read", file: id, format: "base64", offset: 1, length: 2 }), { kind: "Read", data: Buffer.from([0xc3, 0xa9]).toString("base64"), bytesRead: 2, eof: false });
    assert.deepEqual(await ask({ operation: "read", file: id, format: "text", offset: 2, length: 1 }), { kind: "Read", data: "�", bytesRead: 1, eof: false }, "a slice that splits a character decodes it as U+FFFD");
    assert.deepEqual(await ask({ operation: "read", file: id, format: "text", offset: 50, length: 10 }), { kind: "Read", data: "", bytesRead: 0, eof: true });
  });
});

test("a large file is read in chunks the engine asks for; one read is never larger than MAX_READ_BYTES", async () => {
  await withProvider(async ({ ask, facts, choose, file }) => {
    const size = 3 * MAX_READ_BYTES + 17;
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251);
    choose("#one", [file([bytes], "large.bin")]);
    const id = idOf(facts);
    assert.deepEqual(await ask({ operation: "read", file: id, format: "base64", offset: 0, length: MAX_READ_BYTES + 1 }), { kind: "TooLarge", limit: MAX_READ_BYTES });
    const chunks = await [0, 1, 2, 3].reduce<Promise<readonly FilesResult[]>>(async (done, index) =>
      [...(await done), await ask({ operation: "read", file: id, format: "base64", offset: index * MAX_READ_BYTES, length: MAX_READ_BYTES })], Promise.resolve([]));
    const joined = Buffer.concat(chunks.map((chunk) => (chunk.kind === "Read" ? Buffer.from(chunk.data, "base64") : Buffer.alloc(0))));
    assert.deepEqual(chunks.map((chunk) => (chunk.kind === "Read" ? [chunk.bytesRead, chunk.eof] : chunk.kind)), [[MAX_READ_BYTES, false], [MAX_READ_BYTES, false], [MAX_READ_BYTES, false], [17, true]]);
    assert.ok(joined.equals(Buffer.from(bytes)), "the chunks reassemble the file exactly");
  });
});

test("ranges are validated; a released or foreign id is Stale; a cancelled read answers Cancelled", async () => {
  await withProvider(async ({ ask, facts, choose, file }) => {
    choose("#one", [file(["abc"], "abc.txt")]);
    const id = idOf(facts);
    assert.deepEqual(await ask({ operation: "read", file: id, format: "text", offset: -1, length: 1 }), { kind: "InvalidRange" });
    assert.deepEqual(await ask({ operation: "read", file: id, format: "text", offset: 0, length: 0 }), { kind: "InvalidRange" });
    const aborted = new AbortController();
    const pending = ask({ operation: "read", file: id, format: "text", offset: 0, length: 3 }, aborted.signal);
    aborted.abort();
    assert.deepEqual(await pending, { kind: "Cancelled" });
    assert.deepEqual(await ask({ operation: "release", file: id }), { kind: "Released" });
    assert.deepEqual(await ask({ operation: "read", file: id, format: "text", offset: 0, length: 1 }), { kind: "Stale", reason: "disposed" });
    assert.deepEqual(await ask({ operation: "release", file: "elsewhere.1" as FileId }), { kind: "Stale", reason: "other-session" });
  });
});

test("an unreadable file (changed or moved since selection) is Unreadable by exception name only", async () => {
  await withProvider(async ({ ask, facts, choose, file }) => {
    const broken = file(["secret contents"], "gone.txt");
    Object.defineProperty(broken, "slice", { value: () => ({ arrayBuffer: () => Promise.reject(Object.assign(new Error("/home/someone/gone.txt was modified"), { name: "NotReadableError" })) }) });
    choose("#one", [broken]);
    assert.deepEqual(await ask({ operation: "read", file: idOf(facts), format: "text", offset: 0, length: 4 }), { kind: "Unreadable", reason: "NotReadableError" });
  });
});

test("pick: target resolution, a non-file input refused, and Unsupported where showPicker is missing; NeedsGesture when the browser refuses without activation", async () => {
  await withProvider(async ({ ask, document }) => {
    assert.deepEqual(await ask({ operation: "pick", input: { name: "nope" } }), { kind: "NotFound" });
    assert.deepEqual(await ask({ operation: "pick", input: { name: "rowFile" } }), { kind: "Ambiguous", count: 2 });
    assert.deepEqual(await ask({ operation: "pick", input: { name: "notAFile" } }), { kind: "WrongElement" });
    assert.deepEqual(await ask({ operation: "pick", input: { name: "avatar" } }), { kind: "Unsupported" });
    const input = document.getElementById("one");
    assert.ok(input !== null);
    const refuse = (name: string) => () => { throw Object.assign(new Error("no"), { name }); };
    Object.defineProperty(input, "showPicker", { value: refuse("NotAllowedError"), configurable: true });
    assert.deepEqual(await ask({ operation: "pick", input: { name: "avatar" } }), { kind: "NeedsGesture" });
    Object.defineProperty(input, "showPicker", { value: refuse("InvalidStateError"), configurable: true });
    assert.deepEqual(await ask({ operation: "pick", input: { name: "avatar" } }), { kind: "Refused", reason: "InvalidStateError" });
    Object.defineProperty(input, "showPicker", { value: () => {}, configurable: true });
    assert.deepEqual(await ask({ operation: "pick", input: { name: "rowFile", key: "r1" } }), { kind: "Unsupported" }, "the row's own input has no showPicker");
    assert.deepEqual(await ask({ operation: "pick", input: { name: "avatar" } }), { kind: "PickerOpened" });
  });
});

test("download: text and base64 are handed to the browser; bad base64 and oversized data are refused; no object URLs means Unsupported", async () => {
  await withProvider(async ({ ask, document }) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    assert.deepEqual(await ask({ operation: "download", fileName: "a.txt", mimeType: "text/plain", format: "text", data: "hi" }), { kind: "Unsupported" });
    const urls: { created: Blob[]; revoked: string[]; clicked: string[] } = { created: [], revoked: [], clicked: [] };
    Reflect.set(view.URL, "createObjectURL", (blob: Blob) => { urls.created.push(blob); return `blob:test/${urls.created.length}`; });
    Reflect.set(view.URL, "revokeObjectURL", (url: string) => { urls.revoked.push(url); });
    Reflect.set(view.HTMLAnchorElement.prototype, "click", function (this: HTMLAnchorElement) { urls.clicked.push(`${this.download}@${this.getAttribute("href") ?? ""}`); });
    assert.deepEqual(await ask({ operation: "download", fileName: "report.csv", mimeType: "text/csv", format: "text", data: "a,b\n1,2\n" }), { kind: "Downloaded" });
    assert.deepEqual(await ask({ operation: "download", fileName: "b.bin", mimeType: "application/octet-stream", format: "base64", data: "AQID" }), { kind: "Downloaded" });
    assert.deepEqual(await ask({ operation: "download", fileName: "c.bin", mimeType: "", format: "base64", data: "not base64!" }), { kind: "InvalidData" });
    assert.deepEqual(await ask({ operation: "download", fileName: "d.txt", mimeType: "", format: "text", data: "x".repeat(MAX_READ_BYTES + 1) }), { kind: "TooLarge", limit: MAX_READ_BYTES });
    await sleep(5);
    assert.deepEqual(urls.clicked, ["report.csv@blob:test/1", "b.bin@blob:test/2"]);
    assert.deepEqual(urls.revoked, ["blob:test/1", "blob:test/2"], "every object URL is revoked");
    assert.deepEqual([urls.created[0]?.type, urls.created[1]?.size], ["text/csv", 3]);
  });
});

test("through the kernel, a selection reaches only an engine that selected the pack", async () => {
  const run = async (select: boolean): Promise<readonly unknown[]> => {
    const heard: unknown[] = [];
    const transport: EngineTransport = {
      start: async () => {},
      dispatch: async (message: BrowserToEngineMessage) => {
        if (message.kind === "CapabilityFact") heard.push(message.fact);
        return { view: {}, effects: [], cancellations: [], ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: select ? [offer] : [] } } : {}) };
      },
    };
    return withDom(PAGE, async (document) => {
      const view = document.defaultView;
      assert.ok(view !== null);
      await new BrowserKernel(transport, document, undefined, { capabilities: [filesCapability()], requireHandshake: true }).start();
      const input = document.getElementById("one");
      assert.ok(input !== null);
      Object.defineProperty(input, "files", { value: [new view.File(["x"], "x.txt")] });
      input.dispatchEvent(new view.Event("change", { bubbles: true }));
      await sleep(5);
      return [...heard];
    });
  };
  const selectedFacts = await run(true);
  assert.equal((selectedFacts[0] as { kind?: string } | undefined)?.kind, "Selected");
  assert.deepEqual(await run(false), []);
});

test("the files pack passes the shared provider conformance suite", async () => {
  await withDom(PAGE, async (document) => {
    assert.deepEqual(await runProviderConformance(filesCapability(), {
      document,
      decodeResult: decodeFilesResult,
      valid: [{ name: "pick", payload: { operation: "pick", input: { name: "avatar" } } }, { name: "release stale", payload: { operation: "release", file: "x.1" } }],
      malformed: [
        { name: "no format", payload: { operation: "read", file: "x.1", offset: 0, length: 1 } },
        { name: "unknown format", payload: { operation: "read", file: "x.1", format: "blob", offset: 0, length: 1 } },
        { name: "a path", payload: { operation: "pick", input: { name: "avatar" }, path: "/etc" } },
      ],
      cancellable: { name: "pick", payload: { operation: "pick", input: { name: "avatar" } } },
    }), []);
  });
});
