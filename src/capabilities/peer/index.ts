// WebRTC peer connections (kemiller2002/limen#44, LCP-038).
//
// An RTCPeerConnection, a track or a stream never crosses the boundary: the
// engine holds an opaque connection id. Session descriptions and ICE
// candidates are plain data, handed to the engine to relay by whatever channel
// it chooses (Http, the realtime pack, a coordination channel). Who the peer
// is, whether to call, and how to reach them is signaling meaning — the
// application's, never this pack's.
//
// Local media is a capture the media pack issued. This pack reaches it only
// through the CaptureSource the application passes in at its composition root
// (peerCapability({ captures: media })): packs never import each other, and
// without that grant every capture id is UnknownCapture. Remote media is shown
// in a <video data-peer-remote> the HTML names.
//
// Every connection ends explicitly: close, or dispose() at the host's teardown.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { createHandleTable } from "../../capability-support/handles.js";
import { resolveTarget } from "../../capability-support/targets.js";
import { CAPABILITY_OFFER, type ConnectionId, type IceCandidate, type IceServer, type PeerFact, type PeerRequest, type PeerResult, type PeerState, type RemoteTarget, type SessionDescription } from "./generated/peer.js";
import { decodePeerRequest } from "./generated/peer.codec.js";

export { CAPABILITY_OFFER as PEER_CAPABILITY } from "./generated/peer.js";
export type { ConnectionId, IceCandidate, IceServer, PeerFact, PeerRequest, PeerResult, PeerState, RemoteTarget, SessionDescription } from "./generated/peer.js";
export { decodePeerFact, decodePeerRequest, decodePeerResult } from "./generated/peer.codec.js";

const REMOTE = { name: "data-peer-remote", key: "data-peer-key" } as const;

// The stream behind a live capture id, as the media pack's streamFor gives it.
export type CaptureSource = { readonly streamFor: (id: string) => MediaStream | undefined };

// A connection, as this provider owns it.
type Connection = {
  readonly peer: RTCPeerConnection;
  readonly remote: MediaStream;
  readonly shown: Set<HTMLVideoElement>;
};

const connectionId = (id: string): ConnectionId => id as ConnectionId;

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "unknown";

// The browser's refusals of a description or candidate in the current state
// are Rejected; anything else is Failed.
const REFUSALS: readonly string[] = ["InvalidStateError", "InvalidAccessError", "OperationError", "TypeError", "SyntaxError"];
const failureOf = (error: unknown): PeerResult => {
  const name = nameOf(error);
  return REFUSALS.includes(name) ? { kind: "Rejected", reason: name } : { kind: "Failed", reason: name };
};

const STATES: readonly PeerState[] = ["new", "connecting", "connected", "disconnected", "failed", "closed"];
const stateOf = (value: string): PeerState | undefined => STATES.find((state) => state === value);

const candidateOf = (candidate: RTCIceCandidate): IceCandidate => ({
  candidate: candidate.candidate,
  ...(candidate.sdpMid !== null ? { sdpMid: candidate.sdpMid } : {}),
  ...(candidate.sdpMLineIndex !== null ? { sdpMLineIndex: candidate.sdpMLineIndex } : {}),
  ...(candidate.usernameFragment !== null ? { usernameFragment: candidate.usernameFragment } : {}),
});

const descriptionOf = (description: RTCSessionDescriptionInit): PeerResult =>
  description.type === undefined || description.sdp === undefined ? { kind: "Failed", reason: "empty-description" } : { kind: "Described", description: { type: description.type, sdp: description.sdp } };

const iceServersOf = (servers: readonly IceServer[]): RTCIceServer[] =>
  servers.map((server) => ({ urls: [...server.urls], ...(server.username !== undefined ? { username: server.username } : {}), ...(server.credential !== undefined ? { credential: server.credential } : {}) }));

// The browser cannot abandon an operation already started; a cancellation
// answers now, and the operation's own result is ignored.
const unlessCancelled = (signal: AbortSignal, operation: Promise<PeerResult>): Promise<PeerResult> =>
  Promise.race([operation, new Promise<PeerResult>((resolve) => signal.addEventListener("abort", () => resolve({ kind: "Cancelled" }), { once: true }))]);

export type PeerTeardown = { readonly dispose: () => number };

