// Camera and microphone capture and recording (kemiller2002/limen#44,
// LCP-038), against scripted browser media APIs:
//   - unavailable is never denied; denied, not found, in use and
//     overconstrained are each their own outcome;
//   - a stream never crosses: the engine holds an opaque id, previews go into a
//     named <video>, recordings are read in bounded slices;
//   - every long-lived resource ends: stop, release, a capture that arrives
//     after cancellation, a browser-ended track, and dispose();
//   - the pack shares the permission vocabulary of #42.
// Real Chromium with fake devices is test/browser/packs/media/.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mediaCapability, decodeMediaFact, decodeMediaResult, MAX_READ_BYTES, type CaptureId, type MediaFact, type MediaRequest, type MediaResult, type RecordingId } from "../dist/capabilities/media/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CorrelationId } from "../dist/index.js";
import { withDom } from "./dom-helpers.ts";

const settle = (ms = 5): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// --- scripted media APIs ------------------------------------------------------

type FakeTrack = EventTarget & { readonly kind: string; readonly label: string; readyState: string; stopped: number; stop(): void; getSettings(): Record<string, number>; end(): void };
const fakeTrack = (kind: "audio" | "video"): FakeTrack => {
  const track = Object.assign(new EventTarget(), {
    kind, label: `Fake ${kind}`, readyState: "live", stopped: 0,
    stop: () => { track.stopped += 1; track.readyState = "ended"; },
    getSettings: () => (kind === "video" ? { width: 640, height: 480 } : {}),
    // The browser ending a track on its own: no stop() call, an ended event.
    end: () => { track.readyState = "ended"; track.dispatchEvent(new Event("ended")); },
  });
  return track;
};
type FakeStream = { readonly tracks: readonly FakeTrack[]; getTracks(): readonly FakeTrack[] };
const fakeStream = (audio: boolean, video: boolean): FakeStream => {
  const tracks = [...(audio ? [fakeTrack("audio")] : []), ...(video ? [fakeTrack("video")] : [])];
  return { tracks, getTracks: () => tracks };
};

type Browser = {
  secure?: boolean;
  answer: (constraints: { audio: unknown; video: unknown }) => Promise<FakeStream>;
  readonly streams: FakeStream[];
  readonly asked: unknown[];
  permission?: EventTarget & { state: string };
  recordable?: (type: string) => boolean;
};

// A MediaRecorder that records two chunks and stops when asked or when its
// stream's tracks end.
const fakeRecorderClass = (browser: Browser, window: Window & typeof globalThis) => class FakeRecorder extends EventTarget {
  static isTypeSupported(type: string): boolean { return browser.recordable?.(type) ?? true; }
  state = "inactive";
  readonly mimeType: string;
  readonly stream: FakeStream;
  constructor(stream: FakeStream, options?: { mimeType?: string }) {
    super();
    this.stream = stream;
    this.mimeType = options?.mimeType ?? "video/webm";
    stream.tracks.forEach((track) => track.addEventListener("ended", () => this.stop()));
  }
  start(): void { this.state = "recording"; }
  stop(): void {
    if (this.state === "inactive") return;
    this.state = "inactive";
    const data = (text: string) => Object.assign(new Event("dataavailable"), { data: new window.Blob([text], { type: this.mimeType }) });
    setTimeout(() => { this.dispatchEvent(data("first-")); this.dispatchEvent(data("second")); this.dispatchEvent(new Event("stop")); }, 1);
  }
};

