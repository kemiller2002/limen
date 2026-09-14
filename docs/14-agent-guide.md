# Agent guide

**Audience:** AI coding agents modifying an application built on this kernel.

Humans ask when architecture is unclear. Agents infer and continue. So this
document minimizes inference: it states where things go, rather than describing
qualities to aim for.

Start with [AGENTS.md](../AGENTS.md) — this is the deeper version.

---

## Architectural contract

Before modifying anything, you accept these. They are MUST-level; full list with
enforcement mechanisms in [12-design-rules.md](12-design-rules.md).

1. Authoritative application state lives in the **engine**, and nowhere else.
2. You MUST NOT introduce application state in JavaScript outside the engine.
3. Browser events enter only through `data-event` bindings and the kernel.
4. Application decisions — validation, legality, what to show — belong to the
   engine.
5. Browser capabilities are reached only through `EffectRequest`. The engine
   MUST NOT touch a browser API.
6. HTML stays structural. CSS stays presentational.
7. The bridge (`src/kernel/**`) stays generic. It MUST NOT branch on domain
   meaning.
8. All four Http outcomes are represented. `OutcomeUnknown` is not `Failure`.
9. Existing public contracts (`src/protocol.ts`, `src/index.ts`) are preserved.
10. `npm run check` passes before you are done.

**There is no WebAssembly in this repository.** If you are looking for it, read
[17-wasm-migration.md](17-wasm-migration.md) and stop looking. Nothing is
missing.

---

## Decision tree

```text
I need to add behavior.
│
├─ Is it purely visual (color, spacing, animation, hover)?
│  └─ YES → CSS. Stop. Do not route it through the engine.
│
├─ Is it document structure (a new element, a label, a landmark)?
│  └─ YES → HTML. Add data-* bindings only if the engine must drive it.
│
├─ Does it decide, validate, remember, or compute anything about the
│  application?
│  └─ YES → src/engine/. Add a state, a command, a transition, a projection key.
│
├─ Does it need Http or localStorage?
│  └─ YES → the engine returns an EffectRequest. It does NOT call fetch.
│
├─ Does it need a browser capability that does not exist yet
│  (clipboard, history, files, timers, focus)?
│  └─ YES → protocol extension. See 15-recipes.md. This is a bigger change:
│           propose it, don't slip it in.
│
├─ Is it a new generic DOM binding primitive (a seventh data-* attribute)?
│  └─ YES → src/kernel/. Rare. Must be domain-agnostic. Needs review.
│
└─ Am I about to hold application state in JavaScript outside the engine?
   └─ STOP. That is rule 1. Go back to the third branch.
```

### The test that resolves most ambiguity

> *Would the application behave differently because of this?*

Yes → engine. No → HTML or CSS.

"Which tab is showing" passes the test — it changes what is legal and what
matters. It is engine state. "What color the active tab is" fails it. It is CSS.

---

## Where to start reading

Do not explore broadly. Go directly to the file for your question.

| To understand… | Read |
| --- | --- |
| The whole contract (~80 lines, read it first) | [`src/protocol.ts`](../src/protocol.ts) |
| Initialization | `BrowserKernel.start()` in [`src/kernel/browser-kernel.ts`](../src/kernel/browser-kernel.ts) |
| Dispatch | `#bindEvent`, `#fire` in the same file |
| The one round-trip chokepoint and error boundary | `#send()` |
| DOM binding | `#bindElement`, `#bind` |
| Projection application | `#applyScope`, `#applyIf`, `#applyEach` |
| Effects | `#executeEffect`, `#runHttp`, `#classifyAbort`, `runStorage` |
| State and transitions | [`src/engine/domain.ts`](../src/engine/domain.ts) |
| Projection | `project()` in [`src/engine/engine.ts`](../src/engine/engine.ts) |
| Today's transport | [`src/engine/transport.ts`](../src/engine/transport.ts) |
| Diagnostics | [`src/kernel/diagnostics.ts`](../src/kernel/diagnostics.ts) |
| Enforced invariants | [`scripts/check-architecture.ts`](../scripts/check-architecture.ts) |
| The smallest whole app | [`examples/01-counter/engine.ts`](../examples/01-counter/engine.ts) |
| A production-shaped app | [`examples/06-time-entries/engine.ts`](../examples/06-time-entries/engine.ts) |
| Every primitive at once | [`examples/kitchen-sink.js`](../examples/kitchen-sink.js) |
| Engine test style | [`test/domain.test.ts`](../test/domain.test.ts) |
| DOM test style and timing rules | [`test/kernel.test.ts`](../test/kernel.test.ts) |
| Example verification | [`test/examples.test.ts`](../test/examples.test.ts) |
| What's deferred and why | [ROADMAP.md](ROADMAP.md) |

---

## Modification checklist

Answer 1–8 before writing code; confirm 9–13 before finishing.

1. **What state changes?** Name the union member, in which `State` type.
2. **What event causes it?** Name the `data-event` value and its origin element.
3. **Is the transition legal from every state it can be requested in?** What
   happens when it is not?
4. **Is an external effect required?** Which kind — Http or Storage? If neither
   exists for it, this is a protocol change.
5. **Who performs it?** The answer must be: the kernel.
6. **How does the result return, and how is a stale one rejected?** Which state
   holds the `correlationId`?
7. **Which `ViewState` keys change?** Are capabilities projected explicitly?
8. **What HTML/CSS is needed?** Usually none — existing primitives cover it.
9. **Am I creating duplicate state?**
10. **Am I adding application logic outside the engine?**
11. **Am I bypassing a boundary for convenience?**
12. **What tests prove this — including the illegal case and the stale result?**
13. **Does `npm run check` pass?**

