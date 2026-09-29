# Overlays and the top layer

> **Optional — not Limen Core.** This is the overlay pack, a capability pack. It composes with the Core concept `typed-capabilities`: the top layer is requested through the Capability seam. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Modal dialogs, popovers, menus and anchored popups, native-first
(kemiller2002/limen#49, LCP-013).

The browser already has the hard parts:

- `<dialog>`'s `showModal()` puts the dialog in the **top layer**, above every
  `overflow: hidden`, `z-index` and stacking context;
- it makes the rest of the page inert, moves focus into the dialog (to an
  `autofocus` control, or the first focusable one), and returns focus to where
  it was when the dialog closes;
- the `popover` attribute gives the same top layer to menus and hints, with
  light dismiss, Escape, and nested close order built in.

So the overlay pack does not reimplement any of that. It calls those methods on
named targets, when the engine asks, and reports what the browser did. The
engine owns **whether** an overlay should be open; the browser owns **how**.

```ts
import { overlayCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/overlay";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [overlayCapability()] }).start();
```

```html
<dialog data-overlay-target="rename" aria-labelledby="rename-title">
  <h2 id="rename-title">Rename</h2>
  <input autofocus data-bind-value="name" data-event="nameChanged">
  <form method="dialog"><button value="ok">OK</button></form>
</dialog>

<button data-overlay-target="menuButton" data-event="openMenu" aria-haspopup="menu" data-bind-aria-expanded="menuOpen">Actions</button>
<div popover data-overlay-target="menu" role="menu">…</div>
```

The contract is [`contract/overlay.contract.json`](../contract/overlay.contract.json),
with bindings for TypeScript, F#, C# and Rust.

| Request | Answer |
| --- | --- |
| `showModal { target }` | `Shown`; `AlreadyOpen` if it was open (a non-modal dialog is **not** upgraded) |
| `show { target }` | `Shown` (non-modal); `AlreadyOpen` |
| `close { target, returnValue? }` | `Closed`; `NotOpen` if it was already closed |
| `showPopover { target, anchor?, sides }` | `Shown { placement? }`; `AlreadyOpen` |
| `hidePopover { target }` | `Closed`; `NotOpen` |
| `support {}` | `Support { dialog, popover }` |
| failures | `NotFound`, `Ambiguous { count }`, `WrongElement` (not a `<dialog>`, or no `popover` attribute), `Refused { reason }` (the browser threw; the exception's name only), `Unsupported`, `Cancelled` |

Targets resolve exactly as the focus and measure packs' do:
`data-overlay-target` names the element, and inside a `data-each` row the
engine projects `data-bind-data-overlay-key` onto an ancestor. None and several
matches are answers, never guesses.

## Dismissal is a fact the engine adopts

A user can close an overlay without asking the engine: Escape, a close request,
a click outside a popover, the dialog's own `method=dialog` form. The browser
has already closed it by the time anyone hears. The pack reports it once:

```text
Dismissed { target, reason, returnValue? }
```

| reason | when |
| --- | --- |
| `cancel` | a dialog closed by Escape or another close request |
| `lightDismiss` | a popover closed by Escape, a click outside, an ancestor popover closing, or a modal dialog opening |
| `submitted` | a dialog closed by its own `method=dialog` form; `returnValue` is the form's value, when not empty |

The engine **adopts** a dismissal, just as it adopts `LocationChanged` after
Back ([07](07-effects-and-browser-interop.md), [31](31-routing.md)). The pack never reopens an
overlay, and an engine that wants to refuse a dismissal must decide to show it
again itself. Closes the engine asked for (`close`, `hidePopover`) are **not**
reported back: the engine already knows.

`cancel` covers every dialog close the engine did not ask for and no form
made. That is deliberate. Chromium skips the `cancel` event when Escape is
pressed again without user activation in between, so "a cancel event was
seen" would misreport the second Escape in a nested overlay. The browser
smoke proves the case.

## Anchored placement

`showPopover` with an `anchor` places the popover next to it. `sides` is the
engine's ordered preference (`below`, `above`, `after`, `before`). The pack
takes the first side on which the popover fits in the viewport, or the first
side with `fits: false` if none does; an empty list means `below`. `after` and
`before` follow the anchor's text direction. The cross axis is clamped into
the viewport. The answer says where it went:

```text
Shown { placement: { side, x, y, fits } }
```

That preference list is the whole policy, and it is the engine's. The choice
itself is a pure, exported function (`choosePlacement`), tested without a
browser. The pack writes the result through the CSSOM (`style.left` and
`style.top`), which `style-src 'self'` permits; it never writes a `style`
attribute. An engine that needs placement it cannot express this way measures
with the measure pack ([35](35-measurement.md)) and positions through CSS
classes it projects.

## Focus

Focus entry and return are native. A modal dialog focuses its `autofocus`
control or its first focusable one, and restores focus on close. The focus
pack ([30](30-focus-selection-scroll.md)) composes when the engine wants
something else, such as focusing a specific row after a dialog confirms.

## When a primitive is missing

`support` tells the engine up front. `Unsupported` on a request tells it at
the moment. Either way the fallback is the engine's and is ordinary Core:

- render the overlay inline with `data-if`;
- project `inert` onto the background;
- move focus with the focus pack.

[Example 09](../examples/09-accessible-patterns/) builds its dialog that way,
so the fallback is itself a tested pattern ([37](37-accessible-patterns.md)).
The pack never polyfills.

## Do not bind `open`

`data-bind-open` on a `<dialog>` sets the `open` property. That shows the
dialog **non-modally**, outside the top layer, with no inert background and no
focus handling. Open dialogs through this pack, and keep `open` out of the
projection.

## Optional

Nothing in Core imports the pack. `kernel-with-overlay` has its own payload
budget, and the minimal consumer loads none of it.

| Evidence | Where |
| --- | --- |
| Placement choice (flip, direction, clamping, nothing fits); target resolution; Unsupported in a browser without the primitives; dismissal bookkeeping (engine closes silent, cancel, submitted with value, light dismiss with a row key); Refused by name only; facts through the kernel only to a selecting engine; conformance suite | [`test/overlay.test.ts`](../test/overlay.test.ts) |
| Real top layer escaping a clipped, zero-height, low z-index box; inert background; native focus entry and return; Escape as a cancel; `method=dialog` as submitted; a popover inside a modal closing first on Escape, then the dialog without a cancel event; an anchored popover flipping above; a parent popover's hide dismissing its child; light dismiss by a click outside; refusals; no silent modal upgrade — in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/overlay/`](../test/browser/packs/overlay/), `npm run smoke:packs` |
