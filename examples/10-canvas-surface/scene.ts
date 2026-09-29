// The scatter plot's geometry, pure: the same functions the adapter draws and
// hit-tests with, and the tests check without a canvas. Nothing here knows
// about the DOM or the engine.

export type Point = { readonly id: string; readonly label: string; readonly x: number; readonly y: number };

// What the engine sends as props: the data, the selection it decided on, and
// the viewport it holds. Small and declarative; never per frame.
export type Scene = { readonly points: readonly Point[]; readonly selected: string | null; readonly viewport: Viewport };

// The world coordinate at the centre of the surface, and pixels per unit.
export type Viewport = { readonly cx: number; readonly cy: number; readonly zoom: number };

export type Size = { readonly width: number; readonly height: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 400;

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

// World → surface pixels (y grows upward in the world, downward on screen).
export const toScreen = (viewport: Viewport, size: Size, point: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } => ({
  x: size.width / 2 + (point.x - viewport.cx) * viewport.zoom,
  y: size.height / 2 - (point.y - viewport.cy) * viewport.zoom,
});

export const toWorld = (viewport: Viewport, size: Size, pixel: { readonly x: number; readonly y: number }): { readonly x: number; readonly y: number } => ({
  x: viewport.cx + (pixel.x - size.width / 2) / viewport.zoom,
  y: viewport.cy - (pixel.y - size.height / 2) / viewport.zoom,
});

// The nearest point within radius pixels of a surface position, or null.
export const hitTest = (scene: Scene, size: Size, pixel: { readonly x: number; readonly y: number }, radius: number): string | null =>
  scene.points
    .map((point) => ({ id: point.id, at: toScreen(scene.viewport, size, point) }))
    .map(({ id, at }) => ({ id, distance: Math.hypot(at.x - pixel.x, at.y - pixel.y) }))
    .filter(({ distance }) => distance <= radius)
    .reduce<{ readonly id: string; readonly distance: number } | null>((best, next) => (best === null || next.distance < best.distance ? next : best), null)?.id ?? null;

// Dragging by a pixel delta moves the world the other way.
export const pan = (viewport: Viewport, dx: number, dy: number): Viewport => ({ ...viewport, cx: viewport.cx - dx / viewport.zoom, cy: viewport.cy + dy / viewport.zoom });

// Zooming keeps the world point under the pointer where it is.
export const zoomAt = (viewport: Viewport, size: Size, pixel: { readonly x: number; readonly y: number }, factor: number): Viewport => {
  const zoom = clampZoom(viewport.zoom * factor);
  const anchor = toWorld(viewport, size, pixel);
  return { zoom, cx: anchor.x - (pixel.x - size.width / 2) / zoom, cy: anchor.y + (pixel.y - size.height / 2) / zoom };
};

// Every point in view with a margin; the data's centre at the largest zoom that fits.
export const fit = (points: readonly Point[], size: Size, margin = 24): Viewport => {
  if (points.length === 0) return { cx: 0, cy: 0, zoom: MIN_ZOOM };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const spanX = Math.max(maxX - minX, 1e-9);
  const spanY = Math.max(maxY - minY, 1e-9);
  const zoom = clampZoom(Math.min((size.width - 2 * margin) / spanX, (size.height - 2 * margin) / spanY));
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, zoom };
};

// The next point for the keyboard cursor, in reading order of x.
export const nextPoint = (points: readonly Point[], current: string | null, step: 1 | -1): string | null => {
  const ordered = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (ordered.length === 0) return null;
  const at = ordered.findIndex((point) => point.id === current);
  const index = at === -1 ? (step === 1 ? 0 : ordered.length - 1) : (at + step + ordered.length) % ordered.length;
  return ordered[index]?.id ?? null;
};

// Props from the engine are untrusted JSON until they are a Scene.
export const sceneOf = (props: unknown): Scene => {
  const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);
  const number = (value: unknown, name: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} is not a finite number`);
    return value;
  };
  const points = field(props, "points");
  if (!Array.isArray(points)) throw new TypeError("points is not a list");
  const viewport = field(props, "viewport");
  const selected = field(props, "selected");
  return {
    points: points.map((point, index) => {
      const id = field(point, "id");
      const label = field(point, "label");
      if (typeof id !== "string" || typeof label !== "string") throw new TypeError(`points[${index}] needs an id and a label`);
      return { id, label, x: number(field(point, "x"), `points[${index}].x`), y: number(field(point, "y"), `points[${index}].y`) };
    }),
    selected: typeof selected === "string" ? selected : null,
    viewport: { cx: number(field(viewport, "cx"), "viewport.cx"), cy: number(field(viewport, "cy"), "viewport.cy"), zoom: clampZoom(number(field(viewport, "zoom"), "viewport.zoom")) },
  };
};