const install = (window: Window, browser: Browser): void => {
  Object.defineProperty(window, "isSecureContext", { value: browser.secure ?? true, configurable: true });
  const mediaDevices = Object.assign(new EventTarget(), {
    getUserMedia: async (constraints: { audio: unknown; video: unknown }) => {
      browser.asked.push(constraints);
      const stream = await browser.answer(constraints);
      browser.streams.push(stream);
      return stream;
    },
    enumerateDevices: async () => [{ deviceId: "cam-1", kind: "videoinput", label: "", groupId: "g" }, { deviceId: "mic-1", kind: "audioinput", label: "", groupId: "g" }],
  });
  Object.defineProperty(window.navigator, "mediaDevices", { value: mediaDevices, configurable: true });
  Object.defineProperty(window.navigator, "permissions", { value: { query: async () => { if (browser.permission === undefined) throw new TypeError("unknown"); return browser.permission; } }, configurable: true });
  Object.defineProperty(window, "MediaRecorder", { value: fakeRecorderClass(browser, window as Window & typeof globalThis), configurable: true });
  // jsdom has no media playback.
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", { value: async () => undefined, configurable: true });
};

const error = (name: string): Error => Object.assign(new Error(name), { name });
const granting = (constraints: { audio: unknown; video: unknown }): Promise<FakeStream> => Promise.resolve(fakeStream(constraints.audio !== false, constraints.video !== false));

const pack = (document: Document, facts: MediaFact[] = []) => {
  const provider = mediaCapability();
  provider.activate({ document, emitFact: (fact) => { const decoded = decodeMediaFact(fact); assert.ok(decoded.ok, JSON.stringify(fact)); facts.push(decoded.value); } });
  const ask = async (request: MediaRequest, signal = new AbortController().signal): Promise<MediaResult> => {
    const answer = await provider.execute(request, { correlationId: "m" as CorrelationId, signal, document });
    const decoded = answer.kind === "Completed" ? decodeMediaResult(answer.result) : { ok: false as const };
    assert.ok(decoded.ok, JSON.stringify(answer));
    return decoded.value;
  };
  return { ask, provider };
};

const capturing = (result: MediaResult): CaptureId => {
  assert.equal(result.kind, "Capturing", JSON.stringify(result));
  return (result as Extract<MediaResult, { kind: "Capturing" }>).capture;
};

const BODY = `<video data-media-preview="self"></video><ul><li data-media-key="a"><video data-media-preview="tile"></video></li><li data-media-key="b"><video data-media-preview="tile"></video></li></ul><div data-media-preview="wrong"></div>`;
const browserWith = (overrides: Partial<Browser> = {}): Browser => ({ answer: granting, streams: [], asked: [], ...overrides });

// --- availability, permission, outcomes ---------------------------------------

test("the pack shares the #42 permission vocabulary", async () => {
  const [media, geolocation] = await Promise.all(["media", "geolocation"].map(async (name) => JSON.parse(await readFile(new URL(`../contract/${name}.contract.json`, import.meta.url), "utf8")) as { types: { name: string; values?: string[] }[] }));
  ["PermissionState", "UnavailableReason"].forEach((name) => assert.deepEqual(media?.types.find((type) => type.name === name)?.values, geolocation?.types.find((type) => type.name === name)?.values, name));
});

