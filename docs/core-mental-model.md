# Limen Core, in seven concepts

This is the whole mandatory model. An application agent that holds these
seven ideas can place any change correctly; everything else in this
repository is optional and composes *beneath* them.

The concept ids below are the ones in
[`architecture/core.json`](https://github.com/kemiller2002/limen/blob/main/architecture/core.json).
`npm run check:docs` fails if this list and the manifest disagree, and the
manifest cannot gain an eighth concept without a
[Core Admission](https://github.com/kemiller2002/limen/blob/main/docs/core-admission.md).

1. **The engine owns meaning and authoritative state.** `engine-owns-meaning`
   State, transitions, validation, what a URL means, what the user may do
   next: all of it lives in the engine, in whatever language it is written.
   The browser holds no second copy.
2. **HTML owns document structure.** `html-owns-structure`
   The kernel creates no element you did not write. A page is authored HTML
   with a few `data-*` bindings.
3. **CSS owns presentation.** `css-owns-presentation`
   The kernel sets no styles and knows no class names. The engine projects a
   state; CSS decides how it looks.
4. **Semantic events and facts travel into the engine.** `semantic-input`
   The browser reports *what happened* — `{ name, key?, value? }`, an effect's
   result, a location change — never a DOM object.
5. **Projection travels out to the browser.** `projection-output`
   The engine answers with a `ViewState`: named, serializable values the
   kernel applies through six binding primitives (`data-event`, `data-on`,
   `data-text`, `data-bind-*`, `data-if`, `data-each`). The projection is the
   view's whole input.
6. **Browser authority is requested as typed capabilities and returned as typed outcomes.** `typed-capabilities`
   The engine asks; the kernel performs. Four built-in families — Http,
   Storage, Clipboard, Navigation — and one generic seam for optional packs.
   Every outcome is a typed value, including "we don't know"
   (`OutcomeUnknown`), which is never collapsed into failure.
7. **Correlation and compatibility make asynchronous and cross-runtime behavior explicit.** `correlation-compatibility`
   Every effect carries a correlation id, so a late or stale result is
   recognizable. Host and engine exchange a contract fingerprint before
   anything else, so an F#, C#, Rust or TypeScript engine and the kernel agree
   on exactly one contract, or refuse to run.

## The minimal learning path

These four, in order, are all an agent must read before changing a Limen
application. They are the manifest's `learning.path`, and AGENTS.md's required
reading is checked to be exactly this list.

1. This page.
2. [Where code goes](https://github.com/kemiller2002/limen/blob/main/docs/where-code-goes.md) — the placement table, the decision order, the layers by name.
3. [`src/protocol.ts`](https://github.com/kemiller2002/limen/blob/main/src/protocol.ts) — the contract every engine speaks.
4. [`examples/minimal/`](https://github.com/kemiller2002/limen/blob/main/examples/minimal/README.md) — one complete application that imports Core only.

## What is not Core

Federation, the TypeScript reference engine, routing and forms libraries,
async-resource patterns, capability packs (focus, scheduling, files,
IndexedDB, realtime, overlays, …), governed adapters, SSR and workers,
DevTools, trace and replay, the lifecycle CLI, conformance tooling, examples
and benchmarks. Each is documented where it lives, and each document opens by
naming the Core concept it composes with. None is a prerequisite: read one
when the task in front of you needs it.

A new capability ships as one of those optional surfaces. It adds documents,
not concepts.
