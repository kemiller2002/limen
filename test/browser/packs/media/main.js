// The media pack in Chromium (kemiller2002/limen#44) with the browser's fake
// camera and microphone. Permission starts ungranted and is granted and
// revoked by the runner, so each state is the browser's own, not a stub.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { mediaCapability, MEDIA_CAPABILITY, decodeMediaResult, decodeMediaFact } from "../../../../dist/capabilities/media/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const MEDIA = { id: MEDIA_CAPABILITY.id, version: MEDIA_CAPABILITY.version, fingerprint: MEDIA_CAPABILITY.fingerprint };
const bridge = { queued: [], waiting: new Map(), facts: [], sequence: 0 };
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [MEDIA] } };
    if (message.kind === "CapabilityFact") { const decoded = decodeMediaFact(message.fact); bridge.facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); }
    if (message.kind === "EffectResult") bridge.waiting.get(message.result.correlationId)?.(message.result);
    const effects = bridge.queued;
    bridge.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};
const act = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const ask = async (request) => {
  bridge.sequence += 1;
  const effect = { kind: "Capability", correlationId: `m-${bridge.sequence}`, capability: MEDIA.id, version: 1, request };
  const answered = new Promise((resolve) => bridge.waiting.set(effect.correlationId, resolve));
  bridge.queued = [effect];
  document.getElementById("poke").click();
  const result = await answered;
  const decoded = result.outcome.kind === "Completed" ? decodeMediaResult(result.outcome.result) : { ok: false };
  return decoded.ok ? decoded.value : { kind: "Undecodable", result };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

const provider = mediaCapability();
await new BrowserKernel(engine, document, undefined, { capabilities: [provider], requireHandshake: true }).start();

// --- before any grant -----------------------------------------------------------
const initial = await ask({ operation: "permission", device: "camera" });
const watching = await ask({ operation: "watchPermission", device: "camera" });
expect("registering the pack asked for nothing: the camera permission is prompt, read without prompting", initial.kind === "Permission" && initial.state === "prompt" && watching.kind === "Watching", { initial, watching });
const refused = await ask({ operation: "startCapture", audio: true, video: true });
expect("without a grant, the prompt is refused and capture is Denied — not Unavailable, not Failed", refused.kind === "Denied", refused);

// --- granted ----------------------------------------------------------------------
await act({ kind: "grantPermissions", permissions: ["camera", "microphone"] });
await wait(300);
const devices = await ask({ operation: "devices" });
expect("granted: the fake camera and microphone are listed, with labels", devices.kind === "Devices" && devices.devices.some((device) => device.kind === "videoinput" && device.label !== "") && devices.devices.some((device) => device.kind === "audioinput"), devices);
const missing = await ask({ operation: "startCapture", audio: false, video: true, videoDevice: "no-such-camera" });
expect("asking for exactly a device that does not exist is DeviceUnavailable, not Denied", missing.kind === "DeviceUnavailable", missing);

const captured = await ask({ operation: "startCapture", audio: true, video: true });
expect("capture yields an opaque id and the tracks' description — no stream crosses", captured.kind === "Capturing" && typeof captured.capture === "string" && captured.tracks.map((track) => track.kind).sort().join() === "audio,video" && captured.tracks.some((track) => track.kind === "video" && track.width > 0), captured);
const previewing = await ask({ operation: "preview", capture: captured.capture, target: { name: "self" } });
const video = document.querySelector("video");
await new Promise((resolve) => { if (video.readyState >= 2) resolve(); else video.addEventListener("loadeddata", resolve, { once: true }); setTimeout(resolve, 3000); });
expect("the preview plays the fake camera in the named <video>, muted", previewing.kind === "Previewing" && video.muted && video.videoWidth > 0 && video.readyState >= 2, { previewing, width: video.videoWidth, state: video.readyState });

const recording = await ask({ operation: "record", capture: captured.capture });
await wait(1200);
const recorded = recording.kind === "RecordingStarted" ? await ask({ operation: "finish", recording: recording.recording }) : recording;
const head = recorded.kind === "Recorded" ? await ask({ operation: "read", recording: recorded.recording, offset: 0, length: 4 }) : recorded;
const bytes = head.kind === "Read" ? Array.from(atob(head.data), (character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("") : "";
expect("a second of recording is real media: bytes delivered, and a WebM/Matroska header read back in a bounded slice", recorded.kind === "Recorded" && recorded.bytes > 1000 && recorded.durationMs >= 1000 && bytes === "1a45dfa3", { recording, recorded: { ...recorded }, bytes });
const released = recorded.kind === "Recorded" ? await ask({ operation: "release", recording: recorded.recording }) : recorded;

const stopped = await ask({ operation: "stop", capture: captured.capture });
expect("stop ends the capture: the preview is cleared and the id is stale afterwards", stopped.kind === "Stopped" && released.kind === "Released" && video.srcObject === null && (await ask({ operation: "stop", capture: captured.capture })).kind === "Stale", { stopped, released });

// --- teardown and revocation ---------------------------------------------------------
const second = await ask({ operation: "startCapture", audio: false, video: true });
const disposed = provider.dispose();
expect("the host's dispose() stops a capture the engine never stopped", second.kind === "Capturing" && disposed === 1 && (await ask({ operation: "preview", capture: second.capture, target: { name: "self" } })).kind === "Stale", { second, disposed });

// dispose() also ended the permission watch; the engine watches again.
await ask({ operation: "watchPermission", device: "camera" });
await act({ kind: "clearPermissions" });
await wait(300);
const after = await ask({ operation: "permission", device: "camera" });
// Measured in this Chromium: with prompts answered as denials, the refused
// prompt is kept as denied, and a cleared grant reads denied, not prompt.
// Every change is still a fact, in order, and a revocation is visible.
expect("each permission change is a fact, a revocation included: prompt → denied (the refused prompt), denied → granted, granted → denied",
  JSON.stringify(bridge.facts.filter((fact) => fact.kind === "PermissionChanged")) === JSON.stringify([
    { kind: "PermissionChanged", device: "camera", state: "denied", previous: "prompt" },
    { kind: "PermissionChanged", device: "camera", state: "granted", previous: "denied" },
    { kind: "PermissionChanged", device: "camera", state: "denied", previous: "granted" },
  ]) && after.state === "denied",
  { facts: bridge.facts, after });
const deniedAgain = await ask({ operation: "startCapture", audio: false, video: true });
expect("after the revocation, capture is Denied again", deniedAgain.kind === "Denied", deniedAgain);

window.__limenPackResult = { pack: "media", checks };
