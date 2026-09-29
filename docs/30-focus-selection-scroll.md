# Focus, selection and scroll

The first complete optional capability pack (kemiller2002/limen#23, LCP-007).
It covers presentation mechanics a projection cannot express: moving focus,
selecting text, scrolling an element into view.

**The engine decides; the pack performs.** Where focus should go after a
dialog opens or a row is deleted is application policy, so it stays in the
engine. The pack runs the one browser call, then reports exactly what
happened. It keeps no state, retries nothing, and never interprets a target.
Core is unchanged: nothing in Core imports the pack, and an application that
does not register it loads none of it (`test/bench-size.test.ts`).

## Using it

```ts
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
import { focusCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/focus";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [focusCapability()] }).start();
```

The engine selects `limen.focus` in its handshake answer. It then sends
requests as `Capability` effects in the same response as the projection they
follow. The kernel applies the projection first, so a request can target
something that projection just mounted.

```ts
{ kind: "Capability", correlationId, capability: "limen.focus", version: 1,
  request: { operation: "focusFirst", scope: { name: "dialog" } } }
```

The contract is [`contract/focus.contract.json`](../contract/focus.contract.json).
Bindings are generated for TypeScript
(`src/capabilities/focus/generated/`), F# (`Limen.Contract.Focus`), C# and
Rust (`limen_contract::limen_focus`), so an engine in any of them builds
requests and decodes results with the same strictness as the core contract.

## Naming targets, without passing DOM nodes

| HTML | Meaning |
| --- | --- |
| `data-focus-target="name"` | this element is the target called `name` |
| `data-bind-data-focus-key="id"` on a row's root | inside that row, a target also needs `key` to match (the row's key, projected by the engine) |
| `data-bind-data-focus-generation="screen"` on an ancestor | a request that carries `generation` must match it, or it is answered `Stale` |

```html
<template data-if="dialogOpen">
  <section data-focus-target="dialog" role="dialog">…</section>
</template>
<main data-bind-data-focus-generation="screen">
  <ul><template data-each="rows" data-key="id">
    <li data-bind-data-focus-key="id">…<button data-event="remove" data-focus-target="remove">Remove</button></li>
  </template></ul>
</main>
```

`key` and `generation` are ordinary projected attributes. The engine owns
their values, and the pack only compares strings.

## Operations and outcomes

| Operation | Does |
| --- | --- |
| `focus { target, preventScroll }` | moves focus to the target |
| `blur { target }` | removes focus from the target if it has it |
| `focusFirst { scope }` / `focusLast { scope }` | focuses the first or last element inside the scope that the browser actually focuses (disabled, hidden and inert ones are skipped) |
| `select { target, start, end }` / `selectAll { target }` | focuses a text control and sets its selection |
| `scrollIntoView { target, block, smooth }` | scrolls the target into view |

Every outcome is a variant the engine handles. None is an exception, a retry
or a guess:

| Result | When |
| --- | --- |
| `Done` | performed |
| `NotFound` | no element has this identity: a wrong name, or a row that no longer exists |
| `Ambiguous { count }` | several elements share the identity; the pack will not pick one |
| `NotFocusable` | the browser refused focus (disabled, hidden, inert, not focusable), or a scope holds nothing focusable |
| `NotSelectable` | no text selection on this element (a button; `type=email` or `number` in Chromium) |
| `InvalidRange` | `start` or `end` is negative, or `start > end` |
| `Stale { current }` | the target's generation is now `current`: the request was made for a replaced screen, and focus does not move |
| `Unavailable` | this browser lacks the operation |
| `Cancelled` | the engine cancelled the request before it ran |

A malformed request is `Rejected(malformed-request)` by the generated decoder.
An engine that did not select the capability gets `Unsupported`.

## Evidence

| What | Where |
| --- | --- |
| Dialog-open focus target, keyed-row deletion restoration, stale request rejection and every typed failure, through the real kernel | [`test/focus.test.ts`](../test/focus.test.ts) |
| The shared provider conformance suite: malformed requests rejected, results inside the contract and plain JSON, cancellation settles | same, via `runProviderConformance` |
| The same scenarios in real Chromium, with real focus, selection and scrolling, under a strict CSP with Trusted Types enforced | [`test/browser/packs/focus/`](../test/browser/packs/focus/), `npm run smoke:packs` |
| Absent unless registered: the minimal consumer loads no `capabilities/` module, and `kernel-with-focus` has its own budget | [`bench/budgets.json`](../bench/budgets.json) |

`npm run smoke:packs` ([`scripts/smoke-packs.ts`](../scripts/smoke-packs.ts))
runs every page under `test/browser/packs/`. A future pack proves itself in a
real browser by adding a page there.
