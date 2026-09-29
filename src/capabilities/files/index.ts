// The user-mediated file capability pack (kemiller2002/limen#27, LCP-017).
//
// Selection is the browser's. A real <input type=file data-files-input> that
// the user operates is the gesture, the permission and the picker. The pack
// reports what was chosen as a Selected fact: an opaque id per file plus the
// metadata the browser gives. No File object, path or directory crosses the
// boundary. The engine may ask to open that input's picker; the browser allows
// it only during user activation, and NeedsGesture says so otherwise.
//
// Reads are slices of at most MAX_READ_BYTES. A large file is read in chunks
// the engine asks for, one at a time, and is never loaded whole. Downloads are
// offered through the browser's own download mechanism. There is no filesystem
// browsing and no upload hidden in form behaviour.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { createHandleTable } from "../../capability-support/handles.js";
import { resolveTarget } from "../../capability-support/targets.js";
import { CAPABILITY_OFFER, MAX_READ_BYTES, type FileId, type FileInfo, type FileInput, type FilesFact, type FilesRequest, type FilesResult, type ReadFormat } from "./generated/files.js";
import { decodeFilesRequest } from "./generated/files.codec.js";

export { CAPABILITY_OFFER as FILES_CAPABILITY, MAX_READ_BYTES } from "./generated/files.js";
export type { FileId, FileInfo, FileInput, FilesFact, FilesRequest, FilesResult, ReadFormat } from "./generated/files.js";
export { decodeFilesFact, decodeFilesRequest, decodeFilesResult } from "./generated/files.codec.js";

const ATTRIBUTES = { name: "data-files-input", key: "data-files-key" } as const;

// The document's own window, with its constructors (Blob, URL, TextDecoder).
type View = Window & typeof globalThis;
type FileInputElement = HTMLInputElement & { showPicker?: () => void };

// The one place a handle-table id becomes the contract's opaque brand.
const fileId = (id: string): FileId => id as FileId;

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "unknown";

const isFileInput = (element: Element): element is FileInputElement =>
  element.localName === "input" && element.getAttribute("type")?.toLowerCase() === "file";

// Bytes to base64 in bounded pieces (String.fromCharCode takes an argument list).
const toBase64 = (view: View, bytes: Uint8Array): string => {
  const piece = 0x8000;
  const pieces = Array.from({ length: Math.ceil(bytes.length / piece) }, (_, index) => String.fromCharCode(...bytes.subarray(index * piece, (index + 1) * piece)));
  return view.btoa(pieces.join(""));
};

type Decoded = { readonly kind: "Bytes"; readonly bytes: Uint8Array<ArrayBuffer> } | { readonly kind: "Invalid" };
const fromBase64 = (view: View, data: string): Decoded => {
  try {
    const binary = view.atob(data);
    return { kind: "Bytes", bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)) };
  } catch {
    return { kind: "Invalid" };
  }
};

