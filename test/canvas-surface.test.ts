// An opaque rendering surface behind the governed adapter contract
// (kemiller2002/limen#45, LCP-039): example 10's scatter plot. The geometry
// is pure; the adapter is driven here with a recording 2D context and a
// hand-cranked frame clock, so "a frame is never a message" is counted
// exactly; the engine's transitions keep selection and viewport its own; and
// the whole page runs through the real kernel and adapters pack. Real pointer,
// keyboard, focus and resize behaviour in Chromium:
// examples/10-canvas-surface/checks.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { adaptersCapability } from "../dist/capabilities/adapters/index.js";
import { focusCapability } from "../dist/capabilities/focus/index.js";
import { fit, hitTest, nextPoint, pan, sceneOf, toScreen, toWorld, zoomAt, type Scene } from "../examples/10-canvas-surface/scene.ts";
import { scatterAdapter } from "../examples/10-canvas-surface/scatter-adapter.ts";
import { createCanvasTransport, initialState, onEvent, onFact, onResult, sceneProps, type State } from "../examples/10-canvas-surface/engine.ts";
import { exampleBody, withDom } from "./dom-helpers.ts";
import { conforming, assertEveryProjectionConformed } from "./view-conformance.ts";

const SIZE = { width: 300, height: 200 };
const scene: Scene = { points: [{ id: "a", label: "A", x: 0, y: 0 }, { id: "b", label: "B", x: 5, y: 5 }, { id: "c", label: "C", x: -5, y: 2 }], selected: null, viewport: { cx: 0, cy: 0, zoom: 10 } };

// --- geometry ---------------------------------------------------------------------

test("geometry: screen and world are inverses; the centre is the viewport's centre", () => {
  const pixel = toScreen(scene.viewport, SIZE, { x: 5, y: 5 });
  assert.deepEqual(pixel, { x: 200, y: 50 });
  assert.deepEqual(toWorld(scene.viewport, SIZE, pixel), { x: 5, y: 5 });
  assert.deepEqual(toScreen(scene.viewport, SIZE, { x: 0, y: 0 }), { x: 150, y: 100 });
});

test("geometry: hit testing picks the nearest point within the radius, or none", () => {
  assert.equal(hitTest(scene, SIZE, { x: 152, y: 101 }, 12), "a");
  assert.equal(hitTest(scene, SIZE, { x: 196, y: 54 }, 12), "b");
  assert.equal(hitTest(scene, SIZE, { x: 10, y: 10 }, 12), null);
});

test("geometry: panning moves the world against the drag; zooming keeps the point under the pointer still", () => {
  assert.deepEqual(pan(scene.viewport, 20, -10), { cx: -2, cy: -1, zoom: 10 });
  const pointer = { x: 200, y: 50 };
  const zoomed = zoomAt(scene.viewport, SIZE, pointer, 2);
  assert.equal(zoomed.zoom, 20);
  const stayed = toScreen(zoomed, SIZE, { x: 5, y: 5 });
  assert.ok(Math.abs(stayed.x - 200) < 1e-9 && Math.abs(stayed.y - 50) < 1e-9);
  assert.equal(zoomAt(scene.viewport, SIZE, pointer, 1e9).zoom, 400, "zoom is clamped");
});

test("geometry: fit puts every point inside the surface; the keyboard cursor walks points by x and wraps", () => {
  const view = fit(scene.points, SIZE);
  assert.ok(scene.points.every((point) => { const at = toScreen(view, SIZE, point); return at.x >= 0 && at.x <= SIZE.width && at.y >= 0 && at.y <= SIZE.height; }));
  assert.deepEqual([nextPoint(scene.points, null, 1), nextPoint(scene.points, "c", 1), nextPoint(scene.points, "b", 1), nextPoint(scene.points, null, -1)], ["c", "a", "c", "b"]);
});

test("props are untrusted until they are a scene", () => {
  assert.deepEqual(sceneOf(sceneProps(initialState)).points.length, 24);
  assert.throws(() => sceneOf({ points: "not a list" }), TypeError);
  assert.throws(() => sceneOf({ points: [{ id: "a", label: "A", x: Number.NaN, y: 0 }], viewport: { cx: 0, cy: 0, zoom: 1 } }), /finite/);
});

// --- the adapter, frame by frame ----------------------------------------------------

type Recording = { readonly calls: string[] };
const recordingContext = (recording: Recording): CanvasRenderingContext2D => new Proxy({}, {
  get: (_target, name) => (typeof name === "string" && ["setTransform", "clearRect", "beginPath", "arc", "fill", "stroke"].includes(name) ? (..._args: unknown[]) => { recording.calls.push(name); } : undefined),
  set: () => true,
}) as CanvasRenderingContext2D;

