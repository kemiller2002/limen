// Real-browser checks for the canvas surface, run only with ?check by
// scripts/smoke-packs.ts (kemiller2002/limen#45). Real pointer drags, clicks
// and key presses are performed by the runner. The central claim is measured:
// the surface draws at frame rate while the boundary carries only semantic
// facts. Never loaded in normal use.

import { initialState } from "./engine.js";
import { toScreen } from "./scene.js";

type Check = { readonly name: string; readonly ok: boolean; readonly detail: string };
type Action =
  | { readonly kind: "press"; readonly selector: string; readonly key: string }
  | { readonly kind: "drag"; readonly from: readonly [number, number]; readonly to: readonly [number, number]; readonly steps: number };

const checks: Check[] = [];
const expect = (name: string, ok: boolean, detail: unknown): void => { checks.push({ name, ok, detail: JSON.stringify(detail) }); };
const pause = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const perform = (action: Action): Promise<void> => new Promise((resolve) => {
  Reflect.set(window, "__limenPackActionDone", () => { void pause(80).then(resolve); });
  Reflect.set(window, "__limenPackAction", action);
});
const text = (id: string): string => document.getElementById(id)?.textContent ?? "";
const messages = (): number => Number(text("messages"));
const click = async (id: string): Promise<void> => { document.getElementById(id)?.click(); await pause(80); };
const canvas = (): HTMLCanvasElement | null => document.querySelector("#chart canvas");
// The surface's own counters, asked for through the engine. Asking costs two
// messages (the click and the command's answer), accounted for below.
const measure = async (): Promise<{ readonly frames: number; readonly emitted: number; readonly width: number }> => {
  await click("measure-surface");
  return { frames: Number(text("surface-frames")), emitted: Number(text("surface-emitted")), width: Number(text("surface-width")) };
};
const waitFor = async (predicate: () => boolean, ms = 3000): Promise<boolean> => {
  const deadline = Date.now() + ms;
  const poll = async (): Promise<boolean> => (predicate() || Date.now() > deadline ? predicate() : (await pause(30), poll()));
  return poll();
};

await waitFor(() => text("chart-status") === "mounted" && canvas() !== null);
expect("the engine mounts the scatter adapter into its slot; the surface owns a canvas the engine never sees", text("chart-status") === "mounted" && canvas() !== null, text("chart-status"));

// --- idle animation: frames, no messages -----------------------------------------
const idleStart = await measure();
const idleMessages = messages();
await pause(1000);
const idleMessagesAfter = messages();
const idleEnd = await measure();
expect("animating for a second draws about sixty frames and sends nothing across the boundary",
  idleEnd.frames - idleStart.frames >= 30 && idleMessagesAfter === idleMessages && idleEnd.emitted === idleStart.emitted,
  { frames: idleEnd.frames - idleStart.frames, messages: idleMessagesAfter - idleMessages });

// --- pointer: a click on a point is one semantic fact ---------------------------
const surface = canvas();
const box = surface?.getBoundingClientRect();
const first = initialState.points[0];
if (surface === null || box === undefined || first === undefined) throw new Error("no surface");
const at = toScreen(initialState.viewport, { width: box.width, height: box.height }, first);
const beforeSelect = messages();
await perform({ kind: "drag", from: [box.left + at.x, box.top + at.y], to: [box.left + at.x, box.top + at.y], steps: 1 });
await waitFor(() => text("selection").startsWith(first.label));
expect("a real click on a point is one select fact; the engine decides, and its selection comes back as props",
  text("selection").startsWith(`${first.label}:`) && messages() - beforeSelect === 2,
  { selection: text("selection"), messages: messages() - beforeSelect });

// --- a drag: many frames, one fact ------------------------------------------------
const dragStart = await measure();
const beforeDrag = messages();
await perform({ kind: "drag", from: [box.left + 100, box.top + 100], to: [box.left + 300, box.top + 220], steps: 40 });
await pause(300);
const afterDrag = messages();
const dragEnd = await measure();
expect("a 40-step drag pans at frame rate and sends exactly one viewport fact when it settles",
  afterDrag - beforeDrag === 1 && dragEnd.emitted - dragStart.emitted === 1 && dragEnd.frames - dragStart.frames >= 10,
  { messages: afterDrag - beforeDrag, emitted: dragEnd.emitted - dragStart.emitted, frames: dragEnd.frames - dragStart.frames });

// --- focus and keyboard, through the focus pack -------------------------------------
await click("focus-chart");
await waitFor(() => document.activeElement === canvas());
expect("the focus pack moves focus into the surface (focusFirst in the slot)", document.activeElement === canvas(), document.activeElement?.tagName);
await perform({ kind: "press", selector: "#chart canvas", key: "ArrowRight" });
await perform({ kind: "press", selector: "#chart canvas", key: "Enter" });
const leftmost = [...initialState.points].sort((a, b) => a.x - b.x || a.y - b.y)[0];
await waitFor(() => text("selection").startsWith(`${leftmost?.label ?? "?"}:`));
expect("the keyboard cursor is the surface's; Enter reports a select fact for the engine to adopt", text("selection").startsWith(`${leftmost?.label ?? "?"}:`), text("selection"));
const zoomBefore = text("zoom");
await perform({ kind: "press", selector: "#chart canvas", key: "+" });
await waitFor(() => text("zoom") !== zoomBefore);
expect("a zoom key settles at once: one viewport fact, adopted by the engine", text("zoom") !== zoomBefore, { before: zoomBefore, after: text("zoom") });

// --- resize: the surface's own concern -----------------------------------------------
const wideSurface = await measure();
const beforeResize = messages();
await click("toggle-width");
await pause(200);
const afterResize = messages();
const narrowSurface = await measure();
expect("narrowing the slot resizes the backing store on the next frame; the only message is the button's own event",
  narrowSurface.width < wideSurface.width && afterResize - beforeResize === 1 && narrowSurface.emitted === wideSurface.emitted,
  { wide: wideSurface.width, narrow: narrowSurface.width, messages: afterResize - beforeResize });

// --- a fault is isolated -----------------------------------------------------------
await click("break-chart");
await waitFor(() => text("chart-status").startsWith("The chart stopped"));
const pointsBefore = Number(text("point-count"));
await click("add-point");
expect("props the surface cannot draw fault it, quarantined and diagnosable; the rest of the page keeps working",
  text("chart-status").includes("update: TypeError") && Number(text("point-count")) === pointsBefore + 1,
  { status: text("chart-status"), points: text("point-count") });
await click("show-chart");
await waitFor(() => text("chart-status") === "mounted");
expect("the engine remounts it: the quarantined instance is unmounted and a fresh one draws", text("chart-status") === "mounted" && canvas() !== null, text("chart-status"));

// --- unmount -------------------------------------------------------------------------
await click("hide-chart");
await waitFor(() => canvas() === null);
expect("removing the slot unmounts the surface: no canvas is left behind", canvas() === null && text("chart-status") === "hidden", text("chart-status"));

Reflect.set(window, "__limenPackResult", { pack: "canvas-surface", checks });
