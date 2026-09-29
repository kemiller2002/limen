// The optional HTTP transfer profile (kemiller2002/limen#47, LCP-041).
//
// Core's Http effect is fetch, which is the right default and cannot report
// upload progress. This pack sends through XMLHttpRequest, which can, and
// reports progress as facts — but only for a request that asks, so a request
// without progress registers no progress listener at all. It also uploads
// files the user picked with the files pack, by opaque id, alone or as
// multipart form data: the application hands this pack the files pack's
// accessor explicitly, and no File, Blob or FormData ever crosses.
//
// Outcomes keep Core Http's four-way semantics. A timeout after the request
// was sent is OutcomeUnknown, never a failure. Retry, caching and
// authentication stay in the engine.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, MAX_TRANSFER_RESPONSE_BYTES, type Part, type TransferBody, type TransferFact, type TransferRequest, type TransferResult } from "./generated/transfer.js";
import { decodeTransferRequest } from "./generated/transfer.codec.js";

export { CAPABILITY_OFFER as TRANSFER_CAPABILITY, MAX_TRANSFER_RESPONSE_BYTES } from "./generated/transfer.js";
export type { Part, TransferBody, TransferFact, TransferRequest, TransferResult } from "./generated/transfer.js";
export { decodeTransferFact, decodeTransferRequest, decodeTransferResult } from "./generated/transfer.codec.js";

// The files pack's accessor, by shape: the File behind an id it issued.
export type FileSource = { readonly fileFor: (id: string) => File | undefined };

// The document's own window, with its constructors (XMLHttpRequest, FormData, Blob).
type View = Window & typeof globalThis;
type Send = Extract<TransferRequest, { operation: "send" }>;

type Payload = { readonly kind: "Payload"; readonly body: Document | XMLHttpRequestBodyInit | null; readonly contentType?: string } | { readonly kind: "Refused"; readonly result: TransferResult };

// A picked file by id, or the typed failure. Checked by lookup, not by
// instanceof, so a File from another realm (an iframe's picker) still works.
type Lookup = { readonly ok: true; readonly file: File } | { readonly ok: false; readonly result: TransferResult };
const lookup = (files: FileSource | undefined, id: string): Lookup => {
  if (files === undefined) return { ok: false, result: { kind: "Failure", reason: "no-files" } };
  const file = files.fileFor(id);
  return file === undefined ? { ok: false, result: { kind: "Failure", reason: "unknown-file" } } : { ok: true, file };
};

// The request body, built inside the pack from ids and strings.
const payloadOf = (view: View, body: TransferBody, files: FileSource | undefined): Payload => {
  switch (body.kind) {
    case "empty": return { kind: "Payload", body: null };
    case "text": return { kind: "Payload", body: body.text, contentType: body.contentType };
    case "file": {
      const found = lookup(files, body.file);
      if (!found.ok) return { kind: "Refused", result: found.result };
      return { kind: "Payload", body: found.file, ...(body.contentType !== undefined ? { contentType: body.contentType } : {}) };
    }
    case "multipart": {
      type Resolved = { readonly kind: "field"; readonly name: string; readonly value: string } | { readonly kind: "file"; readonly name: string; readonly fileName: string | undefined; readonly found: Lookup };
      const resolved = body.parts.map((part: Part): Resolved => (part.kind === "field" ? part : { kind: "file", name: part.name, fileName: part.fileName, found: lookup(files, part.file) }));
      const refused = resolved.flatMap((entry) => (entry.kind === "file" && !entry.found.ok ? [entry.found.result] : []))[0];
      if (refused !== undefined) return { kind: "Refused", result: refused };
      const form = new view.FormData();
      resolved.forEach((entry) => {
        if (entry.kind === "field") form.append(entry.name, entry.value);
        else if (entry.found.ok) form.append(entry.name, entry.found.file, entry.fileName ?? entry.found.file.name);
      });
      // The browser sets multipart/form-data with its own boundary.
      return { kind: "Payload", body: form };
    }
  }
};

const toBase64 = (view: View, bytes: Uint8Array): string => {
  const piece = 0x8000;
  return view.btoa(Array.from({ length: Math.ceil(bytes.length / piece) }, (_, index) => String.fromCharCode(...bytes.subarray(index * piece, (index + 1) * piece))).join(""));
};

const returnedHeaders = (request: XMLHttpRequest, names: readonly string[] | undefined): Readonly<Record<string, string>> | undefined => {
  if (names === undefined || names.length === 0) return undefined;
  return Object.fromEntries(names.map((name) => name.toLowerCase()).flatMap((name) => {
    const value = request.getResponseHeader(name);
    return value === null ? [] : [[name, value] as const];
  }));
};

// The response as the request asked, or why not.
const bodyOf = (view: View, request: XMLHttpRequest, send: Send): { readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: "invalid-response" | "too-large" } => {
  if (send.response === "none") return { ok: true, body: null };
  const buffer: unknown = request.response;
  const bytes = buffer instanceof view.ArrayBuffer ? new Uint8Array(buffer) : new Uint8Array(0);
  if (bytes.length > MAX_TRANSFER_RESPONSE_BYTES) return { ok: false, reason: "too-large" };
  if (send.response === "base64") return { ok: true, body: toBase64(view, bytes) };
  const text = new view.TextDecoder().decode(bytes);
  if (send.response === "text") return { ok: true, body: text };
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "invalid-response" };
  }
};

