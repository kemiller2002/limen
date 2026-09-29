// WebRTC peer connections (kemiller2002/limen#44, LCP-038), against a scripted
// RTCPeerConnection:
//   - a connection is an opaque id; descriptions and candidates are data the
//     engine relays, and the pack never decides who the peer is;
//   - local media only through the CaptureSource the application grants;
//   - the browser's refusals are Rejected, its other failures Failed;
//   - every connection ends: close, dispose(), and facts stop once it has.
// Real Chromium — two connections in one page, the engine relaying, B playing
// A's camera — is test/browser/packs/peer/.

import assert from "node:assert/strict";
import test from "node:test";
import { peerCapability, decodePeerFact, decodePeerResult, type ConnectionId, type PeerFact, type PeerRequest, type PeerResult } from "../dist/capabilities/peer/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CorrelationId } from "../dist/index.js";
import { withDom } from "./dom-helpers.ts";

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });
const error = (name: string): Error => Object.assign(new Error(name), { name });

type FakeTrack = { readonly kind: string; readyState: string };
type FakePeer = EventTarget & {
  readonly config: unknown; closed: number; connectionState: string; readonly added: FakeTrack[];
  createOffer(): Promise<RTCSessionDescriptionInit>; createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: unknown): Promise<void>; setRemoteDescription(description: unknown): Promise<void>; addIceCandidate(candidate: unknown): Promise<void>;
  addTrack(track: FakeTrack, stream: unknown): void; close(): void;
};
type Script = { readonly peers: FakePeer[]; offer?: () => Promise<RTCSessionDescriptionInit>; remote?: (description: unknown) => Promise<void>; candidate?: (candidate: unknown) => Promise<void> };

const install = (window: Window, script: Script): void => {
  class Peer extends EventTarget {
    closed = 0; connectionState = "new"; readonly added: FakeTrack[] = []; readonly config: unknown;
    constructor(config: unknown) { super(); this.config = config; script.peers.push(this as unknown as FakePeer); }
    createOffer() { return script.offer?.() ?? Promise.resolve({ type: "offer" as const, sdp: "v=0 offer" }); }
    createAnswer() { return Promise.resolve({ type: "answer" as const, sdp: "v=0 answer" }); }
    setLocalDescription() { return Promise.resolve(); }
    setRemoteDescription(description: unknown) { return script.remote?.(description) ?? Promise.resolve(); }
    addIceCandidate(candidate: unknown) { return script.candidate?.(candidate) ?? Promise.resolve(); }
    addTrack(track: FakeTrack) { this.added.push(track); }
    close() { this.closed += 1; this.connectionState = "closed"; }
  }
  class Stream { readonly tracks: FakeTrack[] = []; addTrack(track: FakeTrack) { this.tracks.push(track); } getTracks() { return this.tracks; } }
  Object.defineProperty(window, "RTCPeerConnection", { value: Peer, configurable: true });
  Object.defineProperty(window, "MediaStream", { value: Stream, configurable: true });
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", { value: async () => undefined, configurable: true });
};

const stream = (tracks: FakeTrack[]) => ({ getTracks: () => tracks }) as unknown as MediaStream;
const captures = (known: Record<string, MediaStream>) => ({ streamFor: (id: string) => known[id] });

const pack = (document: Document, options: Parameters<typeof peerCapability>[0] = {}, facts: PeerFact[] = []) => {
  const provider = peerCapability(options);
  provider.activate({ document, emitFact: (fact) => { const decoded = decodePeerFact(fact); assert.ok(decoded.ok, JSON.stringify(fact)); facts.push(decoded.value); } });
  const ask = async (request: PeerRequest, signal = new AbortController().signal): Promise<PeerResult> => {
    const answer = await provider.execute(request, { correlationId: "q" as CorrelationId, signal, document });
    const decoded = answer.kind === "Completed" ? decodePeerResult(answer.result) : { ok: false as const };
    assert.ok(decoded.ok, JSON.stringify(answer));
    return decoded.value;
  };
  return { ask, provider };
};
const opened = (result: PeerResult): ConnectionId => {
  assert.equal(result.kind, "Opened", JSON.stringify(result));
  return (result as Extract<PeerResult, { kind: "Opened" }>).connection;
};
const BODY = `<video data-peer-remote="far"></video><ul><li data-peer-key="a"><video data-peer-remote="tile"></video></li><li data-peer-key="b"><video data-peer-remote="tile"></video></li></ul><div data-peer-remote="wrong"></div>`;