test("unavailable is never denied: an insecure context and a missing API are each Unavailable with their reason, and nothing is asked", async () => {
  await withDom(BODY, async (document) => {
    const browser = browserWith({ secure: false });
    install(document.defaultView as Window, browser);
    const { ask } = pack(document);
    assert.deepEqual(await ask({ operation: "startCapture", audio: true, video: true }), { kind: "Unavailable", reason: "insecureContext" });
    assert.deepEqual(await ask({ operation: "permission", device: "camera" }), { kind: "Unavailable", reason: "insecureContext" });
    assert.deepEqual(browser.asked, []);
  });
  await withDom(BODY, async (document) => {
    Object.defineProperty(document.defaultView, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(document.defaultView?.navigator, "mediaDevices", { value: undefined, configurable: true });
    const { ask } = pack(document);
    assert.deepEqual(await ask({ operation: "startCapture", audio: false, video: true }), { kind: "Unavailable", reason: "notSupported" });
  });
});

test("each refusal is its own outcome: denied, not found, in use, overconstrained, and anything else by its name", async () => {
  const cases: readonly (readonly [string, MediaResult])[] = [
    ["NotAllowedError", { kind: "Denied" }],
    ["NotFoundError", { kind: "DeviceUnavailable", problem: "notFound" }],
    ["NotReadableError", { kind: "DeviceUnavailable", problem: "inUse" }],
    ["OverconstrainedError", { kind: "DeviceUnavailable", problem: "overconstrained" }],
    ["SecurityError", { kind: "Unavailable", reason: "blockedByPolicy" }],
    ["TypeError", { kind: "Failed", reason: "TypeError" }],
  ];
  for (const [name, expected] of cases) {
    await withDom(BODY, async (document) => {
      install(document.defaultView as Window, browserWith({ answer: () => Promise.reject(error(name)) }));
      assert.deepEqual(await pack(document).ask({ operation: "startCapture", audio: true, video: false }), expected, name);
    });
  }
});

test("capture asks for exactly the devices named, and nothing when nothing is asked", async () => {
  await withDom(BODY, async (document) => {
    const browser = browserWith();
    install(document.defaultView as Window, browser);
    const { ask } = pack(document);
    assert.deepEqual(await ask({ operation: "startCapture", audio: false, video: false }), { kind: "NothingRequested" });
    const result = await ask({ operation: "startCapture", audio: true, video: true, videoDevice: "cam-1" });
    assert.deepEqual(browser.asked, [{ audio: true, video: { deviceId: { exact: "cam-1" } } }]);
    assert.deepEqual((result as Extract<MediaResult, { kind: "Capturing" }>).tracks, [{ kind: "audio", label: "Fake audio" }, { kind: "video", label: "Fake video", width: 640, height: 480 }]);
    assert.deepEqual(await ask({ operation: "devices" }), { kind: "Devices", devices: [{ deviceId: "cam-1", kind: "videoinput", label: "" }, { deviceId: "mic-1", kind: "audioinput", label: "" }] });
  });
});

test("permission is read without asking; a change, including a revocation, is a fact", async () => {
  await withDom(BODY, async (document) => {
    const permission = Object.assign(new EventTarget(), { state: "prompt" });
    const browser = browserWith({ permission });
    install(document.defaultView as Window, browser);
    const facts: MediaFact[] = [];
    const { ask } = pack(document, facts);
    assert.deepEqual(await ask({ operation: "permission", device: "camera" }), { kind: "Permission", state: "prompt" });
    assert.deepEqual(await ask({ operation: "watchPermission", device: "camera" }), { kind: "Watching", state: "prompt" });
    permission.state = "granted"; permission.dispatchEvent(new Event("change"));
    permission.state = "prompt"; permission.dispatchEvent(new Event("change"));
    assert.deepEqual(await ask({ operation: "unwatchPermission", device: "camera" }), { kind: "Unwatched" });
    permission.state = "denied"; permission.dispatchEvent(new Event("change"));
    assert.deepEqual(facts, [{ kind: "PermissionChanged", device: "camera", state: "granted", previous: "prompt" }, { kind: "PermissionChanged", device: "camera", state: "prompt", previous: "granted" }]);
    assert.deepEqual(browser.asked, [], "reading and watching the permission never prompts");
  });
});

// --- lifecycle ----------------------------------------------------------------

test("stop ends every track and clears previews; the id is then stale", async () => {
  await withDom(BODY, async (document) => {
    const browser = browserWith();
    install(document.defaultView as Window, browser);
    const { ask } = pack(document);
    const id = capturing(await ask({ operation: "startCapture", audio: true, video: true }));
    assert.deepEqual(await ask({ operation: "preview", capture: id, target: { name: "self" } }), { kind: "Previewing" });
    const video = document.querySelector<HTMLVideoElement>('[data-media-preview="self"]');
    assert.equal(video?.srcObject, browser.streams[0] as unknown as MediaStream);
    assert.equal(video?.muted, true);
    assert.deepEqual(await ask({ operation: "stop", capture: id }), { kind: "Stopped" });
    assert.deepEqual(browser.streams[0]?.tracks.map((track) => track.stopped), [1, 1]);
    assert.equal(video?.srcObject, null);
    assert.deepEqual(await ask({ operation: "stop", capture: id }), { kind: "Stale", reason: "disposed" });
    // An id this page never issued (another session's, or invented) is stale too.
    assert.deepEqual(await ask({ operation: "preview", capture: "zz.1" as CaptureId, target: { name: "self" } }), { kind: "Stale", reason: "other-session" });
  });
});

test("previews name a <video> in HTML, by row key when there are several; none, several or the wrong element are answers", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, browserWith());
    const { ask } = pack(document);
    const id = capturing(await ask({ operation: "startCapture", audio: false, video: true }));
    assert.deepEqual(await ask({ operation: "preview", capture: id, target: { name: "tile" } }), { kind: "Ambiguous", count: 2 });
    assert.deepEqual(await ask({ operation: "preview", capture: id, target: { name: "tile", key: "b" } }), { kind: "Previewing" });
    assert.deepEqual(await ask({ operation: "preview", capture: id, target: { name: "nowhere" } }), { kind: "NotFound" });
    assert.deepEqual(await ask({ operation: "preview", capture: id, target: { name: "wrong" } }), { kind: "WrongElement" });
    const tile = document.querySelector('[data-media-key="b"] video') as HTMLVideoElement;
    assert.ok(tile.srcObject !== null);
    assert.deepEqual(await ask({ operation: "unpreview", target: { name: "tile", key: "b" } }), { kind: "Unpreviewed" });
    assert.equal(tile.srcObject, null);
  });
});

