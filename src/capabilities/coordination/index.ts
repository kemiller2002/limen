// Coordination among the contexts of one application — tabs, windows, frames,
// workers — without shared mutable state (kemiller2002/limen#46, LCP-040).
//
// Each context's engine keeps its own state; only JSON messages cross, and
// every one is size-bounded and checked as JSON before an engine sees it. The
// engine decodes its own schema.
//
//   channels  same-origin broadcast, through BroadcastChannel or a SharedWorker
//             hub the host serves (hub.ts). Never delivered back to the sender.
//   locks     Web Locks, semantically blind: holding one means only that no
//             other context holds it. Leadership, writing rights, anything a
//             lock stands for, is the engine's. A stolen lock is a LockLost
//             fact; a context that disappears releases its locks, so the next
//             contender's acquire completes.
//   frames    point-to-point with a frame or the parent at one exact origin,
//             never a wildcard: messages go out with that origin as the target
//             and are accepted only from that frame's window at that origin;
//             anything else from a declared peer is PeerRefused.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type ContextId, type CoordinationFact, type CoordinationRequest, type CoordinationResult, type FrameTarget, type LockHandle, type PeerId, type RefusedReason, type UndeliverableReason } from "./generated/coordination.js";
import { decodeCoordinationRequest } from "./generated/coordination.codec.js";

export { CAPABILITY_OFFER as COORDINATION_CAPABILITY } from "./generated/coordination.js";
export type { ContextId, CoordinationFact, CoordinationRequest, CoordinationResult, FrameTarget, LockHandle, LockMode, PeerId, Via } from "./generated/coordination.js";
export { decodeCoordinationFact, decodeCoordinationRequest, decodeCoordinationResult } from "./generated/coordination.codec.js";

// What a Trusted Types policy returns for a script URL.
export type ScriptURL = string | URL | { readonly toString: () => string };

export type CoordinationOptions = {
  // The SharedWorker relay (hub.ts) the host serves, for channels opened
  // with via: "hub". Without it, those answer Unsupported.
  readonly hub?: { readonly url: string; readonly scriptURL?: (url: string) => ScriptURL };
  // The longest serialized message, in characters. Default 65536.
  readonly maxMessageChars?: number;
};

const ENVELOPE = "limen.coordination/1";

// Plain JSON only: null, booleans, strings, finite numbers, arrays and plain
// objects of those, at most 64 levels deep.
const isJson = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every((item) => isJson(item, depth + 1));
};

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);

// Reads text a peer sent: bounded, parsed, and plain JSON, or why not.
const readText = (text: unknown, limit: number): { readonly ok: true; readonly message: unknown } | { readonly ok: false; readonly reason: UndeliverableReason } => {
  if (typeof text !== "string") return { ok: false, reason: "malformed" };
  if (text.length > limit) return { ok: false, reason: "too-large" };
  try {
    const message: unknown = JSON.parse(text);
    return isJson(message) ? { ok: true, message } : { ok: false, reason: "not-json" };
  } catch {
    return { ok: false, reason: "not-json" };
  }
};

// An exact origin: scheme, host and port, as the browser would write it.
export const exactOrigin = (origin: string): string | undefined => {
  try {
    const url = new URL(origin);
    return (url.protocol === "https:" || url.protocol === "http:") && url.origin === origin ? origin : undefined;
  } catch {
    return undefined;
  }
};

