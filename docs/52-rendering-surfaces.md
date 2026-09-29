# Rendering surfaces behind governed adapters

Canvas, WebGL, WebGPU, maps, diagram editors and code editors fit behind the
governed adapter boundary ([docs/42](42-adapters.md)) without Limen
learning a single graphics primitive (kemiller2002/limen#45, LCP-039).

The reference is [example 10](../examples/10-canvas-surface/README.md), a
canvas scatter plot. It needs no new contract: the generic `limen.adapters`
contract already carries everything a surface needs.

## Ownership

| The surface owns | The engine owns |
| --- | --- |
| pixels and the frame loop | the data |
| device-pixel sizing | what is selected |
| hit testing, hover, the keyboard cursor | the viewport it has adopted |
| the live state of a gesture in progress | the surface's lifecycle: mount, update, unmount, remount |
| its imperative internal API | what any fact means |

## The rules

1. **Props are a small declarative scene, sent when the engine's state
   changes.** They are never a draw list, and never sent per frame. Mirroring
   the Canvas, WebGL or WebGPU API across the boundary is the anti-pattern.
2. **Facts are semantic, and settle before they are sent.** "The user chose
   this point" and "the view settled here" are facts. A pointer position is
   not, and neither is a frame. A gesture is one fact when it ends.
3. **The engine decides.** A fact is a request or an observation: a selection
   of an unknown id is ignored, and a settled viewport is adopted. What the
   surface holds is never authoritative. The engine's next props are the
   truth.
4. **A fault is contained.** Props a surface cannot use make it throw. The
   adapters pack quarantines it and reports the phase and the exception's
   name, and the engine decides whether to remount. Nothing else on the page
   is affected.
5. **Generic packs integrate from outside.** The focus pack moves focus into
   the slot. The measure pack reports sizes if the engine ever needs them. The
   surface's own input stays inside it.

These rules hold for a map (props: layers, markers, a camera; facts: a
feature chosen, the camera settled) and for an editor (props: the document
revision and diagnostics; facts: an edit batch, the cursor settled). None of
them depends on graphics.

## Bounded chatter, measured

Example 10's Chromium checks count both sides:

| Situation | Frames drawn | Messages across the boundary |
| --- | --- | --- |
| A second of idle animation | 65 | 0 |
| A 40-step drag | 71 | 1 |
| A click on a point | 1 fact, then props back | 2 |
| Narrowing the slot | the next frame, at the new size | 1, the button's own event |

In jsdom, [`test/canvas-surface.test.ts`](../test/canvas-surface.test.ts)
drives the frame clock by hand. A drag of 50 moves is one fact, and a burst
of 8 wheel notches is one fact after it settles. A mutation check confirmed
the drag test fails if the surface reports a viewport on every move.

## Proof

- [`test/canvas-surface.test.ts`](../test/canvas-surface.test.ts) (18 tests)
  covers:
  - the geometry;
  - frames drawn with zero messages;
  - one fact per click, drag or wheel burst;
  - the keyboard cursor;
  - update and `fit`;
  - unmount stopping the loop and listeners;
  - `NoCanvas`;
  - the engine's decisions and remount after a fault;
  - the page through the real kernel and adapters pack;
  - every projection against the view contract.
- [`examples/10-canvas-surface/checks.ts`](../examples/10-canvas-surface/checks.ts)
  (11 Chromium checks under the strict CSP) covers mount, idle animation, a
  real click, a real drag, focus through the focus pack, keyboard selection,
  zoom, resize, an isolated fault with remount, and unmount.
