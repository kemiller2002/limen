# 10 — A canvas surface behind a governed adapter

A scatter plot drawn on a `<canvas>` at frame rate, with pan, zoom, hover,
keyboard navigation and a pulsing selection. The engine owns the data, the
selection and the viewport. It hears about the surface only through semantic
facts (kemiller2002/limen#45, LCP-039).

| Piece | Owns |
| --- | --- |
| [`scene.ts`](scene.ts) | The geometry, pure: world ↔ screen, hit testing, pan, zoom about a point, fit, the keyboard cursor's order |
| [`scatter-adapter.ts`](scatter-adapter.ts) | **The surface:** every pixel, the frame loop, device-pixel sizing, hit testing, hover, the keyboard cursor, and the live viewport while a gesture is in progress |
| [`engine.ts`](engine.ts) | **The meaning:** the points, which one is selected, the viewport it has adopted, the chart's lifecycle, and a count of every message it received |
| [`index.html`](index.html) | A `data-adapter-slot` for the surface, and buttons |
| [`main.ts`](main.ts) | The kernel, the adapters pack with this one adapter registered, and the focus pack |

## What crosses

| Direction | What | How often |
| --- | --- | --- |
| engine → surface | `{ points, selected, viewport }` as props | when the engine's state changes |
| surface → engine | `select { id }` | once per click, or per Enter |
| surface → engine | `viewport { cx, cy, zoom }` | once per settled gesture: the end of a drag, the wheel going quiet, a zoom key |
| engine → surface | `fit` and `stats` commands | when asked |

Measured in Chromium (`checks.ts`):

| Situation | Frames drawn | Messages across the boundary |
| --- | --- | --- |
| A second of idle animation | 65 | 0 |
| A 40-step drag | 71 | 1 |
| Narrowing the slot | the next frame, at the new size | 1, the button's own event |

The engine decides. A `select` for a point it does not know is ignored. A
settled viewport is adopted and not echoed back, because the surface already
shows it. **Nothing the surface holds is authoritative.** Hover and the
keyboard cursor are pixels and gestures, and the selection is only what the
engine sent back.

## Faults

"Break the chart" sends props the surface cannot draw. The adapters pack
quarantines the instance and reports it as `Faulted { phase: "update", reason:
"TypeError" }`. The engine shows a message, and the rest of the page keeps
working. "Show the chart" unmounts the quarantined instance and mounts a
fresh one.

## Integration with the generic packs

- **Focus:** the slot is a focus target, and the engine's `focusFirst`
  request moves focus into the canvas (`tabindex="0"`). Keys are then the
  surface's own.
- **Sizing:** the surface reads its own box every frame. The engine does not
  need the size. If it ever did (to choose a level of detail, say), the
  measure pack would report it.
- **Pointer:** the surface's own listeners do hit testing and gestures.
  Frame-rate input never becomes a message.

A map or a code editor has the same shape: its own internals, a small
declarative description as props, and semantic facts back.