const problemOf = (send: Send): string | undefined => {
  if (!Number.isInteger(send.timeoutMs) || send.timeoutMs < 1) return "timeoutMs must be a positive integer";
  if (!Number.isInteger(send.progressIntervalMs) || send.progressIntervalMs < 0) return "progressIntervalMs must be a non-negative integer";
  if ((send.method === "GET" || send.method === "DELETE") && send.body.kind !== "empty") return `a ${send.method} request has no body`;
  // XMLHttpRequest always sends same-origin cookies; it cannot omit them.
  // Refused rather than silently ignored: Core Http honours omit.
  if (send.credentials === "omit") return "credentials omit is not available for transfers; use the Core Http effect";
  return undefined;
};

export const transferCapability = (options: { readonly files?: FileSource } = {}): CapabilityProvider => {
  const wiring: { host?: CapabilityHost<TransferFact> } = {};

  // Progress for one direction: at most one fact per interval, and always the
  // last one, so the engine sees completion without a flood.
  const reporter = (view: View, id: string, direction: "upload" | "download", intervalMs: number) => {
    const state: { last: number; pending: number | undefined; latest: TransferFact | undefined } = { last: Number.NEGATIVE_INFINITY, pending: undefined, latest: undefined };
    const flush = (): void => {
      if (state.latest !== undefined) wiring.host?.emitFact(state.latest);
      state.latest = undefined;
      state.pending = undefined;
      state.last = view.performance.now();
    };
    return {
      report: (event: ProgressEvent): void => {
        state.latest = { kind: "Progress", request: id, direction, loaded: event.loaded, ...(event.lengthComputable ? { total: event.total } : {}) };
        const wait = state.last + intervalMs - view.performance.now();
        if (wait <= 0) { if (state.pending !== undefined) view.clearTimeout(state.pending); flush(); return; }
        state.pending ??= view.setTimeout(flush, wait);
      },
      finish: (): void => {
        if (state.pending !== undefined) view.clearTimeout(state.pending);
        if (state.latest !== undefined) flush();
      },
    };
  };

  const send = (view: View, request: Send, context: CapabilityRequestContext): Promise<TransferResult> => {
    const problem = problemOf(request);
    if (problem !== undefined) return Promise.resolve({ kind: "InvalidRequest", problem });
    const payload = payloadOf(view, request.body, options.files);
    if (payload.kind === "Refused") return Promise.resolve(payload.result);

    return new Promise<TransferResult>((resolve) => {
      const xhr = new view.XMLHttpRequest();
      const state = { timedOut: false, settled: false };
      const settle = (result: TransferResult): void => {
        if (state.settled) return;
        state.settled = true;
        view.clearTimeout(timer);
        context.signal.removeEventListener("abort", cancel);
        uploads?.finish();
        downloads?.finish();
        resolve(result);
      };
      xhr.open(request.method, request.url);
      xhr.responseType = "arraybuffer";
      if (request.credentials === "include") xhr.withCredentials = true;
      Object.entries({ ...(payload.contentType !== undefined ? { "content-type": payload.contentType } : {}), ...request.headers }).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      // No progress asked for, no progress listener registered.
      const uploads = request.progress ? reporter(view, context.correlationId, "upload", request.progressIntervalMs) : undefined;
      const downloads = request.progress ? reporter(view, context.correlationId, "download", request.progressIntervalMs) : undefined;
      if (uploads !== undefined) xhr.upload.addEventListener("progress", uploads.report);
      if (downloads !== undefined) xhr.addEventListener("progress", downloads.report);

      xhr.addEventListener("load", () => {
        const body = bodyOf(view, xhr, request);
        const headers = returnedHeaders(xhr, request.responseHeaders);
        settle(body.ok
          ? { kind: "Success", status: xhr.status, body: body.body, ...(headers !== undefined ? { headers } : {}) }
          : { kind: "Failure", reason: body.reason, status: xhr.status });
      });
      xhr.addEventListener("error", () => settle({ kind: "Failure", reason: "network" }));
      // After send, an abort is either the engine's cancel or the timeout;
      // the timeout may follow a request the server already received.
      xhr.addEventListener("abort", () => settle(state.timedOut ? { kind: "OutcomeUnknown" } : { kind: "Cancelled" }));
      const cancel = (): void => xhr.abort();
      const timer = view.setTimeout(() => { state.timedOut = true; xhr.abort(); }, request.timeoutMs);
      context.signal.addEventListener("abort", cancel, { once: true });
      xhr.send(payload.body);
    });
  };

  const execute = async (request: TransferRequest, context: CapabilityRequestContext): Promise<TransferResult> => {
    const view = context.document.defaultView;
    if (context.signal.aborted) return { kind: "Cancelled" };
    if (view === null || typeof view.XMLHttpRequest !== "function") return { kind: "Failure", reason: "network" };
    switch (request.operation) {
      case "send": return send(view, request, context);
    }
  };

  return defineCapability<TransferRequest, TransferResult, TransferFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeTransferRequest, execute, activate: (host) => { wiring.host = host; } });
};