test("no RTCPeerConnection: NotSupported, not a failure", async () => {
  await withDom(BODY, async (document) => {
    Object.defineProperty(document.defaultView, "RTCPeerConnection", { value: undefined, configurable: true });
    assert.deepEqual(await pack(document).ask({ operation: "open", iceServers: [] }), { kind: "NotSupported" });
  });
});

test("open passes the application's ICE servers, and the connection is an opaque id", async () => {
  await withDom(BODY, async (document) => {
    const script: Script = { peers: [] };
    install(document.defaultView as Window, script);
    const id = opened(await pack(document).ask({ operation: "open", iceServers: [{ urls: ["stun:stun.example.test"] }, { urls: ["turn:turn.example.test"], username: "u", credential: "c" }] }));
    assert.equal(typeof id, "string");
    assert.deepEqual(script.peers[0]?.config, { iceServers: [{ urls: ["stun:stun.example.test"] }, { urls: ["turn:turn.example.test"], username: "u", credential: "c" }] });
  });
});

test("local media only through the capture source the application granted", async () => {
  await withDom(BODY, async (document) => {
    const script: Script = { peers: [] };
    install(document.defaultView as Window, script);
    const tracks: FakeTrack[] = [{ kind: "audio", readyState: "live" }, { kind: "video", readyState: "ended" }, { kind: "video", readyState: "live" }];
    const granted = pack(document, { captures: captures({ cam: stream(tracks) }) });
    const id = opened(await granted.ask({ operation: "open", iceServers: [] }));
    assert.deepEqual(await granted.ask({ operation: "addCapture", connection: id, capture: "cam" }), { kind: "TracksAdded", count: 2 });
    assert.deepEqual(script.peers[0]?.added.map((track) => track.kind), ["audio", "video"], "only live tracks are sent");
    assert.deepEqual(await granted.ask({ operation: "addCapture", connection: id, capture: "other" }), { kind: "UnknownCapture" });
    const ungranted = pack(document);
    const other = opened(await ungranted.ask({ operation: "open", iceServers: [] }));
    assert.deepEqual(await ungranted.ask({ operation: "addCapture", connection: other, capture: "cam" }), { kind: "UnknownCapture" }, "without the grant, every capture is unknown");
  });
});

test("descriptions are data: offer and answer are Described, and apply", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, { peers: [] });
    const { ask } = pack(document);
    const id = opened(await ask({ operation: "open", iceServers: [] }));
    assert.deepEqual(await ask({ operation: "createOffer", connection: id }), { kind: "Described", description: { type: "offer", sdp: "v=0 offer" } });
    assert.deepEqual(await ask({ operation: "createAnswer", connection: id }), { kind: "Described", description: { type: "answer", sdp: "v=0 answer" } });
    assert.deepEqual(await ask({ operation: "setLocal", connection: id, description: { type: "offer", sdp: "v=0 offer" } }), { kind: "Applied" });
    assert.deepEqual(await ask({ operation: "addCandidate", connection: id, candidate: { candidate: "candidate:1 1 udp 1 10.0.0.1 9 typ host", sdpMid: "0", sdpMLineIndex: 0 } }), { kind: "Applied" });
  });
});

test("the browser's refusals are Rejected with its reason; anything else is Failed", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, { peers: [], remote: () => Promise.reject(error("InvalidStateError")), candidate: () => Promise.reject(error("OperationError")), offer: () => Promise.reject(error("UnknownError")) });
    const { ask } = pack(document);
    const id = opened(await ask({ operation: "open", iceServers: [] }));
    assert.deepEqual(await ask({ operation: "setRemote", connection: id, description: { type: "answer", sdp: "x" } }), { kind: "Rejected", reason: "InvalidStateError" });
    assert.deepEqual(await ask({ operation: "addCandidate", connection: id, candidate: { candidate: "x" } }), { kind: "Rejected", reason: "OperationError" });
    assert.deepEqual(await ask({ operation: "createOffer", connection: id }), { kind: "Failed", reason: "UnknownError" });
  });
});

