// Camera and microphone capture and recording (kemiller2002/limen#44,
// LCP-038), under the permission pattern of capability-support/permissions.ts.
//
// Three things stay apart: whether the browser can capture at all
// (Unavailable, with a reason, never a denial); what the user allowed (the
// permission state, and PermissionChanged facts, so a revocation is visible);
// and what one capture produced (Capturing, Denied, DeviceUnavailable).
// Nothing is asked at initialization: only startCapture can make the browser
// prompt, and only when the engine sends it.
//
// A MediaStream, a track, a recorder or a Blob never crosses the boundary.
// The engine holds an opaque capture id. The HTML names where it may be seen
// (<video data-media-preview="name">), and a finished recording is read in
// bounded slices. Every long-lived resource has one owner, this provider, and
// ends explicitly: stop, release, a capture that arrives after its request
// was cancelled, and dispose() at the host's teardown all stop every track.
//
// Session policy — who is being called, whether to record, what a recording
// is for — is the engine's. A granted permission is evidence, never
// application authorization.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { createHandleTable } from "../../capability-support/handles.js";
import { permissionStateOf, presenceOf, watchPermission, type Absence } from "../../capability-support/permissions.js";
import { resolveTarget } from "../../capability-support/targets.js";
import { CAPABILITY_OFFER, MAX_READ_BYTES, type CaptureId, type MediaDevice, type MediaFact, type MediaRequest, type MediaResult, type PreviewTarget, type RecordingId, type TrackInfo, type UnavailableReason } from "./generated/media.js";
import { decodeMediaRequest } from "./generated/media.codec.js";

export { CAPABILITY_OFFER as MEDIA_CAPABILITY, MAX_READ_BYTES } from "./generated/media.js";
export type { CaptureId, DeviceInfo, MediaDevice, MediaFact, MediaRequest, MediaResult, PreviewTarget, RecordingId, TrackInfo } from "./generated/media.js";
export { decodeMediaFact, decodeMediaRequest, decodeMediaResult } from "./generated/media.codec.js";

const PREVIEW = { name: "data-media-preview", key: "data-media-key" } as const;

type View = Window & typeof globalThis;

// A live capture, as this provider owns it.
type Captured = {
  readonly stream: MediaStream;
  readonly previews: Set<HTMLVideoElement>;
  readonly state: { ended: boolean };
};

// A recording, running or finished.
type Recorded = {
  readonly recorder: MediaRecorder;
  readonly startedAt: number;
  readonly finished: Promise<Blob>;
  readonly state: { finishRequested: boolean; blob: Blob | undefined; durationMs: number };
};

// The one place a handle-table id becomes a contract brand.
const captureId = (id: string): CaptureId => id as CaptureId;
const recordingId = (id: string): RecordingId => id as RecordingId;

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "unknown";

const reasonOf = (absence: Absence): UnavailableReason => {
  switch (absence) {
    case "no-secure-context": return "insecureContext";
    case "no-api": return "notSupported";
    case "policy-blocks": return "blockedByPolicy";
  }
};

// getUserMedia's errors, by name, onto the contract's outcomes. Legacy
// Chromium names are kept so an older browser is not reported as Failed.
const captureFailure = (error: unknown): MediaResult => {
  const name = nameOf(error);
  switch (name) {
    case "NotAllowedError": case "PermissionDeniedError": return { kind: "Denied" };
    case "SecurityError": return { kind: "Unavailable", reason: "blockedByPolicy" };
    case "NotFoundError": case "DevicesNotFoundError": return { kind: "DeviceUnavailable", problem: "notFound" };
    case "NotReadableError": case "TrackStartError": case "AbortError": return { kind: "DeviceUnavailable", problem: "inUse" };
    case "OverconstrainedError": case "ConstraintNotSatisfiedError": return { kind: "DeviceUnavailable", problem: "overconstrained" };
    default: return { kind: "Failed", reason: name };
  }
};

const trackInfo = (track: MediaStreamTrack): TrackInfo => {
  const settings = track.getSettings();
  return {
    kind: track.kind === "audio" ? "audio" : "video",
    label: track.label,
    ...(typeof settings.width === "number" ? { width: settings.width } : {}),
    ...(typeof settings.height === "number" ? { height: settings.height } : {}),
  };
};

