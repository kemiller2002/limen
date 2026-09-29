# View contracts: checking pages before they run

> **Optional — not Limen Core.** This is view contracts, a tooling. It composes with the Core concepts `html-owns-structure` and `projection-output`: it checks that a page's bindings and an engine's projection agree. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

A Limen page binds names: `data-text="count"`, `data-each="rows"`,
`data-event="remove"`. The engine projects and accepts the same names. If the
two disagree, the kernel reports it at runtime (`BridgeError`, phase
`projection`). A **view contract** lets you find the disagreement before the
page runs, without a browser, from any engine language
(kemiller2002/limen#48, LCP-042).

It adds no expression language, no component compiler and no runtime code. The
binding model stays exactly as small as it was. The runtime diagnostics stay
on; this check sits in front of them.

## The contract

A plain JSON file beside the page: `index.html` → `index.view.json`.

```json
{
  "doc": "What the engine projects and accepts for this page.",
  "view": {
    "title": "string",
    "count": "number",
    "busy": "boolean",
    "rows": { "list": { "id": "string", "label": "string", "done": "boolean" } }
  },
  "events": {
    "add": {},
    "rename": { "value": true },
    "remove": { "item": "rows" }
  }
}
```

- **`view`** lists every key the engine projects. A key has a kind:
  `string`, `number`, `boolean`, or `scalar` (any of the three), or it is a
  list, `{ "list": { field: kind } }`. List items are flat, because a
  `ViewItem` is.
- **`events`** lists every semantic event the engine accepts.
  - `item` names the `data-each` list the event is sent from. The event then
    carries that row's key.
  - `value` says whether the event carries a form control's value.

The contract names things; it never says what they *mean*. Nothing is inferred
from a binding's name.

## What is checked

`npm run check:views` (part of `npm test`) runs
[`scripts/check-views.ts`](../scripts/check-views.ts) over every HTML file in
the repository. A page with Limen bindings and no contract is itself a
failure.

| Mistake | Diagnostic |
| --- | --- |
| `data-text` / `data-bind-*` / `data-if` key not in the contract | `"titel" is not in the view contract (expected one of: …)` |
| a key used inside a `data-each` row that is not an item field | `"name" is not a field of rows's items` |
| `data-each` on a key that is not a list, or nested in another list | `"items" is not in the view contract`, `… is nested in another data-each` |
| `data-each` without `data-key`, or a `data-key` that is not an item field | `has no data-key`, `"uid" is not a field of rows's items` |
| `data-event` the engine does not accept | `"delete" is not an event the engine accepts (expected one of: …)` |
| an event sent from the wrong place, or with or without a value against the contract | `"remove" must be sent from a row of rows`, `"rename" expects a value, but <button> sends none` |
| `data-if` on a non-boolean | `"count" is number (expected boolean …)` |
| a boolean property (`disabled`, `checked`, `selected`, `hidden`, `open`) bound to a non-boolean | `"flag" is string (expected boolean — disabled is set with Boolean(value), so "false" would be true)` |
| a list bound where a scalar is needed | `"rows" is list (expected a string, number, boolean or scalar, not a list)` |
| `data-if` / `data-each` off a `<template>`, `data-on` without `data-event` | named directly |

Every diagnostic has the form
`file:line <element with its data-* attributes> binding: problem (expected …)`.
Output is sorted by line, so it is deterministic.
[`test/fixtures/views/`](../test/fixtures/views/) has one fixture page per
row above, and its snapshot is compared exactly.

## Holding the engine to the same contract

A contract the engine does not honour is fiction, so every engine in the
repository is checked against it:

| Engine | How | Where |
| --- | --- | --- |
| The eight numbered TypeScript examples | Every projection and every event in the example tests goes through `checkProjection` / `checkEvent` | [`test/examples.test.ts`](../test/examples.test.ts), [`test/view-conformance.ts`](../test/view-conformance.ts) |
| The reference engine and the shipped minimal counter | Driven through the fake host | [`test/view-contracts.test.ts`](../test/view-contracts.test.ts) |
| The F#, C# and Rust minimal engines | Their shared session's expected views and events are checked. Each language's runner asserts its responses equal those, step for step. | same, with [`conformance/sessions/minimal.session.json`](../conformance/sessions/minimal.session.json) |
| The F# site engine | Its own F# tests read `site/pages/*.view.json` and check the engine's serialized projections, with no TypeScript involved | `site/fsharp/tests/` |
| The kitchen-sink demo | Static only: its engine is a page script. The contract claims only what the HTML requires (booleans where `data-if` or a boolean property demands one). | [`examples/kitchen-sink.view.json`](../examples/kitchen-sink.view.json) |

`checkProjection` treats a projected key the contract does not list as a
failure, so the contract stays complete. The F# site engine serves several
pages from one projection, so its check requires each page's keys and
tolerates the others.

Four site pages have no contract because they have no bindings: the checker
sees `data-*` only in real tags, not in escaped code samples.

## In your own application

The checker is exported as `@echelon-foundry/typescript-wasm-kernel/testing/views`:

```js
import { checkPage, checkProjection, checkEvent, formatDiagnostic, parseViewContract } from "@echelon-foundry/typescript-wasm-kernel/testing/views";
```

- `parseViewContract(json)` is the only way from JSON to a contract. It names
  every problem in a malformed one.
- `checkPage(file, html, contract)` returns diagnostics; empty means the page
  agrees.
- `checkProjection(view, contract)` and `checkEvent(event, contract)` return
  problems as strings. Run them in your engine's tests, or against any
  engine's JSON output in any language.

It reads HTML with a small tokenizer rather than a DOM, so it needs no browser
and no dependency. It sees tags, not text, so `data-*` inside comments,
`<script>`, `<style>` or escaped code is not a binding.

## What it deliberately does not do

- It does not add expressions to HTML, or infer meaning from names.
- It does not replace the kernel's runtime projection diagnostics.
- It does not generate a second application model. The engine stays the
  authority, and the contract is checked against what the engine actually
  does.
