// The realtime and streaming capability pack (kemiller2002/limen#26,
// LCP-016): WebSocket and Server-Sent Events.
//
// The engine opens a connection and receives an opaque id from the shared
// handle table. Everything that then happens to the connection arrives as
// facts under that id — Opened, Message, BinaryMessage — and ends with exactly
// one Closed. A close the engine asks for is answered Closed, and after that
// nothing more is heard for the id, not even a message the browser had
// already queued. So a replacement connection can never be confused with the
// one it replaced.
//
// The pack never reconnects. EventSource retries natively after a drop; the
// pack stops it and reports Closed, so every reconnection, backoff and
// replacement is the engine's decision. Payloads are text the pack does not
// read; binary frames are reported by size only.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { createHandleTable } from "../../capability-support/handles.js";
import { CAPABILITY_OFFER, type ConnectionId, type ReadyState, type RealtimeFact, type RealtimeRequest, type RealtimeResult } from "./generated/realtime.js";
import { decodeRealtimeRequest } from "./generated/realtime.codec.js";

export { CAPABILITY_OFFER as REALTIME_CAPABILITY } from "./generated/realtime.js";
export type { CloseInitiator, ConnectionId, ReadyState, RealtimeFact, RealtimeRequest, RealtimeResult } from "./generated/realtime.js";
export { decodeRealtimeFact, decodeRealtimeRequest, decodeRealtimeResult } from "./generated/realtime.codec.js";

// The document's own window, with its constructors (WebSocket, EventSource, URL).
type View = Window & typeof globalThis;
type Connection =
  | { readonly kind: "webSocket"; readonly socket: WebSocket }
  | { readonly kind: "eventSource"; readonly source: EventSource };

const READY_STATES: readonly ReadyState[] = ["connecting", "open", "closing", "closed"];
const readyState = (value: number): ReadyState => READY_STATES[value] ?? "closed";

// The one place a handle-table id becomes the contract's opaque brand.
const connectionId = (id: string): ConnectionId => id as ConnectionId;

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "unknown";

const attempt = (act: () => RealtimeResult): RealtimeResult => {
  try {
    return act();
  } catch (error) {
    return { kind: "Refused", reason: nameOf(error) };
  }
};

// The URL as the browser would resolve it, if its scheme is one the transport
// takes. http(s) is mapped to ws(s) for a WebSocket, as current browsers do.
type Resolution = { readonly kind: "Url"; readonly href: string } | { readonly kind: "Invalid"; readonly scheme: string };
const resolveUrl = (view: View, document: Document, raw: string, schemes: Readonly<Record<string, string>>): Resolution => {
  const parsed = view.URL.canParse(raw, document.baseURI) ? new view.URL(raw, document.baseURI) : undefined;
  if (parsed === undefined) return { kind: "Invalid", scheme: "" };
  const mapped = schemes[parsed.protocol];
  if (mapped === undefined) return { kind: "Invalid", scheme: parsed.protocol.replace(/:$/, "") };
  parsed.protocol = mapped;
  return { kind: "Url", href: parsed.href };
};

const WEBSOCKET_SCHEMES = { "ws:": "ws:", "wss:": "wss:", "http:": "ws:", "https:": "wss:" } as const;
const EVENTSOURCE_SCHEMES = { "http:": "http:", "https:": "https:" } as const;

const validCloseCode = (code: number | undefined): boolean => code === undefined || code === 1000 || (code >= 3000 && code <= 4999);

const closeQuietly = (connection: Connection): void => {
  if (connection.kind === "webSocket") connection.socket.close();
  else connection.source.close();
};