test("a capture that arrives after its request was cancelled is stopped at once and never reported", async () => {
  await withDom(BODY, async (document) => {
    const release: { grant?: () => void } = {};
    const browser = browserWith({ answer: (constraints) => new Promise((resolve) => { release.grant = () => resolve(fakeStream(constraints.audio !== false, constraints.video !== false)); }) });
    install(document.defaultView as Window, browser);
    const { ask, provider } = pack(document);
    const controller = new AbortController();
    const pending = ask({ operation: "startCapture", audio: true, video: true }, controller.signal);
    await settle();
    controller.abort();
    assert.deepEqual(await pending, { kind: "Cancelled" });
    release.grant?.();
    await settle();
    assert.deepEqual(browser.streams[0]?.tracks.map((track) => track.stopped), [1, 1], "the late stream's tracks were stopped");
    assert.equal(provider.dispose(), 0, "and it was never registered");
  });
});

test("a track the browser ends is a fact, and so is the capture ending; an ended capture cannot be previewed or recorded", async () => {
  await withDom(BODY, async (document) => {
    const browser = browserWith();
    install(document.defaultView as Window, browser);
    const facts: MediaFact[] = [];
    const { ask } = pack(document, facts);
    const id = capturing(await ask({ operation: "startCapture", audio: true, video: true }));
    browser.streams[0]?.tracks[1]?.end();
    browser.streams[0]?.tracks[0]?.end();
    assert.deepEqual(facts, [{ kind: "TrackEnded", capture: id, track: "video" }, { kind: "TrackEnded", capture: id, track: "audio" }, { kind: "CaptureEnded", capture: id }]);
    assert.deepEqual(await ask({ operation: "preview", capture: id, target: { name: "self" } }), { kind: "CaptureEnded" });
    assert.deepEqual(await ask({ operation: "record", capture: id }), { kind: "CaptureEnded" });
    assert.deepEqual(await ask({ operation: "stop", capture: id }), { kind: "Stopped" }, "the id stays valid until stop");
  });
});