export const filesCapability = (): CapabilityProvider => {
  // Owned by this provider instance: the files the user selected, until released.
  const table = createHandleTable<File>();
  const wiring: { host?: CapabilityHost<FilesFact> } = {};

  const identity = (element: Element): FileInput | undefined => {
    const name = element.getAttribute(ATTRIBUTES.name);
    const key = element.closest(`[${ATTRIBUTES.key}]`)?.getAttribute(ATTRIBUTES.key) ?? undefined;
    return name === null ? undefined : { name, ...(key !== undefined ? { key } : {}) };
  };

  const describe = (file: File): FileInfo => ({
    file: fileId(table.create(file, () => {})), name: file.name, size: file.size, type: file.type, lastModified: file.lastModified,
  });

  const declaredInput = (event: Event): { readonly element: FileInputElement; readonly input: FileInput } | undefined => {
    const target = event.target;
    if (typeof target !== "object" || target === null || !("localName" in target) || !("getAttribute" in target)) return undefined;
    const element = target as Element;
    if (!isFileInput(element)) return undefined;
    const input = identity(element);
    return input === undefined ? undefined : { element, input };
  };

  const onChange = (event: Event): void => {
    const found = declaredInput(event);
    if (found === undefined) return;
    wiring.host?.emitFact({ kind: "Selected", input: found.input, files: Array.from(found.element.files ?? [], describe) });
  };

  const onCancel = (event: Event): void => {
    const found = declaredInput(event);
    if (found !== undefined) wiring.host?.emitFact({ kind: "PickerCancelled", input: found.input });
  };

  const activate = (host: CapabilityHost<FilesFact>): void => {
    wiring.host = host;
    // An input's cancel event does not bubble; capturing on the document sees it.
    host.document.addEventListener("change", onChange, true);
    host.document.addEventListener("cancel", onCancel, true);
  };

  const pick = (document: Document, input: FileInput): FilesResult => {
    const resolved = resolveTarget(document, ATTRIBUTES, input);
    if (resolved.kind === "NotFound") return { kind: "NotFound" };
    if (resolved.kind === "Ambiguous") return { kind: "Ambiguous", count: resolved.count };
    const element = resolved.element;
    if (!isFileInput(element)) return { kind: "WrongElement" };
    if (typeof element.showPicker !== "function") return { kind: "Unsupported" };
    try {
      element.showPicker();
      return { kind: "PickerOpened" };
    } catch (error) {
      const reason = nameOf(error);
      return reason === "NotAllowedError" ? { kind: "NeedsGesture" } : { kind: "Refused", reason };
    }
  };

  const read = async (view: View, id: FileId, format: ReadFormat, offset: number, length: number, signal: AbortSignal): Promise<FilesResult> => {
    const found = table.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 1) return { kind: "InvalidRange" };
    if (length > MAX_READ_BYTES) return { kind: "TooLarge", limit: MAX_READ_BYTES };
    const file = found.resource;
    // A slice is a view on the file: nothing is read until its bytes are asked for.
    const slice = file.slice(offset, offset + length);
    try {
      const bytes = new Uint8Array(await slice.arrayBuffer());
      if (signal.aborted) return { kind: "Cancelled" };
      const data = format === "text" ? new view.TextDecoder("utf-8").decode(bytes) : toBase64(view, bytes);
      return { kind: "Read", data, bytesRead: bytes.length, eof: offset + bytes.length >= file.size };
    } catch (error) {
      return { kind: "Unreadable", reason: nameOf(error) };
    }
  };

  const download = (view: View, document: Document, fileName: string, mimeType: string, format: ReadFormat, data: string): FilesResult => {
    if (typeof view.URL.createObjectURL !== "function") return { kind: "Unsupported" };
    const decoded: Decoded = format === "text" ? { kind: "Bytes", bytes: new view.TextEncoder().encode(data) } : fromBase64(view, data);
    if (decoded.kind === "Invalid") return { kind: "InvalidData" };
    if (decoded.bytes.length > MAX_READ_BYTES) return { kind: "TooLarge", limit: MAX_READ_BYTES };
    const url = view.URL.createObjectURL(new view.Blob([decoded.bytes], { type: mimeType }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    // The browser has taken the URL once the click's navigation has started.
    view.setTimeout(() => view.URL.revokeObjectURL(url), 0);
    return { kind: "Downloaded" };
  };

  const execute = async (request: FilesRequest, context: CapabilityRequestContext): Promise<FilesResult> => {
    const view = context.document.defaultView;
    if (context.signal.aborted) return { kind: "Cancelled" };
    if (view === null) return { kind: "Unsupported" };
    switch (request.operation) {
      case "pick": return pick(context.document, request.input);
      case "read": return read(view, request.file, request.format, request.offset, request.length, context.signal);
      case "release": {
        const disposal = table.dispose(request.file);
        return disposal.kind === "Disposed" ? { kind: "Released" } : { kind: "Stale", reason: disposal.reason };
      }
      case "download": return download(view, context.document, request.fileName, request.mimeType, request.format, request.data);
    }
  };

  return defineCapability<FilesRequest, FilesResult, FilesFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeFilesRequest, execute, activate });
};