---

## Worked placements

Seven concrete tasks. If your task resembles one, follow it.

### "Add a button that clears the form"

| Layer | Change |
| --- | --- |
| HTML | `<button data-event="clearForm">Clear</button>` |
| Engine | `Command: { kind: "ClearForm" }`; `eventToCommand` case; transition returning a draft-reset state |
| Projection | `clearDisabled: isDraftEmpty(draft)` |
| Effect | none |
| CSS | none |

Do **not** clear the inputs with JavaScript. Reset the draft in state and let
`data-bind-value` write the empty values back.

### "Load customer information from an API"

| Layer | Change |
| --- | --- |
| Engine state | add `Loading { correlationId }`, `Loaded { customer }`, `LoadFailed { reason, retryable }` |
| Engine | transition returns `{ kind: "Http", method: "GET", url, timeoutMs }` |
| Engine | handle **all four** outcomes; guard on `correlationId`; narrow `body` from `unknown` |
| Projection | `statusText`, `busy`, `canRetry`, `customers: []` when empty |
| HTML | `data-text`, `data-if`, `data-each` bindings |

Pattern: [`examples/03-fetch-data/`](../examples/03-fetch-data/).

### "Store a user preference in localStorage"

| Layer | Change |
| --- | --- |
| Engine | `{ kind: "Storage", operation: "set", key, value, correlationId }` |
| Engine | read it back with `operation: "get"` — usually from `Initialize` |
| Engine | handle `Success { value: null }` (absent) **and** `Failure` (storage disabled) |
| Kernel | **none** — Storage already exists |

Never call `localStorage` directly. Pattern:
[`examples/04-save-data/`](../examples/04-save-data/).

### "Show a validation message"

| Layer | Change |
| --- | --- |
| Engine | a pure validation function; the rule lives here and only here |
| Projection | `fieldError: string` and `fieldErrorVisible: boolean` |
| HTML | `<template data-if="fieldErrorVisible"><p class="error" role="alert" data-text="fieldError"></p></template>` |
| CSS | `.error { color: … }` |

Keep native HTML validation (`required`, `type="email"`) **as well** — it is a
UX courtesy; the engine's check is the guarantee. Pattern:
[`examples/02-form/`](../examples/02-form/).

### "Add navigation to another screen"

| Layer | Change |
| --- | --- |
| Engine | add to the `Screen` union; add a `Navigate` transition; decide explicitly what screen-local state is discarded |
| Projection | `onNewScreen: state.screen === "newScreen"`, plus that screen's keys |
| HTML | one more `<template data-if="onNewScreen">` |

⚠️ **URL and history are not supported.** Back/forward will not work. Do not
call `history.pushState` from page JavaScript — that puts navigation state
outside the engine. Pattern:
[`examples/05-multi-screen/`](../examples/05-multi-screen/).

### "Add a timer" (e.g. auto-refresh every 30s)

⚠️ **Not supported.** There is no timer capability (ROADMAP item 16). The engine
cannot schedule anything, and adding `setInterval` to page JavaScript puts a
decision-maker outside the engine.

Options, in order of preference:

1. Add an explicit **Refresh** button. Often what was actually wanted.
2. Propose a Timer capability as a protocol extension
   ([15-recipes.md](15-recipes.md#add-a-new-browser-capability)) — a real change,
   not a slip-in.

Do not work around it.

### "Add a clipboard-copy command"

⚠️ **Not supported.** No clipboard capability exists.

The only architecturally correct route is a protocol extension: a
`ClipboardEffectRequest`, kernel execution via `navigator.clipboard`, and a
`ClipboardOutcome` covering the permission-denied case. Propose it; do not add
`navigator.clipboard.writeText` to page JavaScript.

---

## Recognizing that you are about to violate the architecture

Stop if you find yourself writing any of these:

| You are writing | The problem |
| --- | --- |
| `document.querySelector` outside `src/kernel/**` | reading the DOM as truth |
| `fetch(` in `src/engine/**` | build will fail; hidden effect |
| `let currentX` in page JavaScript | second state store |
| `switch (event.name)` in `src/kernel/**` | kernel learning domain meaning |
| `innerHTML`, a template string of markup | markup from the engine; XSS |
| `.classList.add` to reflect application state | capability derived in the DOM |
| `setTimeout` to "wait for" a projection | racing the round trip |
| `case "Failure": case "OutcomeUnknown":` together | conflating distinct outcomes |
| `id: String(index)` for `data-each` | unstable keys |
| A second `kernel.start()` | double-binding every listener |

---

## When the documentation does not cover your case

Reason from the boundary, in this order:

1. **Does this decide anything about the application?** → engine.
2. **Does this touch the outside world?** → an `EffectRequest`; if no capability
   exists, it is a protocol change and needs proposing.
3. **Is this about how something looks?** → CSS.
4. **Is this about what something is?** → HTML.
5. **Still unsure?** Ask. Do not infer a new mechanism and continue — that is
   the failure mode this architecture is least tolerant of.

If you conclude the architecture itself is the obstacle, say so explicitly and
record it. Do not route around it silently.

---

## Related

- [AGENTS.md](../AGENTS.md) — the short entry point
- [12-design-rules.md](12-design-rules.md) — MUST/SHOULD/MAY
- [13-anti-patterns.md](13-anti-patterns.md) — wrong/right pairs
- [15-recipes.md](15-recipes.md) — task-by-task instructions
- [16-troubleshooting.md](16-troubleshooting.md) — when it doesn't work