test("recording: start, finish, read in bounded slices, release", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, browserWith({ recordable: (type) => type === "video/webm" }));
    const { ask } = pack(document);
    const id = capturing(await ask({ operation: "startCapture", audio: true, video: true }));
    assert.deepEqual(await ask({ operation: "record", capture: id, mimeType: "video/mp4;codecs=hevc" }), { kind: "NotRecordable", mimeType: "video/mp4;codecs=hevc" });
    const started = await ask({ operation: "record", capture: id, mimeType: "video/webm" });
    assert.equal(started.kind, "RecordingStarted");
    const recording = (started as Extract<MediaResult, { kind: "RecordingStarted" }>).recording;
    assert.deepEqual(await ask({ operation: "read", recording, offset: 0, length: 4 }), { kind: "StillRecording" });
    const finished = await ask({ operation: "finish", recording });
    assert.equal(finished.kind, "Recorded");
    assert.equal((finished as Extract<MediaResult, { kind: "Recorded" }>).bytes, "first-second".length);
    assert.deepEqual(await ask({ operation: "read", recording, offset: 6, length: 6 }), { kind: "Read", data: Buffer.from("second").toString("base64"), bytesRead: 6, eof: true });
    assert.deepEqual(await ask({ operation: "read", recording, offset: 0, length: MAX_READ_BYTES + 1 }), { kind: "TooLarge", limit: MAX_READ_BYTES });
    assert.deepEqual(await ask({ operation: "read", recording, offset: -1, length: 1 }), { kind: "InvalidRange" });
    assert.deepEqual(await ask({ operation: "release", recording }), { kind: "Released" });
    assert.deepEqual(await ask({ operation: "read", recording, offset: 0, length: 1 }), { kind: "Stale", reason: "disposed" });
  });
});

test("a recording its capture outlives is interrupted, as a fact, and finish still answers with what was recorded", async () => {
  await withDom(BODY, async (document) => {
    const browser = browserWith();
    install(document.defaultView as Window, browser);
    const facts: MediaFact[] = [];
    const { ask } = pack(document, facts);
    const id = capturing(await ask({ operation: "startCapture", audio: false, video: true }));
    const recording = (await ask({ operation: "record", capture: id }) as Extract<MediaResult, { kind: "RecordingStarted" }>).recording;
    browser.streams[0]?.tracks[0]?.end();
    await settle();
    assert.ok(facts.some((fact) => fact.kind === "RecordingInterrupted" && fact.recording === recording && fact.reason === "capture-ended"), JSON.stringify(facts));
    const finished = await ask({ operation: "finish", recording });
    assert.equal(finished.kind === "Recorded" && finished.bytes, "first-second".length);
  });
});

test("dispose at the host's teardown stops every capture and recording still owned", async () => {
  await withDom(BODY, async (document) => {
    const browser = browserWith();
    install(document.defaultView as Window, browser);
    const { ask, provider } = pack(document);
    const first = capturing(await ask({ operation: "startCapture", audio: true, video: false }));
    capturing(await ask({ operation: "startCapture", audio: false, video: true }));
    await ask({ operation: "record", capture: first });
    assert.equal(provider.dispose(), 3);
    assert.ok(browser.streams.every((stream) => stream.tracks.every((track) => track.stopped === 1)));
    assert.deepEqual(await ask({ operation: "stop", capture: first }), { kind: "Stale", reason: "disposed" });
  });
});

test("the provider passes the shared conformance suite", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, browserWith({ permission: Object.assign(new EventTarget(), { state: "prompt" }) }));
    assert.deepEqual(await runProviderConformance(mediaCapability(), {
      document, decodeResult: decodeMediaResult,
      valid: [{ name: "permission", payload: { operation: "permission", device: "microphone" } }, { name: "devices", payload: { operation: "devices" } }],
      malformed: [{ name: "capture without audio", payload: { operation: "startCapture", video: true } }, { name: "an unknown device", payload: { operation: "permission", device: "screen" } }, { name: "a numeric capture id", payload: { operation: "stop", capture: 7 } }],
      cancellable: { name: "devices", payload: { operation: "devices" } },
    }), []);
  });
});

test("no id of one kind is accepted as the other", async () => {
  await withDom(BODY, async (document) => {
    install(document.defaultView as Window, browserWith());
    const { ask } = pack(document);
    const id = capturing(await ask({ operation: "startCapture", audio: true, video: false }));
    // Captures and recordings are separate tables: one's id is never live in the other.
    assert.equal((await ask({ operation: "finish", recording: id as unknown as RecordingId })).kind, "Stale");
  });
});
