// The peer pack in Chromium (kemiller2002/limen#44): two connections in one
// page, A sending the fake camera to B. The engine below is the signaling:
// it relays A's offer and candidates to B and B's answer and candidates to A,
// exactly as it would relay them to a remote peer over Http or a socket.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { mediaCapability, MEDIA_CAPABILITY, decodeMediaResult } from "../../../../dist/capabilities/media/index.js";
import { peerCapability, PEER_CAPABILITY, decodePeerResult, decodePeerFact } from "../../../../dist/capabilities/peer/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = (capability) => ({ id: capability.id, version: capability.version, fingerprint: capability.fingerprint });
const MEDIA = offer(MEDIA_CAPABILITY);
const PEER = offer(PEER_CAPABILITY);
const bridge = { queued: [], waiting: new Map(), facts: [], sequence: 0, relay: (fact) => {} };
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [MEDIA, PEER] } };
    if (message.kind === "CapabilityFact" && message.capability === PEER.id) {
      const decoded = decodePeerFact(message.fact);
      const fact = decoded.ok ? decoded.value : { kind: "Undecodable" };
      bridge.facts.push(fact);
      bridge.relay(fact);
    }
    if (message.kind === "EffectResult") bridge.waiting.get(message.result.correlationId)?.(message.result);
    const effects = bridge.queued;
    bridge.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};
const act = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const ask = async (target, request) => {
  bridge.sequence += 1;
  const effect = { kind: "Capability", correlationId: `q-${bridge.sequence}`, capability: target.id, version: 1, request };
  const answered = new Promise((resolve) => bridge.waiting.set(effect.correlationId, resolve));
  bridge.queued = [...bridge.queued, effect];
  document.getElementById("poke").click();
  const result = await answered;
  const decoded = result.outcome.kind === "Completed" ? (target === MEDIA ? decodeMediaResult : decodePeerResult)(result.outcome.result) : { ok: false };
  return decoded.ok ? decoded.value : { kind: "Undecodable", result };
};
const until = (predicate, ms = 10000) => new Promise((resolve) => {
  const started = Date.now();
  const poll = () => (predicate() || Date.now() - started > ms ? resolve(predicate()) : setTimeout(poll, 50));
  poll();
});
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

const media = mediaCapability();
const peer = peerCapability({ captures: media });
await new BrowserKernel(engine, document, undefined, { capabilities: [media, peer], requireHandshake: true }).start();

await act({ kind: "grantPermissions", permissions: ["camera", "microphone"] });
const camera = await ask(MEDIA, { operation: "startCapture", audio: false, video: true });
const a = await ask(PEER, { operation: "open", iceServers: [] });
const b = await ask(PEER, { operation: "open", iceServers: [] });
expect("open yields opaque connection ids; no RTCPeerConnection crosses", camera.kind === "Capturing" && a.kind === "Opened" && b.kind === "Opened" && typeof a.connection === "string" && a.connection !== b.connection, { camera, a, b });

// The engine's signaling: candidates go to the other side as they arrive.
const relayed = [];
bridge.relay = (fact) => {
  if (fact.kind !== "LocalCandidate") return;
  const to = fact.connection === a.connection ? b.connection : a.connection;
  relayed.push(fact.connection === a.connection ? "a→b" : "b→a");
  void ask(PEER, { operation: "addCandidate", connection: to, candidate: fact.candidate });
};

const early = await ask(PEER, { operation: "setRemote", connection: a.connection, description: { type: "answer", sdp: "v=0\r\n" } });
expect("an answer before any offer is Rejected with the browser's reason, not Failed", early.kind === "Rejected", early);

const added = await ask(PEER, { operation: "addCapture", connection: a.connection, capture: camera.capture });
const madeUp = await ask(PEER, { operation: "addCapture", connection: a.connection, capture: "no-such-capture" });
expect("a capture the media pack issued is sent by id; an id it never issued is UnknownCapture", added.kind === "TracksAdded" && added.count === 1 && madeUp.kind === "UnknownCapture", { added, madeUp });

const offered = await ask(PEER, { operation: "createOffer", connection: a.connection });
const setA = await ask(PEER, { operation: "setLocal", connection: a.connection, description: offered.description });
const setB = await ask(PEER, { operation: "setRemote", connection: b.connection, description: offered.description });
const answered = await ask(PEER, { operation: "createAnswer", connection: b.connection });
const setB2 = await ask(PEER, { operation: "setLocal", connection: b.connection, description: answered.description });
const setA2 = await ask(PEER, { operation: "setRemote", connection: a.connection, description: answered.description });
expect("offer and answer are plain descriptions the engine relays, and each applies", offered.kind === "Described" && offered.description.type === "offer" && offered.description.sdp.includes("m=video") && answered.description?.type === "answer" && [setA, setB, setB2, setA2].every((result) => result.kind === "Applied"), { offered: offered.kind, answered: answered.kind, setA, setB, setB2, setA2 });

const connected = await until(() => ["a", "b"].every((side) => bridge.facts.some((fact) => fact.kind === "StateChanged" && fact.connection === (side === "a" ? a : b).connection && fact.state === "connected")));
expect("candidates relayed by the engine connect both sides: StateChanged connected arrives as a fact for each", connected && relayed.includes("a→b") && relayed.includes("b→a"), { states: bridge.facts.filter((fact) => fact.kind === "StateChanged"), relayed: relayed.length });

const arrived = bridge.facts.some((fact) => fact.kind === "RemoteTrackArrived" && fact.connection === b.connection && fact.track === "video");
const showing = await ask(PEER, { operation: "showRemote", connection: b.connection, target: { name: "far" } });
const video = document.querySelector("video");
const playing = await until(() => video.readyState >= 2 && video.videoWidth > 0);
expect("B receives A's camera: RemoteTrackArrived, and the named <video> plays it", arrived && showing.kind === "Showing" && playing, { arrived, showing, width: video.videoWidth, state: video.readyState });

const closed = await ask(PEER, { operation: "close", connection: a.connection });
const afterClose = await ask(PEER, { operation: "createOffer", connection: a.connection });
expect("close ends A, and its id is stale afterwards", closed.kind === "Closed" && afterClose.kind === "Stale", { closed, afterClose });
const disposed = peer.dispose();
expect("the host's dispose() closes the connection the engine never closed, and clears its video", disposed === 1 && video.srcObject === null, { disposed });

window.__limenPackResult = { pack: "peer", checks };