test("candidates, gathering, state, remote tracks and renegotiation are facts — and stop once the connection is closed", async () => {
  await withDom(BODY, async (document) => {
    const script: Script = { peers: [] };
    install(document.defaultView as Window, script);
    const facts: PeerFact[] = [];
    const { ask } = pack(document, {}, facts);
    const id = opened(await ask({ operation: "open", iceServers: [] }));
    const peer = script.peers[0] as FakePeer;
    const fire = (type: string, fields: Record<string, unknown>) => peer.dispatchEvent(Object.assign(new Event(type), fields));
    fire("icecandidate", { candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: null } });
    fire("icecandidate", { candidate: null });
    peer.connectionState = "connected"; fire("connectionstatechange", {});
    fire("track", { track: { kind: "video", readyState: "live" } });
    fire("negotiationneeded", {});
    assert.deepEqual(facts, [
      { kind: "LocalCandidate", connection: id, candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 } },
      { kind: "GatheringComplete", connection: id },
      { kind: "StateChanged", connection: id, state: "connected" },
      { kind: "RemoteTrackArrived", connection: id, track: "video" },
      { kind: "NegotiationNeeded", connection: id },
    ]);
    assert.deepEqual(await ask({ operation: "close", connection: id }), { kind: "Closed" });
    fire("icecandidate", { candidate: { candidate: "candidate:2", sdpMid: null, sdpMLineIndex: null, usernameFragment: null } });
    assert.equal(facts.length, 5, "no fact after close");
    assert.equal(peer.closed, 1);
    assert.deepEqual(await ask({ operation: "close", connection: id }), { kind: "Stale", reason: "disposed" });
  });
});

test("remote media is shown in a named <video>, by key when several; errors are answers; close and dispose clear it", async () => {
  await withDom(BODY, async (document) => {
    const script: Script = { peers: [] };
    install(document.defaultView as Window, script);
    const { ask, provider } = pack(document);
    const id = opened(await ask({ operation: "open", iceServers: [] }));
    assert.deepEqual(await ask({ operation: "showRemote", connection: id, target: { name: "tile" } }), { kind: "Ambiguous", count: 2 });
    assert.deepEqual(await ask({ operation: "showRemote", connection: id, target: { name: "nowhere" } }), { kind: "NotFound" });
    assert.deepEqual(await ask({ operation: "showRemote", connection: id, target: { name: "wrong" } }), { kind: "WrongElement" });
    assert.deepEqual(await ask({ operation: "showRemote", connection: id, target: { name: "tile", key: "a" } }), { kind: "Showing" });
    const tile = document.querySelector('[data-peer-key="a"] video') as HTMLVideoElement;
    assert.ok(tile.srcObject !== null);
    opened(await ask({ operation: "open", iceServers: [] }));
    assert.equal(provider.dispose(), 2, "dispose closes every connection still open");
    assert.equal(tile.srcObject, null);
    assert.ok(script.peers.every((peer) => peer.closed === 1));
  });
});

test("a cancelled operation answers Cancelled at once", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, { peers: [], offer: () => new Promise(() => {}) });
    const { ask } = pack(document);
    const id = opened(await ask({ operation: "open", iceServers: [] }));
    const controller = new AbortController();
    const pending = ask({ operation: "createOffer", connection: id }, controller.signal);
    await settle();
    controller.abort();
    assert.deepEqual(await pending, { kind: "Cancelled" });
  });
});

test("the provider passes the shared conformance suite", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, { peers: [] });
    assert.deepEqual(await runProviderConformance(peerCapability(), {
      document, decodeResult: decodePeerResult,
      valid: [{ name: "open", payload: { operation: "open", iceServers: [] } }],
      malformed: [{ name: "open without servers", payload: { operation: "open" } }, { name: "an unknown sdp type", payload: { operation: "setRemote", connection: "x", description: { type: "commit", sdp: "" } } }, { name: "hangUp", payload: { operation: "hangUp" } }],
      cancellable: { name: "open", payload: { operation: "open", iceServers: [] } },
    }), []);
  });
});