const stopTracks = (stream: MediaStream): void => stream.getTracks().forEach((track) => track.stop());

const toBase64 = (view: View, bytes: Uint8Array): string => {
  const piece = 0x8000;
  const pieces = Array.from({ length: Math.ceil(bytes.length / piece) }, (_, index) => String.fromCharCode(...bytes.subarray(index * piece, (index + 1) * piece)));
  return view.btoa(pieces.join(""));
};

// What the application's host may call at teardown (and tests use): stop
// every capture and recording this provider still owns. Returns how many.
export type MediaTeardown = { readonly dispose: () => number };

// What another pack may be given, explicitly, by the application: the stream
// behind a live capture id this pack issued (the peer pack sends it). Nothing
// is shared implicitly, and the stream never crosses to the engine.
export type CaptureSource = { readonly streamFor: (id: string) => MediaStream | undefined };

export const mediaCapability = (): CapabilityProvider & MediaTeardown & CaptureSource => {
  const captures = createHandleTable<Captured>();
  const recordings = createHandleTable<Recorded>();
  const wiring: { host?: CapabilityHost<MediaFact>; readonly watchers: Map<MediaDevice, () => void> } = { watchers: new Map() };

  const releaseCapture = (captured: Captured): void => {
    captured.previews.forEach((video) => { if (video.srcObject === captured.stream) video.srcObject = null; });
    captured.previews.clear();
    stopTracks(captured.stream);
  };

  const releaseRecording = (recorded: Recorded): void => {
    if (recorded.recorder.state !== "inactive") {
      recorded.state.finishRequested = true;
      recorded.recorder.stop();
    }
  };

  const mediaDevicesOf = (document: Document): MediaDevices | undefined => document.defaultView?.navigator.mediaDevices;

  const presence = (document: Document, devices: readonly MediaDevice[]): MediaResult | undefined => {
    const mediaDevices = mediaDevicesOf(document);
    const absent = devices
      .map((device) => presenceOf(document, { present: mediaDevices !== undefined && typeof mediaDevices.getUserMedia === "function", policyFeature: device, secureContextRequired: true }))
      .find((found) => found.kind === "absent");
    return absent?.kind === "absent" ? { kind: "Unavailable", reason: reasonOf(absent.because) } : undefined;
  };

  const onDeviceChange = (): void => wiring.host?.emitFact({ kind: "DevicesChanged" });

  const activate = (host: CapabilityHost<MediaFact>): void => {
    wiring.host = host;
    mediaDevicesOf(host.document)?.addEventListener("devicechange", onDeviceChange);
  };

  // A track the browser ends (unplugged, revoked) is a fact; so is the last one.
  const watchTracks = (id: CaptureId, captured: Captured): void =>
    captured.stream.getTracks().forEach((track) => track.addEventListener("ended", () => {
      if (captured.state.ended || captures.use(id).kind !== "Live") return;
      wiring.host?.emitFact({ kind: "TrackEnded", capture: id, track: track.kind === "audio" ? "audio" : "video" });
      if (captured.stream.getTracks().every((each) => each.readyState === "ended")) {
        captured.state.ended = true;
        wiring.host?.emitFact({ kind: "CaptureEnded", capture: id });
      }
    }, { once: true }));

  const capture = async (document: Document, request: Extract<MediaRequest, { readonly operation: "startCapture" }>, signal: AbortSignal): Promise<MediaResult> => {
    if (!request.audio && !request.video) return { kind: "NothingRequested" };
    const wanted: readonly MediaDevice[] = [...(request.video ? ["camera" as const] : []), ...(request.audio ? ["microphone" as const] : [])];
    const absent = presence(document, wanted);
    const mediaDevices = mediaDevicesOf(document);
    if (absent !== undefined || mediaDevices === undefined) return absent ?? { kind: "Unavailable", reason: "notSupported" };
    const constraint = (asked: boolean, device: string | undefined): boolean | MediaTrackConstraints =>
      !asked ? false : device === undefined ? true : { deviceId: { exact: device } };
    // The browser cannot abandon a pending prompt. A cancellation answers now;
    // a stream that arrives afterwards is stopped at once and never reported.
    const outcome = { cancelled: false };
    const cancelled = new Promise<MediaResult>((resolve) => {
      if (signal.aborted) resolve({ kind: "Cancelled" });
      signal.addEventListener("abort", () => { outcome.cancelled = true; resolve({ kind: "Cancelled" }); }, { once: true });
    });
    const started = mediaDevices.getUserMedia({ audio: constraint(request.audio, request.audioDevice), video: constraint(request.video, request.videoDevice) }).then(
      (stream): MediaResult => {
        if (outcome.cancelled || signal.aborted) {
          stopTracks(stream);
          return { kind: "Cancelled" };
        }
        const captured: Captured = { stream, previews: new Set(), state: { ended: false } };
        const id = captureId(captures.create(captured, releaseCapture));
        watchTracks(id, captured);
        return { kind: "Capturing", capture: id, tracks: stream.getTracks().map(trackInfo) };
      },
      (error: unknown): MediaResult => (outcome.cancelled || signal.aborted ? { kind: "Cancelled" } : captureFailure(error)),
    );
    return Promise.race([started, cancelled]);
  };

  const video = (document: Document, target: PreviewTarget): MediaResult | HTMLVideoElement => {
    const resolved = resolveTarget(document, PREVIEW, target);
    if (resolved.kind === "NotFound") return { kind: "NotFound" };
    if (resolved.kind === "Ambiguous") return { kind: "Ambiguous", count: resolved.count };
    const view = document.defaultView;
    return view !== null && resolved.element instanceof view.HTMLVideoElement ? resolved.element : { kind: "WrongElement" };
  };

  const detach = (element: HTMLVideoElement): void =>
    captures.entries().forEach(([, captured]) => {
      if (!captured.previews.delete(element)) return;
      if (element.srcObject === captured.stream) element.srcObject = null;
    });

  const preview = (document: Document, id: CaptureId, target: PreviewTarget): MediaResult => {
    const found = captures.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    if (found.resource.state.ended) return { kind: "CaptureEnded" };
    const element = video(document, target);
    if (!("localName" in element)) return element;
    detach(element);
    element.muted = true;
    element.srcObject = found.resource.stream;
    found.resource.previews.add(element);
    // Autoplay of a muted element is allowed; a refusal changes nothing the engine can act on.
    void element.play().catch(() => undefined);
    return { kind: "Previewing" };
  };

  const record = (view: View, id: CaptureId, mimeType: string | undefined): MediaResult => {
    const found = captures.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    if (found.resource.state.ended) return { kind: "CaptureEnded" };
    const Recorder = view.MediaRecorder;
    if (typeof Recorder !== "function" || (mimeType !== undefined && !Recorder.isTypeSupported(mimeType))) return { kind: "NotRecordable", mimeType: mimeType ?? "" };
    const recorder = mimeType === undefined ? new Recorder(found.resource.stream) : new Recorder(found.resource.stream, { mimeType });
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size > 0) chunks.push(event.data); });
    const state: Recorded["state"] = { finishRequested: false, blob: undefined, durationMs: 0 };
    const startedAt = view.performance.now();
    const holder: { id?: RecordingId } = {};
    const finished = new Promise<Blob>((resolve) => recorder.addEventListener("stop", () => {
      const blob = new view.Blob(chunks, { type: recorder.mimeType });
      state.blob = blob;
      state.durationMs = Math.round(view.performance.now() - startedAt);
      if (!state.finishRequested && holder.id !== undefined) wiring.host?.emitFact({ kind: "RecordingInterrupted", recording: holder.id, reason: found.resource.state.ended ? "capture-ended" : "stopped-by-browser" });
      resolve(blob);
    }, { once: true }));
    recorder.addEventListener("error", (event) => {
      if (holder.id !== undefined) wiring.host?.emitFact({ kind: "RecordingInterrupted", recording: holder.id, reason: nameOf(Reflect.get(event, "error")) });
    });
    try {
      recorder.start();
    } catch (error) {
      return { kind: "Failed", reason: nameOf(error) };
    }
    const recorded: Recorded = { recorder, startedAt, finished, state };
    holder.id = recordingId(recordings.create(recorded, releaseRecording));
    return { kind: "RecordingStarted", recording: holder.id, mimeType: recorder.mimeType };
  };

  const finish = async (id: RecordingId, signal: AbortSignal): Promise<MediaResult> => {
    const found = recordings.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    const recorded = found.resource;
    if (recorded.recorder.state !== "inactive") {
      recorded.state.finishRequested = true;
      recorded.recorder.stop();
    }
    const cancelled = new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
    const blob = await Promise.race([recorded.finished, cancelled]);
    return blob === undefined ? { kind: "Cancelled" } : { kind: "Recorded", recording: id, bytes: blob.size, mimeType: blob.type, durationMs: recorded.state.durationMs };
  };

  const read = async (view: View, id: RecordingId, offset: number, length: number): Promise<MediaResult> => {
    const found = recordings.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    const blob = found.resource.state.blob;
    if (blob === undefined) return { kind: "StillRecording" };
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 1) return { kind: "InvalidRange" };
    if (length > MAX_READ_BYTES) return { kind: "TooLarge", limit: MAX_READ_BYTES };
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    return { kind: "Read", data: toBase64(view, bytes), bytesRead: bytes.length, eof: offset + bytes.length >= blob.size };
  };

  const devices = async (document: Document): Promise<MediaResult> => {
    const mediaDevices = mediaDevicesOf(document);
    const absent = presenceOf(document, { present: mediaDevices !== undefined && typeof mediaDevices.enumerateDevices === "function", secureContextRequired: true });
    if (absent.kind === "absent" || mediaDevices === undefined) return { kind: "Unavailable", reason: absent.kind === "absent" ? reasonOf(absent.because) : "notSupported" };
    const listed = await mediaDevices.enumerateDevices();
    return { kind: "Devices", devices: listed.map((device) => ({ deviceId: device.deviceId, kind: device.kind, label: device.label })) };
  };

  const execute = async (request: MediaRequest, context: CapabilityRequestContext): Promise<MediaResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    const { document } = context;
    const view = document.defaultView;
    if (view === null) return { kind: "Unavailable", reason: "notSupported" };
    switch (request.operation) {
      case "permission": {
        const absent = presence(document, [request.device]);
        if (absent !== undefined) return absent;
        const state = await permissionStateOf(document, request.device);
        return { kind: "Permission", ...(state !== undefined ? { state } : {}) };
      }
      case "watchPermission": {
        const absent = presence(document, [request.device]);
        if (absent !== undefined) return absent;
        const device = request.device;
        wiring.watchers.get(device)?.();
        const stop = await watchPermission(document, device, (state, previous) => wiring.host?.emitFact({ kind: "PermissionChanged", device, state, previous }));
        const state = await permissionStateOf(document, device);
        if (stop === undefined || state === undefined) {
          wiring.watchers.delete(device);
          return { kind: "CannotWatch" };
        }
        wiring.watchers.set(device, stop);
        return { kind: "Watching", state };
      }
      case "unwatchPermission":
        wiring.watchers.get(request.device)?.();
        wiring.watchers.delete(request.device);
        return { kind: "Unwatched" };
      case "devices": return devices(document);
      case "startCapture": return capture(document, request, context.signal);
      case "preview": return preview(document, request.capture, request.target);
      case "unpreview": {
        const element = video(document, request.target);
        if (!("localName" in element)) return element;
        detach(element);
        return { kind: "Unpreviewed" };
      }
      case "stop": {
        const disposal = captures.dispose(request.capture);
        return disposal.kind === "Disposed" ? { kind: "Stopped" } : { kind: "Stale", reason: disposal.reason };
      }
      case "record": return record(view, request.capture, request.mimeType);
      case "finish": return finish(request.recording, context.signal);
      case "read": return read(view, request.recording, request.offset, request.length);
      case "release": {
        const disposal = recordings.dispose(request.recording);
        return disposal.kind === "Disposed" ? { kind: "Released" } : { kind: "Stale", reason: disposal.reason };
      }
    }
  };

  const dispose = (): number => {
    wiring.watchers.forEach((stop) => stop());
    wiring.watchers.clear();
    if (wiring.host !== undefined) mediaDevicesOf(wiring.host.document)?.removeEventListener("devicechange", onDeviceChange);
    return recordings.disposeAll() + captures.disposeAll();
  };

  const streamFor = (id: string): MediaStream | undefined => {
    const found = captures.use(id);
    return found.kind === "Live" && !found.resource.state.ended ? found.resource.stream : undefined;
  };

  return { ...defineCapability<MediaRequest, MediaResult, MediaFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeMediaRequest, execute, activate }), dispose, streamFor };
};
