// An opaque, high-frequency rendering surface behind the governed adapter
// contract (kemiller2002/limen#45, LCP-039): a Canvas scatter plot.
//
// Ownership:
//   the surface owns   pixels, the animation frame loop, device-pixel sizing,
//                      hit testing, hover, the keyboard cursor, and the live
//                      viewport while a gesture is in progress;
//   the engine owns    the data, the selection, and the viewport it adopts.
//
// So the engine sends a small declarative scene as props, only when its state
// changes, and hears only semantic facts:
//   select   { id }            a point the user chose (the engine decides)
//   viewport { cx, cy, zoom }  where a pan or zoom settled, once per gesture
// A frame is never a message. Dragging for a second renders about sixty frames
// and sends one fact.
//
// Nothing here is a Limen graphics primitive; the kernel and the pack know
// nothing about canvases. A map or an editor has the same shape: its own
// internals, props in, semantic facts out.

import { defineAdapter, type Adapter } from "../../dist/capabilities/adapters/index.js";
import { fit, hitTest, nextPoint, pan, sceneOf, zoomAt, type Point, type Scene, type Size, type Viewport } from "./scene.js";

export type SurfaceHooks = {
  // The drawing context; a test supplies a recording one.
  readonly context?: (canvas: HTMLCanvasElement) => CanvasRenderingContext2D | null;
  readonly frame?: (callback: (time: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
};

type Drag = { readonly pointer: number; readonly start: { readonly x: number; readonly y: number }; readonly from: Viewport; readonly moved: boolean };

// The surface's own state: pixels and gestures, never application meaning.
type Surface = {
  scene: Scene;
  view: Viewport;
  hover: string | null;
  cursor: string | null;
  drag: Drag | null;
  frames: number;
  emitted: number;
  running: boolean;
  handle: number;
  wheelTimer: ReturnType<typeof setTimeout> | undefined;
};

const RADIUS = 6;
const HIT = 12;
const KEYS = new Set(["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Enter", " ", "+", "=", "-"]);

const draw = (context: CanvasRenderingContext2D, surface: Surface, size: Size, ratio: number, time: number): void => {
  const { scene, view } = surface;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, size.width, size.height);
  const at = (point: Point): { readonly x: number; readonly y: number } => ({
    x: size.width / 2 + (point.x - view.cx) * view.zoom,
    y: size.height / 2 - (point.y - view.cy) * view.zoom,
  });
  scene.points.forEach((point) => {
    const { x, y } = at(point);
    const selected = point.id === scene.selected;
    // The selection pulses: animation the engine never hears about.
    const radius = selected ? RADIUS + 2 + Math.sin(time / 200) * 2 : RADIUS;
    context.beginPath();
    context.arc(x, y, Math.max(radius, 1), 0, Math.PI * 2);
    context.fillStyle = selected ? "#c2410c" : "#1d4ed8";
    context.fill();
    if (point.id === surface.hover || point.id === surface.cursor) {
      context.beginPath();
      context.arc(x, y, RADIUS + 5, 0, Math.PI * 2);
      context.strokeStyle = point.id === surface.cursor ? "#111827" : "#6b7280";
      context.lineWidth = 2;
      context.stroke();
    }
  });
};

export const scatterAdapter = (hooks: SurfaceHooks = {}): Adapter => defineAdapter({
  id: "scatter",
  version: 1,
  mount: ({ slot, emit }, props) => {
    const scene = sceneOf(props);
    const document = slot.ownerDocument;
    const view = document.defaultView;
    const canvas = document.createElement("canvas");
    const context = (hooks.context ?? ((element: HTMLCanvasElement) => element.getContext("2d")))(canvas);
    if (context === null) throw Object.assign(new Error("no 2D context"), { name: "NoCanvas" });
    const frame = hooks.frame ?? ((callback: (time: number) => void) => view?.requestAnimationFrame(callback) ?? 0);
    const cancelFrame = hooks.cancelFrame ?? ((handle: number) => view?.cancelAnimationFrame(handle));
    canvas.tabIndex = 0;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-roledescription", "scatter plot");
    canvas.setAttribute("aria-label", "Scatter plot. Arrow keys move between points, Enter selects, plus and minus zoom.");
    slot.replaceChildren(canvas);

    const surface: Surface = { scene, view: scene.viewport, hover: null, cursor: null, drag: null, frames: 0, emitted: 0, running: true, handle: 0, wheelTimer: undefined };
    const report = (name: string, data: unknown): void => { surface.emitted += 1; emit(name, data); };
    const sizeOf = (): Size => ({ width: canvas.clientWidth || slot.clientWidth || 300, height: canvas.clientHeight || slot.clientHeight || 200 });
    const local = (event: MouseEvent): { readonly x: number; readonly y: number } => {
      const box = canvas.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    // The frame loop: sizes the backing store to the device's pixels and
    // draws. Resizing needs no message either; the next frame picks it up.
    const tick = (time: number): void => {
      if (!surface.running) return;
      const size = sizeOf();
      const ratio = view?.devicePixelRatio ?? 1;
      const width = Math.round(size.width * ratio);
      const height = Math.round(size.height * ratio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      draw(context, surface, size, ratio, time);
      surface.frames += 1;
      surface.handle = frame(tick);
    };
    surface.handle = frame(tick);

    const onPointerDown = (event: PointerEvent): void => {
      surface.drag = { pointer: event.pointerId, start: local(event), from: surface.view, moved: false };
      if (typeof canvas.setPointerCapture === "function") { try { canvas.setPointerCapture(event.pointerId); } catch { /* not capturable */ } }
    };
    const onPointerMove = (event: PointerEvent): void => {
      const point = local(event);
      const drag = surface.drag;
      if (drag === null || drag.pointer !== event.pointerId) {
        surface.hover = hitTest(surface.scene, sizeOf(), point, HIT);
        return;
      }
      const dx = point.x - drag.start.x;
      const dy = point.y - drag.start.y;
      const moved = drag.moved || Math.hypot(dx, dy) > 3;
      surface.drag = { ...drag, moved };
      if (moved) surface.view = pan(drag.from, dx, dy);
    };
    const onPointerUp = (event: PointerEvent): void => {
      const drag = surface.drag;
      surface.drag = null;
      if (drag === null || drag.pointer !== event.pointerId) return;
      if (drag.moved) { report("viewport", surface.view); return; }
      const hit = hitTest(surface.scene, sizeOf(), local(event), HIT);
      if (hit !== null) report("select", { id: hit });
    };
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      surface.view = zoomAt(surface.view, sizeOf(), local(event), Math.exp(-event.deltaY / 500));
      // One fact when the wheel settles, not one per notch.
      clearTimeout(surface.wheelTimer);
      surface.wheelTimer = setTimeout(() => { report("viewport", surface.view); }, 200);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (!KEYS.has(event.key)) return;
      event.preventDefault();
      const size = sizeOf();
      const centre = { x: size.width / 2, y: size.height / 2 };
      switch (event.key) {
        case "ArrowRight": case "ArrowDown": surface.cursor = nextPoint(surface.scene.points, surface.cursor, 1); return;
        case "ArrowLeft": case "ArrowUp": surface.cursor = nextPoint(surface.scene.points, surface.cursor, -1); return;
        case "Enter": case " ": if (surface.cursor !== null) report("select", { id: surface.cursor }); return;
        case "+": case "=": surface.view = zoomAt(surface.view, size, centre, 1.25); report("viewport", surface.view); return;
        case "-": surface.view = zoomAt(surface.view, size, centre, 0.8); report("viewport", surface.view); return;
      }
    };
    const onLeave = (): void => { surface.hover = null; };
    const listeners: readonly (readonly [string, (event: never) => void])[] = [
      ["pointerdown", onPointerDown], ["pointermove", onPointerMove], ["pointerup", onPointerUp], ["pointercancel", onPointerUp],
      ["pointerleave", onLeave], ["wheel", onWheel], ["keydown", onKey],
    ];
    listeners.forEach(([type, listener]) => canvas.addEventListener(type, listener as EventListener, type === "wheel" ? { passive: false } : undefined));

    return {
      // New data, a new selection or a viewport the engine chose. The engine's
      // viewport replaces the live one; a gesture in progress continues from it.
      update: (next) => {
        const scene = sceneOf(next);
        surface.scene = scene;
        surface.view = scene.viewport;
        surface.cursor = scene.points.some((point) => point.id === surface.cursor) ? surface.cursor : null;
      },
      commands: {
        // Every point in view. The answer is the viewport, for the engine to adopt.
        fit: () => {
          surface.view = fit(surface.scene.points, sizeOf());
          return surface.view;
        },
        // How much drawing happened, and how much crossed the boundary.
        stats: () => ({ frames: surface.frames, emitted: surface.emitted, width: canvas.width, height: canvas.height }),
      },
      unmount: () => {
        surface.running = false;
        cancelFrame(surface.handle);
        clearTimeout(surface.wheelTimer);
        listeners.forEach(([type, listener]) => canvas.removeEventListener(type, listener as EventListener));
        canvas.remove();
      },
    };
  },
});
