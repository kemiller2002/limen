# Accessible interaction patterns

> **Optional — not Limen Core.** This is the accessible interaction patterns, an engine library and HTML patterns. It composes with the Core concepts `html-owns-structure` and `engine-owns-meaning`: native HTML carries the semantics and the engine carries the state. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Can Limen's small set of mechanics carry mature, accessible interactions —
tabs, menus, listboxes, comboboxes, trees, grids and dialogs — without widget
meaning in the kernel (kemiller2002/limen#31, LCP-008)? The answer is
[`examples/09-accessible-patterns`](../examples/09-accessible-patterns/README.md).

## What each part contributes

| Mechanism | Contributes | Knows about widgets? |
| --- | --- | --- |
| HTML | roles, structure, labels, tab stops | — |
| Kernel projection | every ARIA state (`aria-selected`, `aria-expanded`, `aria-activedescendant`, `aria-level`, `aria-disabled`), `tabindex`, `inert` | no |
| Events capability ([36](36-rich-events.md)) | key, modifier and `direction` facts; the default action prevented *declaratively* for exactly the keys a widget handles | no |
| Focus capability ([30](30-focus-selection-scroll.md)) | moving focus when the engine asks; `focusFirst` into a dialog | no |
| Engine | each pattern's state machine, and the decision of where focus goes | yes: this is where widget meaning lives |

Nothing was added to Core for these patterns. Two general gaps turned up
while building them and were closed as mechanism:

- **Boolean attributes are now toggled by presence.** `data-bind-inert` used
  to write `inert="false"`, which the browser reads as inert.
- **Direction is an environment fact.** The events capability gained a
  `direction` fact group, so right-to-left behaviour is decided from an
  explicit fact rather than guessed.

## Forma ownership

The Forma project ([kemiller2002/forma](https://github.com/kemiller2002/forma))
owns reusable interaction patterns. This repository holds **reference proofs**
that Limen's mechanics suffice. The proofs are pure pattern state machines
with tests, in an example, and they are not published or presented as
Forma's API.

**Negative knowledge.** These proofs were written without reading Forma's
source: access to that repository was not available from this work.
Aligning the proofs with Forma's actual pattern API is an explicit
cross-project obligation, not something done here.

## Evidence

| Reference test from #31 | Where |
| --- | --- |
| Keyboard happy path per pattern | pure tests for all seven patterns, and real key presses in Chromium |
| Escape / cancel | menu, combobox (two-step) and dialog, pure and in Chromium |
| Disabled item behaviour | tabs, menu and listbox skip disabled items and refuse to activate or select them |
| Focus order | roving `tabindex`: Tab leaves the tab list after the one selected tab (Chromium); focus returns to the opener |
| ARIA projection | asserted through the kernel ([`test/patterns.test.ts`](../test/patterns.test.ts)), with every projection checked against the example's view contract |
| Real-browser accessibility smoke | [`examples/09-accessible-patterns/checks.ts`](../examples/09-accessible-patterns/checks.ts): 16 checks with trusted input, under a strict CSP with Trusted Types |