export const realtimeCapability = (): CapabilityProvider => {
  // Owned by this provider instance: its live connections and its host.
  const table = createHandleTable<Connection>();
  const wiring: { host?: CapabilityHost<RealtimeFact> } = {};

  // Only a live connection speaks. After the engine's close, or after its
  // own Closed, a callback the browser had already queued is dropped.
  const live = (id: ConnectionId): boolean => table.use(id).kind === "Live";
  const emitWhileLive = (fact: RealtimeFact): void => {
    if (live(fact.connection)) wiring.host?.emitFact(fact);
  };
  // The terminal fact: sent once, then the id is Stale.
  const end = (id: ConnectionId, fact: RealtimeFact): void => {
    emitWhileLive(fact);
    table.dispose(id);
  };

  const openWebSocket = (view: View, href: string, protocols: readonly string[]): RealtimeResult => {
    const socket = new view.WebSocket(href, [...protocols]);
    socket.binaryType = "arraybuffer";
    const id = connectionId(table.create({ kind: "webSocket", socket }, closeQuietly));
    const failed = { value: false };
    socket.addEventListener("open", () => emitWhileLive({ kind: "Opened", connection: id, protocol: socket.protocol }));
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      const data = event.data;
      emitWhileLive(typeof data === "string"
        ? { kind: "Message", connection: id, data }
        : { kind: "BinaryMessage", connection: id, bytes: data instanceof view.ArrayBuffer ? data.byteLength : 0 });
    });
    socket.addEventListener("error", () => { failed.value = true; });
    socket.addEventListener("close", (event: CloseEvent) =>
      end(id, { kind: "Closed", connection: id, initiator: failed.value ? "error" : "remote", code: event.code, reason: event.reason, clean: event.wasClean }));
    return { kind: "Connecting", connection: id };
  };

  const openEventSource = (view: View, href: string, withCredentials: boolean, events: readonly string[]): RealtimeResult => {
    const source = new view.EventSource(href, { withCredentials });
    const id = connectionId(table.create({ kind: "eventSource", source }, closeQuietly));
    const deliver = (named: boolean) => (event: MessageEvent<unknown>): void => {
      emitWhileLive({
        kind: "Message", connection: id, data: typeof event.data === "string" ? event.data : "",
        ...(named ? { event: event.type } : {}),
        ...(event.lastEventId !== "" ? { lastEventId: event.lastEventId } : {}),
      });
    };
    source.addEventListener("open", () => emitWhileLive({ kind: "Opened", connection: id, protocol: "" }));
    source.addEventListener("message", deliver(false));
    events.filter((type) => type !== "message").forEach((type) => source.addEventListener(type, deliver(true)));
    // A dropped stream is about to retry on its own (CONNECTING) or has given
    // up (CLOSED). Either way it stops here, and the engine decides.
    source.addEventListener("error", () => {
      source.close();
      end(id, { kind: "Closed", connection: id, initiator: "error", code: 0, reason: "", clean: false });
    });
    return { kind: "Connecting", connection: id };
  };

  const send = (id: ConnectionId, text: string): RealtimeResult => {
    const found = table.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    if (found.resource.kind === "eventSource") return { kind: "NotSendable" };
    const socket = found.resource.socket;
    const state = readyState(socket.readyState);
    if (state !== "open") return { kind: "NotOpen", state };
    return attempt(() => {
      socket.send(text);
      return { kind: "Sent", bufferedAmount: socket.bufferedAmount };
    });
  };

  const close = (id: ConnectionId, code: number | undefined, reason: string | undefined): RealtimeResult => {
    const found = table.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    const connection = found.resource;
    if (connection.kind === "eventSource") {
      table.dispose(id);
      return { kind: "Closed" };
    }
    if (!validCloseCode(code)) return { kind: "InvalidCloseCode" };
    return attempt(() => {
      connection.socket.close(code, reason);
      table.dispose(id);
      return { kind: "Closed" };
    });
  };

  const perform = (request: RealtimeRequest, view: View, document: Document): RealtimeResult => {
    switch (request.operation) {
      case "openWebSocket": {
        if (typeof view.WebSocket !== "function") return { kind: "Unsupported" };
        const url = resolveUrl(view, document, request.url, WEBSOCKET_SCHEMES);
        return url.kind === "Invalid" ? { kind: "InvalidUrl", scheme: url.scheme } : attempt(() => openWebSocket(view, url.href, request.protocols));
      }
      case "openEventSource": {
        if (typeof view.EventSource !== "function") return { kind: "Unsupported" };
        const url = resolveUrl(view, document, request.url, EVENTSOURCE_SCHEMES);
        return url.kind === "Invalid" ? { kind: "InvalidUrl", scheme: url.scheme } : attempt(() => openEventSource(view, url.href, request.withCredentials, request.events));
      }
      case "send": return send(request.connection, request.text);
      case "close": return close(request.connection, request.code, request.reason);
    }
  };

  const execute = async (request: RealtimeRequest, context: CapabilityRequestContext): Promise<RealtimeResult> => {
    const view = context.document.defaultView;
    if (context.signal.aborted) return { kind: "Cancelled" };
    return view === null ? { kind: "Unsupported" } : perform(request, view, context.document);
  };

  return defineCapability<RealtimeRequest, RealtimeResult, RealtimeFact>({
    offer: CAPABILITY_OFFER,
    decodeRequest: decodeRealtimeRequest,
    execute,
    activate: (host) => { wiring.host = host; },
  });
};