const randomId = (prefix: string): string => `${prefix}-${Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

type Channel = { readonly via: "broadcast"; readonly port: BroadcastChannel } | { readonly via: "hub"; readonly port: MessagePort };
type Peer = { readonly target: FrameTarget; readonly origin: string; readonly window: () => Window | null };

export const coordinationCapability = (options: CoordinationOptions = {}): CapabilityProvider => {
  const limit = options.maxMessageChars ?? 65536;
  const context = randomId("context") as ContextId;
  const wiring: {
    host?: CapabilityHost<CoordinationFact>;
    channels: ReadonlyMap<string, Channel>;
    locks: ReadonlyMap<string, () => void>;
    peers: ReadonlyMap<string, Peer>;
    hubPort?: MessagePort;
    listening: boolean;
  } = { channels: new Map(), locks: new Map(), peers: new Map(), listening: false };
  const emit = (fact: CoordinationFact): void => wiring.host?.emitFact(fact);

  const deliver = (channel: string, data: unknown): void => {
    if (!wiring.channels.has(channel)) return;
    const from = field(data, "from");
    if (field(data, "envelope") !== ENVELOPE || typeof from !== "string") { emit({ kind: "Undeliverable", channel, reason: "malformed" }); return; }
    if (from === context) return;
    const read = readText(field(data, "text"), limit);
    emit(read.ok ? { kind: "Received", channel, from: from as ContextId, message: read.message } : { kind: "Undeliverable", channel, reason: read.reason });
  };

  const hubPort = (document: Document): MessagePort | undefined => {
    if (wiring.hubPort !== undefined) return wiring.hubPort;
    const view = document.defaultView;
    const hub = options.hub;
    if (hub === undefined || view === null || typeof view.SharedWorker !== "function") return undefined;
    // A Trusted Types policy vouches for the host's own hub URL, as for any
    // worker; its object passes where the browser expects the URL string.
    const worker: unknown = Reflect.construct(view.SharedWorker, [(hub.scriptURL ?? ((url: string) => url))(hub.url), { type: "module", name: "limen-coordination" }]);
    const candidate = field(worker, "port");
    if (!(candidate instanceof view.MessagePort)) return undefined;
    const port: MessagePort = candidate;
    port.addEventListener("message", (event) => { const channel = field(event.data, "channel"); if (typeof channel === "string") deliver(channel, event.data); });
    port.start();
    // Leaving is explicit when the page goes; a page that crashes is noticed
    // by the hub only where the browser reports a closed port.
    view.addEventListener("pagehide", () => { [...wiring.channels].forEach(([channel]) => port.postMessage({ kind: "leave", channel, context })); });
    wiring.hubPort = port;
    return port;
  };

  const onFrameMessage = (event: MessageEvent): void => {
    [...wiring.peers].forEach(([id, peer]) => {
      const peerId = id as PeerId;
      const fromPeer = event.source !== null && event.source === peer.window();
      if (!fromPeer && event.origin !== peer.origin) return;
      const refuse = (reason: RefusedReason): void => emit({ kind: "PeerRefused", peer: peerId, origin: event.origin, reason });
      if (!fromPeer) { refuse("wrong-source"); return; }
      if (event.origin !== peer.origin) { refuse("wrong-origin"); return; }
      const text = (() => { try { return JSON.stringify(event.data); } catch { return undefined; } })();
      if (text === undefined || text.length > limit || !isJson(event.data)) { refuse("not-json"); return; }
      emit({ kind: "PeerMessage", peer: peerId, message: event.data });
    });
  };

  const frameWindow = (document: Document, target: FrameTarget): (() => Window | null) | undefined => {
    const view = document.defaultView;
    switch (target.kind) {
      case "parent":
        return view !== null && view.parent !== view ? () => view.parent : undefined;
      case "frame": {
        const frames = Array.from(document.querySelectorAll("iframe[data-frame-target]")).filter((element): element is HTMLIFrameElement => element.getAttribute("data-frame-target") === target.name && "contentWindow" in element);
        const frame = frames[0];
        return frame === undefined ? undefined : () => (frame.isConnected ? frame.contentWindow : null);
      }
    }
  };

  const acquire = (request: Extract<CoordinationRequest, { operation: "acquire" }>, requestContext: CapabilityRequestContext): Promise<CoordinationResult> => {
    const locks = requestContext.document.defaultView?.navigator.locks;
    if (locks === undefined || typeof locks.request !== "function") return Promise.resolve({ kind: "Unsupported" });
    const handle = randomId("lock");
    return new Promise<CoordinationResult>((resolve) => {
      const state = { held: false };
      const lockOptions: LockOptions = request.steal
        ? { mode: request.mode, steal: true }
        : { mode: request.mode, ifAvailable: !request.wait, ...(request.wait ? { signal: requestContext.signal } : {}) };
      locks.request(request.name, lockOptions, (lock) => {
        if (lock === null) { resolve({ kind: "Busy" }); return undefined; }
        state.held = true;
        // Held until release, or until the page goes.
        return new Promise<void>((release) => {
          wiring.locks = new Map([...wiring.locks, [handle, release]]);
          resolve({ kind: "Acquired", lock: handle as LockHandle });
        });
      }).catch((error: unknown) => {
        const was = wiring.locks.has(handle);
        wiring.locks = new Map([...wiring.locks].filter(([id]) => id !== handle));
        // A lock we held, taken by another context's steal.
        if (state.held && was) { emit({ kind: "LockLost", lock: handle as LockHandle }); return; }
        resolve(field(error, "name") === "AbortError" ? { kind: "Cancelled" } : { kind: "Unsupported" });
      });
    });
  };

  const execute = async (request: CoordinationRequest, requestContext: CapabilityRequestContext): Promise<CoordinationResult> => {
    if (requestContext.signal.aborted) return { kind: "Cancelled" };
    const { document } = requestContext;
    const view = document.defaultView;
    switch (request.operation) {
      case "identity":
        return { kind: "Identity", context };
      case "open": {
        if (wiring.channels.has(request.channel)) return { kind: "AlreadyOpen" };
        if (request.via === "broadcast") {
          if (view === null || typeof view.BroadcastChannel !== "function") return { kind: "Unsupported" };
          const port = new view.BroadcastChannel(`limen:${request.channel}`);
          const channel = request.channel;
          port.addEventListener("message", (event) => deliver(channel, event.data));
          port.addEventListener("messageerror", () => emit({ kind: "Undeliverable", channel, reason: "malformed" }));
          wiring.channels = new Map([...wiring.channels, [channel, { via: "broadcast", port }]]);
          return { kind: "Opened", channel, context };
        }
        const port = hubPort(document);
        if (port === undefined) return { kind: "Unsupported" };
        port.postMessage({ kind: "join", channel: request.channel, context });
        wiring.channels = new Map([...wiring.channels, [request.channel, { via: "hub", port }]]);
        return { kind: "Opened", channel: request.channel, context };
      }
      case "close": {
        const channel = wiring.channels.get(request.channel);
        if (channel === undefined) return { kind: "NotOpen" };
        if (channel.via === "broadcast") channel.port.close();
        else channel.port.postMessage({ kind: "leave", channel: request.channel, context });
        wiring.channels = new Map([...wiring.channels].filter(([name]) => name !== request.channel));
        return { kind: "Closed" };
      }
      case "broadcast": {
        const channel = wiring.channels.get(request.channel);
        if (channel === undefined) return { kind: "NotOpen" };
        const text = JSON.stringify(request.message);
        if (text.length > limit) return { kind: "TooLarge", limit };
        const envelope = { envelope: ENVELOPE, channel: request.channel, from: context, text };
        if (channel.via === "broadcast") channel.port.postMessage(envelope);
        else channel.port.postMessage({ kind: "send", ...envelope });
        return { kind: "Sent" };
      }
      case "acquire":
        return acquire(request, requestContext);
      case "release": {
        const release = wiring.locks.get(request.lock);
        if (release === undefined) return { kind: "UnknownLock" };
        wiring.locks = new Map([...wiring.locks].filter(([id]) => id !== request.lock));
        release();
        return { kind: "Released" };
      }
      case "listen": {
        const origin = exactOrigin(request.origin);
        if (origin === undefined) return { kind: "InvalidOrigin", problem: `${JSON.stringify(request.origin)} is not an exact http(s) origin` };
        const window = frameWindow(document, request.target);
        if (window === undefined) return { kind: "NotFound" };
        if (!wiring.listening && view !== null) {
          view.addEventListener("message", onFrameMessage);
          wiring.listening = true;
        }
        const peer = randomId("peer");
        wiring.peers = new Map([...wiring.peers, [peer, { target: request.target, origin, window }]]);
        return { kind: "Listening", peer: peer as PeerId };
      }
      case "post": {
        const peer = wiring.peers.get(request.peer);
        if (peer === undefined) return { kind: "UnknownPeer" };
        const target = peer.window();
        if (target === null) return { kind: "PeerGone" };
        if (JSON.stringify(request.message).length > limit) return { kind: "TooLarge", limit };
        // The exact origin as the target: the browser drops the message if the
        // frame has navigated anywhere else. Never "*".
        target.postMessage(request.message, peer.origin);
        return { kind: "Sent" };
      }
      case "unlisten": {
        if (!wiring.peers.has(request.peer)) return { kind: "UnknownPeer" };
        wiring.peers = new Map([...wiring.peers].filter(([id]) => id !== request.peer));
        return { kind: "Unlistened" };
      }
    }
  };

  return defineCapability<CoordinationRequest, CoordinationResult, CoordinationFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeCoordinationRequest, execute, activate: (host) => { wiring.host = host; } });
};