type Clock = { readonly pending: Map<number, (time: number) => void>; next: number; readonly crank: (frames: number) => void };
const clock = (): Clock => {
  const self: Clock = {
    pending: new Map(),
    next: 1,
    crank: (frames) => { Array.from({ length: frames }).forEach((_, index) => { const due = [...self.pending]; self.pending.clear(); due.forEach(([, callback]) => callback(index * 16)); }); },
  };
  return self;
};

const pointer = (window: Window, type: string, x: number, y: number): Event => Object.assign(new window.MouseEvent(type, { clientX: x, clientY: y, bubbles: true }), { pointerId: 1 });

const mounted = async (act: (tools: { readonly canvas: HTMLCanvasElement; readonly emitted: [string, unknown][]; readonly frames: Clock; readonly recording: Recording; readonly instance: ReturnType<ReturnType<typeof scatterAdapter>["mount"]>; readonly window: Window }) => Promise<void> | void): Promise<void> => {
  await withDom(`<section data-adapter-slot="chart"></section>`, async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const frames = clock();
    const recording: Recording = { calls: [] };
    const adapter = scatterAdapter({ context: () => recordingContext(recording), frame: (callback) => { const handle = frames.next++; frames.pending.set(handle, callback); return handle; }, cancelFrame: (handle) => { frames.pending.delete(handle); } });
    const emitted: [string, unknown][] = [];
    const slot = document.querySelector<HTMLElement>("[data-adapter-slot]") ?? assert.fail("slot");
    const instance = adapter.mount({ slot, emit: (name, data) => { emitted.push([name, data]); } }, scene);
    const canvas = slot.querySelector("canvas") ?? assert.fail("canvas");
    await act({ canvas, emitted, frames, recording, instance, window });
  });
};

test("the surface draws every frame, one arc per point, and a frame is never a message", async () => {
  await mounted(({ emitted, frames, recording, instance }) => {
    frames.crank(60);
    assert.equal(recording.calls.filter((call) => call === "arc").length, 60 * scene.points.length);
    assert.deepEqual(emitted, []);
    assert.deepEqual(instance.commands?.stats?.(null), { frames: 60, emitted: 0, width: 300, height: 200 });
  });
});

test("a click on a point is one select fact; a click on nothing is none", async () => {
  await mounted(({ canvas, emitted, window }) => {
    canvas.dispatchEvent(pointer(window, "pointerdown", 151, 100));
    canvas.dispatchEvent(pointer(window, "pointerup", 151, 100));
    canvas.dispatchEvent(pointer(window, "pointerdown", 5, 5));
    canvas.dispatchEvent(pointer(window, "pointerup", 5, 5));
    assert.deepEqual(emitted, [["select", { id: "a" }]]);
  });
});

test("a drag of any length is one viewport fact, sent when it settles", async () => {
  await mounted(({ canvas, emitted, frames, window }) => {
    canvas.dispatchEvent(pointer(window, "pointerdown", 100, 100));
    Array.from({ length: 50 }, (_, step) => step + 1).forEach((step) => { canvas.dispatchEvent(pointer(window, "pointermove", 100 + step * 2, 100 + step)); frames.crank(1); });
    assert.deepEqual(emitted, [], "nothing while the gesture is in progress");
    canvas.dispatchEvent(pointer(window, "pointerup", 200, 150));
    assert.deepEqual(emitted, [["viewport", { cx: -10, cy: 5, zoom: 10 }]]);
  });
});

test("a burst of wheel notches is one viewport fact, after it settles", async () => {
  await mounted(async ({ canvas, emitted, window }) => {
    Array.from({ length: 8 }).forEach(() => canvas.dispatchEvent(Object.assign(new window.MouseEvent("wheel", { clientX: 150, clientY: 100, cancelable: true }), { deltaY: -100 })));
    assert.deepEqual(emitted, []);
    await new Promise((resolve) => { setTimeout(resolve, 260); });
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0]?.[0], "viewport");
  });
});

test("the keyboard cursor is the surface's own; Enter reports it as a select fact; other keys are left alone", async () => {
  await mounted(({ canvas, emitted, window }) => {
    const key = (name: string): boolean => canvas.dispatchEvent(new window.KeyboardEvent("keydown", { key: name, cancelable: true }));
    assert.equal(key("ArrowRight"), false, "a handled key's default is prevented");
    key("ArrowRight");
    key("Enter");
    assert.equal(key("Tab"), true, "Tab still moves focus out");
    assert.deepEqual(emitted, [["select", { id: "a" }]]);
  });
});

test("update replaces the scene; fit answers the viewport for the engine to adopt", async () => {
  await mounted(({ frames, recording, instance }) => {
    instance.update({ ...scene, points: [...scene.points, { id: "d", label: "D", x: 9, y: 9 }], selected: "d" });
    recording.calls.length = 0;
    frames.crank(1);
    assert.equal(recording.calls.filter((call) => call === "arc").length, 4);
    const view = instance.commands?.fit?.(null);
    assert.ok(typeof view === "object" && view !== null && "zoom" in view);
    assert.throws(() => instance.update({ points: 3 }), TypeError, "a scene it cannot draw throws, and the pack quarantines it");
  });
});

