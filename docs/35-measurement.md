# Measurement and observers

Layout and visibility facts without DOM nodes
(kemiller2002/limen#25, LCP-014). The engine can ask:

- how big a named element is;
- how big the viewport is, and where the page is scrolled;
- to be told when an element resizes or crosses a visibility threshold.

Every answer and every update is plain JSON. What a size or a visibility
*means* stays the engine's decision: load the next page, collapse a menu,
virtualize a long list.

```ts
import { measureCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/measure";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [measureCapability()] }).start();
```

```html
<section data-measure-target="results">…</section>
<ul><template data-each="rows" data-key="id">
  <li data-bind-data-measure-key="id" data-measure-target="row">…</li>
</template></ul>
```

The contract is [`contract/measure.contract.json`](../contract/measure.contract.json),
with bindings for TypeScript, F#, C# and Rust.

| Request | Answer |
| --- | --- |
| `measure { target }` | `Measured { rect: { x, y, width, height } }`, in viewport CSS pixels |
| `viewport {}` | `ViewportMeasured { width, height, scrollX, scrollY, scrollWidth, scrollHeight, devicePixelRatio }` |
| `observeSize { target }` | `Subscribed { subscription }`, then `Resized { subscription, width, height }` facts |
| `observeVisibility { target, threshold }` | `Subscribed`, then `Visibility { subscription, intersecting, ratio }` facts when the 0–1 threshold is crossed |
| `unsubscribe { subscription }` | `Unsubscribed`, or `Stale { reason }` (`disposed`, `unknown`, `other-session`) |
| failures | `NotFound`, `Ambiguous { count }`, `InvalidThreshold`, `Unsupported` (no observer in this browser), `Cancelled` |

**Subscriptions** are opaque ids from the capability-support handle table.
They mean nothing outside this page load. An id kept across a reload is
`Stale(other-session)`, never live by accident.

**A removed target ends its subscription deterministically.** When a
projection removes the element — a row deleted, a conditional section
closed — the pack disconnects the observer, disposes the id, and sends one
`TargetRemoved { subscription }` fact. Nothing more is sent for it, not even
from an observer callback the browser had already queued. The engine
resubscribes when it renders the target again.

**Coalescing.** The browser already delivers observer callbacks at most once
per frame. The pack forwards the latest entry per subscription per callback
and adds no timers of its own.

**Optional.** Nothing in Core imports the pack. `kernel-with-measure` has its
own payload budget, and the minimal consumer loads none of it.

| Evidence | Where |
| --- | --- |
| Rectangles and viewport as JSON; Resized and Visibility facts; removed target; cancellation and stale ids; typed refusals; conformance suite | [`test/measure.test.ts`](../test/measure.test.ts) |
| Real ResizeObserver, IntersectionObserver enter and leave, removal through a projection, unsubscription and a JSON round trip, in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/measure/`](../test/browser/packs/measure/), `npm run smoke:packs` |
