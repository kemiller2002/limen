# Governed adapters

> **Optional — not Limen Core.** This is governed adapters, a governed adapter. It composes with the Core concepts `typed-capabilities` and `projection-output`: a third-party surface is hosted with no application authority. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Maps, charts, rich-text editors, payment fields and third-party Web Components,
without granting them application authority (kemiller2002/limen#30,
LCP-021).

Such widgets bring their own DOM and their own internal state, and they
cannot be rewritten as projections. The adapters pack gives them a narrow
door. The widget keeps its internals. The engine keeps application meaning.
Between them, only JSON crosses.

```ts
import { adaptersCapability } from "@echelon-foundry/limen/capabilities/adapters";
import { webComponentAdapter } from "@echelon-foundry/limen/capabilities/adapters/web-component";
import { chartAdapter } from "./adapters/chart.js"; // the application's own

const rating = webComponentAdapter({
  id: "rating", version: 1, tagName: "x-rating",
  properties: ["value", "max"], events: { change: "rated" }, commands: { bump: "bump" },
});

await new BrowserKernel(transport, document, diagnostics, {
  capabilities: [adaptersCapability({ adapters: [rating, chartAdapter] })],
}).start();
```

```html
<section data-adapter-slot="salesChart"></section>
```

The contract is [`contract/adapters.contract.json`](../contract/adapters.contract.json),
with bindings for TypeScript, F#, C# and Rust.

## The lifecycle is explicit and deterministic

| Request | Answer |
| --- | --- |
| `mount { slot, adapter: { id, version }, props }` | `Mounted { instance }`. Otherwise `UnknownAdapter`, `VersionMismatch { registered }`, `SlotOccupied { instance }`, `NotFound`, `Ambiguous`, or `Faulted`. |
| `update { instance, props }` | `Updated` |
| `command { instance, name, args }` | `CommandDone { result }` or `UnknownCommand` |
| `unmount { instance }` | `Unmounted`. The slot is emptied and the id is `Stale`, even if the adapter's own cleanup throws (then the answer is `Faulted { phase: "unmount" }`). |
| `describe {}` | `Adapters { registered }`: exactly what the application registered |

The widget reports with facts:

- `AdapterEvent { instance, name, data }`. A fact the widget emits while
  mounting arrives **after** `Mounted`, so the engine always knows the id
  first.
- `SlotRemoved { instance }`. A projection removed the slot (a `data-if`
  closed, a row deleted). The pack unmounted the instance, and its id is
  `Stale`. This mirrors the measure pack's `TargetRemoved`.
- `AdapterFaulted { instance, phase, reason }`. A fault outside any request.

Effects in one engine response run concurrently, as every capability effect
does. Two commands sent to one instance in the same response both start. An
engine that needs order sends the second after the first's answer.

## Identity and version

An adapter has an `id` and an integer `version`. The engine names both, and
they must match the registered adapter **exactly**: a different version is a
different contract, answered `VersionMismatch { registered }`, never
"probably compatible". Registration is explicit: an adapter the application
did not pass to `adaptersCapability` does not exist.

## Only JSON crosses

- Props, command arguments, command results and event data must be **plain
  JSON**: null, booleans, strings, finite numbers, and arrays and plain
  objects of those.
- A DOM node, a function, a class instance, a cycle, or a structure deeper
  than 64 levels is refused.
- An adapter that returns or emits one is quarantined, with reason
  `not-json`, and nothing crosses.
- The engine never receives a widget object, and the adapter never receives
  an engine object: its whole view of the application is the props and the
  `emit` function.

An `AdapterEvent`'s data is the **widget's observation**: a point was
selected, a value changed. The engine may adopt it into its own state, just
as it adopts any other fact. The widget's internals never become application
state by themselves.

## Fault isolation

Every call into an adapter (mount, update, command, unmount, and each emit)
is isolated:

- **A throw** answers `Faulted { phase, reason }`, where `reason` is the
  exception's **name only**. A message can carry widget internals or user
  data.
- **Quarantine:** the instance is quarantined from the fault on. Every later
  update and command answers the same `Faulted`, until the engine unmounts it.
- **A throwing mount** leaves the slot empty and no instance behind.
- **A throwing unmount** still empties the slot and disposes the id.
- **Everything else carries on:** other instances, other capabilities, and
  the kernel's own projections. The Chromium smoke checks this with a
  throwing adapter next to healthy ones.

## The reference Web Component adapter

`webComponentAdapter(options)` wraps a custom element the application has
already defined. Its whole surface is its declaration:

- `properties`: the only props it will set. An undeclared prop is refused as
  `UnknownProperty`, never written. That keeps `onclick`, `innerHTML` and the
  like out of reach.
- `events`: DOM event types mapped to fact names. `event.detail` is the data,
  and must be JSON.
- `commands`: command names mapped to the element's methods, with `args` as
  the argument list.
- If the element is not defined, mounting it faults with reason `NotDefined`.

It is a separate module (`./capabilities/adapters/web-component`), loaded
only by applications that use it. A hand-written adapter for a complex widget
is an object with `id`, `version` and `mount`. See the SVG chart stub in
[`test/browser/packs/adapters/main.js`](../test/browser/packs/adapters/main.js).

## The trust boundary

An adapter's code runs with **the page's full authority**. It can touch the
DOM beyond its slot, make requests, and read storage. The pack governs what
crosses the **boundary**: identity, lifecycle, JSON-only data, and isolation.
It does not sandbox what the adapter's JavaScript does. So registering an
adapter is the application's decision to trust its code, as
[29](29-binding-security.md) says of every host adapter and capability pack.
The Core binding rules (URL schemes, forbidden targets) constrain Core, not
adapters.

A widget that must not be trusted with the page belongs in a cross-origin
`<iframe>` that speaks `postMessage`, with its own adapter on this side.
There is no reference consumer for that yet.

## Optional

Nothing in Core imports the pack. `kernel-with-adapters` has its own payload
budget, which excludes the Web Component adapter, and the minimal consumer
loads none of it.

| Evidence | Where |
| --- | --- |
| JSON admission; mount, event (after Mounted), update, command, unmount in order; unknown adapter, version mismatch, occupied and missing slots; quarantine by exception name (no message crosses), a throwing mount and unmount; DOM nodes emitted or returned refused; a shapeless instance; slot removal by projection; the Web Component adapter's declared surface and NotDefined; conformance suite | [`test/adapters.test.ts`](../test/adapters.test.ts) |
| A real custom element with shadow DOM (a trusted click inside it becomes a fact), an SVG chart stub (render, update, command, selection), a faulty adapter quarantined beside healthy ones with the kernel still projecting, slot removal by a projection, unmount — in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/adapters/`](../test/browser/packs/adapters/), `npm run smoke:packs` |