test("unmount stops the frame loop, removes the listeners and leaves no canvas", async () => {
  await mounted(({ canvas, emitted, frames, instance, window }) => {
    frames.crank(2);
    instance.unmount();
    assert.equal(frames.pending.size, 0, "no frame is scheduled after unmount");
    canvas.dispatchEvent(pointer(window, "pointerdown", 151, 100));
    canvas.dispatchEvent(pointer(window, "pointerup", 151, 100));
    assert.deepEqual(emitted, []);
    assert.equal(canvas.isConnected, false);
  });
});

test("a browser with no 2D context refuses to mount, by name", async () => {
  await withDom(`<section data-adapter-slot="chart"></section>`, async (document) => {
    const slot = document.querySelector<HTMLElement>("[data-adapter-slot]") ?? assert.fail("slot");
    assert.throws(() => scatterAdapter({ context: () => null }).mount({ slot, emit: () => {} }, scene), (error: unknown) => error instanceof Error && error.name === "NoCanvas");
  });
});

// --- the engine's decisions ----------------------------------------------------------

const mountedState: State = { ...initialState, chart: { kind: "mounted", instance: "i-1" as never } };
const fact = (name: string, data: unknown) => ({ kind: "AdapterEvent", instance: "i-1", name, data });

test("the engine selects only points it knows, and pushes the new selection back as props", () => {
  const chosen = onFact(mountedState, fact("select", { id: "p3" }));
  assert.equal(chosen.state.selected, "p3");
  assert.deepEqual(chosen.requests, [{ operation: "update", instance: "i-1", props: sceneProps(chosen.state) }]);
  assert.deepEqual(onFact(mountedState, fact("select", { id: "p999" })), { state: mountedState, requests: [] });
});

test("a settled viewport is adopted without echoing it back; a malformed one is ignored", () => {
  const adopted = onFact(mountedState, fact("viewport", { cx: 1, cy: 2, zoom: 3 }));
  assert.deepEqual([adopted.state.viewport, adopted.requests], [{ cx: 1, cy: 2, zoom: 3 }, []]);
  assert.deepEqual(onFact(mountedState, fact("viewport", { cx: "1" })).state.viewport, mountedState.viewport);
});

test("a fault quarantines the chart; showing it again unmounts the quarantined instance before mounting a fresh one", () => {
  const faulted = onResult(mountedState, { kind: "Faulted", phase: "update", reason: "TypeError" }).state;
  assert.deepEqual(faulted.chart, { kind: "faulted", phase: "update", reason: "TypeError", instance: "i-1" });
  const again = onEvent(faulted, "showChart");
  assert.deepEqual(again.requests.map((request) => request.operation), ["unmount", "mount"]);
  assert.equal(again.state.chart.kind, "mounting");
  assert.deepEqual(onEvent(mountedState, "showChart").requests, [], "an already mounted chart is not mounted twice");
});

test("the page through the real kernel and adapters pack: mounted, drawn, selected, faulted, isolated", async () => {
  const body = await exampleBody("10-canvas-surface");
  await withDom(body, async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const frames = clock();
    const adapter = scatterAdapter({ context: () => recordingContext({ calls: [] }), frame: (callback) => { const handle = frames.next++; frames.pending.set(handle, callback); return handle; }, cancelFrame: (handle) => { frames.pending.delete(handle); } });
    await new BrowserKernel(conforming("10-canvas-surface", createCanvasTransport()), document, undefined, { capabilities: [adaptersCapability({ adapters: [adapter] }), focusCapability()], requireHandshake: true }).start();
    const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 20); });
    const text = (id: string): string => document.getElementById(id)?.textContent ?? "";
    await settle();
    assert.equal(text("chart-status"), "mounted");
    const canvas = document.querySelector("#chart canvas") ?? assert.fail("canvas");
    const before = Number(text("messages"));
    frames.crank(120);
    await settle();
    assert.equal(Number(text("messages")), before, "120 frames, no messages");
    const at = toScreen(initialState.viewport, { width: 300, height: 200 }, initialState.points[0] ?? assert.fail("point"));
    canvas.dispatchEvent(pointer(window, "pointerdown", at.x, at.y));
    canvas.dispatchEvent(pointer(window, "pointerup", at.x, at.y));
    await settle();
    assert.match(text("selection"), /^Sample 1:/);
    document.getElementById("break-chart")?.click();
    await settle();
    assert.match(text("chart-status"), /stopped \(update: TypeError\)/);
    document.getElementById("add-point")?.click();
    await settle();
    assert.equal(text("point-count"), "25", "the rest of the page is unaffected");
  });
});

test("every projection the canvas example made matched its view contract", () => {
  assertEveryProjectionConformed(["10-canvas-surface"]);
});
