# User-mediated files

Choosing, reading and downloading files without filesystem authority, and
without a `File` object crossing the boundary (kemiller2002/limen#27,
LCP-017).

The browser already has the right security model: a user chooses files
through a native picker, and the page gets exactly those files and nothing
else. The files pack keeps that model and gives the engine two things:

- **facts** about what the user chose;
- **bounded reads** of those files, under opaque ids.

```ts
import { filesCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/files";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [filesCapability()] }).start();
```

```html
<label>Attachments <input type="file" multiple accept=".csv,.txt" data-files-input="attachments"></label>
```

The contract is [`contract/files.contract.json`](../contract/files.contract.json),
with bindings for TypeScript, F#, C# and Rust.

## Selection is a fact

When the user chooses files with a declared input, the engine hears:

```text
Selected { input: { name, key? }, files: [ { file, name, size, type, lastModified } ] }
```

- `file` is an opaque id from the shared handle table
  ([24](24-contract-and-capabilities.md)).
- `name` is a file name, never a path.
- `type` is the browser's guess, and may be empty.
- One file or many depends on the input's own `multiple` attribute. `accept`,
  `capture` and the rest stay in HTML.

A dismissed picker is `PickerCancelled { input }`, but only when dismissing
it changed nothing. **Chromium clears an input that already held files when
its picker is dismissed.** That arrives as `Selected` with an empty `files`
list, because that is what happened. Engines must treat an empty selection as
"nothing is selected now". The browser smoke proves both cases.

Earlier ids stay readable until the engine releases them, even after a new
selection.

## The picker needs a user gesture

The simplest, most reliable picker is the input itself: the user clicks it.
An engine that wants its own button asks:

```text
pick { input }  →  PickerOpened | NeedsGesture | …
```

Browsers open a picker only during **user activation**, a short window after
a real click or key press. A click reaches the engine and comes back as a
`pick` well inside that window. A `pick` sent on a timer, or after a slow
round trip, is answered `NeedsGesture`, and nothing opens. The engine should
then show the input and let the user operate it. The pack never simulates a
gesture.

## Reads are bounded

```text
read { file, format: "text" | "base64", offset, length }  →  Read { data, bytesRead, eof }
```

- `length` is 1 to `MAX_READ_BYTES` (1 MiB). Anything more is
  `TooLarge { limit }`.
- A read past the end returns what there is, with `eof: true`.
- `base64` carries bytes exactly. `text` decodes UTF-8; a slice that splits a
  character decodes that character as U+FFFD, so chunked text should be read
  as `base64` and decoded by the engine.

**Large files are bounded-memory by construction.** A read is a `slice` of
the file, and the browser reads only that slice's bytes. The engine reads the
next chunk when it is ready for it, so the pack never holds more than one
read's bytes. The Chromium smoke reads an 8 MiB file in nine chunks and
verifies every byte. Memory was not measured separately: the bound comes
from the design, and the test proves the chunking.

Other outcomes are `Stale { reason }` (released, unknown or from another
page load), `InvalidRange`, `Unreadable { reason }` (the file changed or
moved since selection; the exception's name only) and `Cancelled`.

## Downloads

```text
download { fileName, mimeType, format, data }  →  Downloaded | InvalidData | TooLarge | …
```

The pack makes a `Blob` and an object URL, then clicks a detached
`<a download>`, and revokes the URL. `Downloaded` means the browser was
handed the file; whether the user kept it is not observable. Data is capped
at `MAX_READ_BYTES` once decoded.

This is a trust decision the pack makes deliberately. A `blob:` URL is refused
as a **binding** value ([29](29-binding-security.md)). The pack creates one only
for data the engine supplied, and only for a download.

## Not here

- **Upload.** Nothing is uploaded implicitly: no form behaviour and no hidden
  request. Sending a file needs a binary request body, which belongs to HTTP
  profiles (#47). Until then, an engine reads and sends through its own
  effects.
- **Filesystem browsing, directories, persistent file handles** (the File
  System Access API). There is no reference consumer yet, and each would be a
  wider grant than a picked file.

## Optional

Nothing in Core imports the pack. `kernel-with-files` has its own payload
budget, and the minimal consumer loads none of it.

| Evidence | Where |
| --- | --- |
| One and many; row keys; undeclared inputs ignored; cancel; text and base64 reads, eof, U+FFFD at a split; a 3 MiB file read in chunks and reassembled; ranges, release, foreign ids, cancellation, unreadable files by name only; pick resolution and NeedsGesture; download success, bad base64, size limit, URL revocation; facts only to a selecting engine; conformance suite | [`test/files.test.ts`](../test/files.test.ts) |
| NeedsGesture without activation; real selection of one and many; real reads; an 8 MiB file in verified chunks; the native picker opened by a real click; dismissal on a used input (cleared) and a fresh input (PickerCancelled); release; a real download with the engine's name and content, in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/files/`](../test/browser/packs/files/), `npm run smoke:packs` |