export const peerCapability = (options: { readonly captures?: CaptureSource } = {}): CapabilityProvider & PeerTeardown => {
  const connections = createHandleTable<Connection>();
  const wiring: { host?: CapabilityHost<PeerFact> } = {};

  const release = (connection: Connection): void => {
    connection.shown.forEach((video) => { if (video.srcObject === connection.remote) video.srcObject = null; });
    connection.shown.clear();
    connection.peer.close();
  };

  const open = (view: Window & typeof globalThis, servers: readonly IceServer[]): PeerResult => {
    const Peer = view.RTCPeerConnection;
    if (typeof Peer !== "function") return { kind: "NotSupported" };
    const peer = new Peer({ iceServers: iceServersOf(servers) });
    const connection: Connection = { peer, remote: new view.MediaStream(), shown: new Set() };
    const id = connectionId(connections.create(connection, release));
    const live = (): boolean => connections.use(id).kind === "Live";
    peer.addEventListener("icecandidate", (event) => {
      if (!live()) return;
      wiring.host?.emitFact(event.candidate === null || event.candidate.candidate === "" ? { kind: "GatheringComplete", connection: id } : { kind: "LocalCandidate", connection: id, candidate: candidateOf(event.candidate) });
    });
    peer.addEventListener("connectionstatechange", () => {
      const state = stateOf(peer.connectionState);
      if (live() && state !== undefined) wiring.host?.emitFact({ kind: "StateChanged", connection: id, state });
    });
    peer.addEventListener("track", (event) => {
      connection.remote.addTrack(event.track);
      if (live()) wiring.host?.emitFact({ kind: "RemoteTrackArrived", connection: id, track: event.track.kind === "audio" ? "audio" : "video" });
    });
    peer.addEventListener("negotiationneeded", () => { if (live()) wiring.host?.emitFact({ kind: "NegotiationNeeded", connection: id }); });
    return { kind: "Opened", connection: id };
  };

  const addCapture = (connection: Connection, capture: string): PeerResult => {
    const stream = options.captures?.streamFor(capture);
    if (stream === undefined) return { kind: "UnknownCapture" };
    const live = stream.getTracks().filter((track) => track.readyState === "live");
    try {
      live.forEach((track) => connection.peer.addTrack(track, stream));
      return { kind: "TracksAdded", count: live.length };
    } catch (error) {
      return failureOf(error);
    }
  };

  const showRemote = (document: Document, connection: Connection, target: RemoteTarget): PeerResult => {
    const resolved = resolveTarget(document, REMOTE, target);
    if (resolved.kind === "NotFound") return { kind: "NotFound" };
    if (resolved.kind === "Ambiguous") return { kind: "Ambiguous", count: resolved.count };
    const view = document.defaultView;
    const element = resolved.element;
    if (view === null || !(element instanceof view.HTMLVideoElement)) return { kind: "WrongElement" };
    connections.entries().forEach(([, other]) => { other.shown.delete(element); });
    element.srcObject = connection.remote;
    connection.shown.add(element);
    // A refusal by the autoplay policy is the page's to resolve with a user
    // gesture; nothing the engine could decide changes it.
    void element.play().catch(() => undefined);
    return { kind: "Showing" };
  };

  const applied = (operation: Promise<void>): Promise<PeerResult> => operation.then((): PeerResult => ({ kind: "Applied" }), failureOf);

  const withConnection = async (id: ConnectionId, run: (connection: Connection) => PeerResult | Promise<PeerResult>): Promise<PeerResult> => {
    const found = connections.use(id);
    return found.kind === "Stale" ? { kind: "Stale", reason: found.reason } : run(found.resource);
  };

  const execute = async (request: PeerRequest, context: CapabilityRequestContext): Promise<PeerResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    const view = context.document.defaultView;
    if (view === null) return { kind: "NotSupported" };
    const { signal } = context;
    switch (request.operation) {
      case "open": return open(view, request.iceServers);
      case "addCapture": return withConnection(request.connection, (connection) => addCapture(connection, request.capture));
      case "createOffer": return withConnection(request.connection, (connection) => unlessCancelled(signal, connection.peer.createOffer().then(descriptionOf, failureOf)));
      case "createAnswer": return withConnection(request.connection, (connection) => unlessCancelled(signal, connection.peer.createAnswer().then(descriptionOf, failureOf)));
      case "setLocal": return withConnection(request.connection, (connection) => unlessCancelled(signal, applied(connection.peer.setLocalDescription({ type: request.description.type, sdp: request.description.sdp }))));
      case "setRemote": return withConnection(request.connection, (connection) => unlessCancelled(signal, applied(connection.peer.setRemoteDescription({ type: request.description.type, sdp: request.description.sdp }))));
      case "addCandidate": return withConnection(request.connection, (connection) => unlessCancelled(signal, applied(connection.peer.addIceCandidate({
        candidate: request.candidate.candidate,
        ...(request.candidate.sdpMid !== undefined ? { sdpMid: request.candidate.sdpMid } : {}),
        ...(request.candidate.sdpMLineIndex !== undefined ? { sdpMLineIndex: request.candidate.sdpMLineIndex } : {}),
        ...(request.candidate.usernameFragment !== undefined ? { usernameFragment: request.candidate.usernameFragment } : {}),
      }))));
      case "showRemote": return withConnection(request.connection, (connection) => showRemote(context.document, connection, request.target));
      case "close": {
        const disposal = connections.dispose(request.connection);
        return disposal.kind === "Disposed" ? { kind: "Closed" } : { kind: "Stale", reason: disposal.reason };
      }
    }
  };

  const activate = (host: CapabilityHost<PeerFact>): void => { wiring.host = host; };

  return { ...defineCapability<PeerRequest, PeerResult, PeerFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodePeerRequest, execute, activate }), dispose: () => connections.disposeAll() };
};
