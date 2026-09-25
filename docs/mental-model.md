# The Limen mental model

*If you read one document before writing Limen code, read this one.* It answers
the ownership questions — who decides what — because almost every mistake people
make with Limen is an ownership mistake, not a syntax mistake.

Nothing here is aspirational. Every claim is enforced by the code, by
`scripts/check-architecture.ts`, or by a test, and says which.

---

## One sentence

**Limen is an explicit boundary between browser capabilities and application
authority.** The browser does browser things. The engine owns what anything
means. Limen carries events one way and effects the other, and understands
neither.

## One picture

```text
        HTML / CSS / browser APIs
                  │
                  ▼
                Limen                ← the threshold: carries data, decides nothing
                  │
                  ▼
        Application engine
        state · transitions · decisions
```

## Who owns what

| Thing | Owner | Enforced by |
| --- | --- | --- |
| Application state | **the engine** | `scripts/check-architecture.ts` — engine code may not name `document`, `window`, `fetch(`, `localStorage`, `sessionStorage` |
| What an event *means* | **the engine** | the kernel only forwards the string in `data-event` |
| Whether an action is legal | **the engine** | `transition` returns `accepted: false`; the projection separately says whether to offer it |
| Which screen is showing | **the engine** | `data-if` mounts what the projection says is true |
| What a URL means | **the engine** | the kernel splits a URL into path/query/hash and stops |
| DOM structure | **your HTML** | the kernel never creates an element that is not in a `<template>` you wrote |
| Styling | **your CSS** | the kernel sets no styles and knows no class names |
| Calling a browser API | **the kernel** | it is the only place `fetch`, `localStorage`, `navigator.clipboard` and `history` appear |
| Timing, layout, native input behavior | **the browser** | unchanged; Limen replaces none of it |

Two rows are worth restating because they are the ones people get backwards:

- **The DOM is output, never input.** If you find yourself reading a value back
  out of an element to decide something, the value belongs in state.
- **The kernel decides nothing.** It does not know what `"checkAvailability"`
  means, what a `"customers"` list is, or that `/invoices/42` names an invoice.

## The two messages that cross

That is the whole contract, defined in
[`src/protocol.ts`](https://github.com/kemiller2002/limen/blob/main/src/protocol.ts):

```text
Browser → Engine        Engine → Browser
────────────────        ────────────────
Initialize              view          (a ViewState: plain named values and lists)
Event                   effects       (what to do in the browser)
EffectResult            cancellations (which in-flight effects are no longer wanted)
LocationChanged
```

Everything is plain, JSON-serializable data. No functions, no DOM nodes, no
class instances. That constraint is what makes the engine portable. The
TypeScript reference transport remains in-process, while the Limen product site
now exercises the same contract through a real F#/.NET WebAssembly boundary
(see [WASM status](https://github.com/kemiller2002/limen/blob/main/docs/17-wasm-migration.md)).

## How a click reaches the engine

```text
user clicks <button data-event="save">
  → the kernel's listener fires
  → SemanticEvent { name: "save", key?, value? }
  → transport.dispatch({ kind: "Event", event })
  → your eventToCommand turns "save" into a Command
  → transition(state, command) → a new state
  → project(state) → a ViewState
  → the kernel writes it into the DOM
```

`key` is the enclosing `data-each` row's key, if there is one. `value` is the
field's value, if the element has one. The kernel supplies both mechanically
and interprets neither.

## How the engine reaches the browser

The engine never performs an effect. It **describes** one, and the kernel runs
it:

```text
transition(state, command)
  → { state, effects: [ { kind: "Http", correlationId, method, url, … } ] }
  → the kernel performs it
  → EffectResult { correlationId, outcome }
  → transition(state, RecordSomething)   ← the outcome becomes evidence
  → a new state, and a new projection
```

The `correlationId` is how the engine knows *which* question an answer is
answering. Without it, a slow first response can overwrite a fast second one.

## How rendering happens (and what Limen is not)

Limen is **not** a UI framework and has no virtual DOM. Your HTML is written by
you, ships as HTML, and stays where you put it. The kernel understands six
attributes:

| Attribute | Effect |
| --- | --- |
| `data-event="name"` | dispatch a `SemanticEvent` named `name` |
| `data-on="input"` | use this DOM event instead of the default trigger |
| `data-text="key"` | set `textContent` from `view.key` |
| `data-bind-<attr>="key"` | set that attribute (or DOM property) from `view.key` |
| `data-if="key"` | mount a `<template>`'s content while `view.key` is truthy |
| `data-each="key"` + `data-key="field"` | repeat a `<template>` per item in `view.key` |

There is no expression language. `data-if="count > 0"` is not a thing, on
purpose: the moment the DOM can compute, it starts deciding.

**Bindings inside a `data-each` row resolve against the item, not the top-level
view.** A per-row capability must be projected onto each item.

Full detail: [rendering](https://github.com/kemiller2002/limen/blob/main/docs/06-rendering.md).

## Why failure is a first-class shape

Every effect outcome is a closed set, and "we don't know" is one of the members:

```text
Http     Success | Failure(network|aborted|invalid-response) | Cancelled | OutcomeUnknown(timeout-after-dispatch)
Storage  Success | Failure(unavailable|quota-exceeded)
Clipboard Success | Failure(denied|unavailable|unknown)
Navigation Success(location) | Dispatched | Failure(unavailable|not-same-origin)
```

`OutcomeUnknown` exists because a timed-out `fetch` **may already have reached
the server**. A POST that times out must not be retried automatically, and no
type that collapses that into "failed" can tell you so.

Each capability has its own outcome type rather than sharing one, so no caller
is forced to handle a variant that cannot occur.

## What Limen does not do

Stated plainly, because guessing is expensive:

- No virtual DOM, no diffing of HTML you did not write, no components.
- No expression language in attributes.
- No routing *policy* — the kernel pushes and pops; what a URL means is yours.
- No capabilities beyond Http, Storage, Clipboard and Navigation. Files,
  timers, focus management, geolocation, IndexedDB, WebSocket: not implemented.
  Adding one is a deliberate protocol change, documented in
  [recipes](https://github.com/kemiller2002/limen/blob/main/docs/15-recipes.md).
- No list virtualization, no animation, no focus restoration.
- No state persistence of its own. Nothing is remembered across a reload unless
  your engine asked for a `Storage` effect.

## Is this Elm? Redux? Blazor?

It **resembles** Elm-style state/message/update separation, and if that is your
background the shapes will feel familiar. Three differences matter:

1. **The view is HTML you wrote**, not a view function that generates it.
2. **The boundary is serializable on purpose**, so the engine can be replaced
   by a module in another language without touching the browser side.
3. **The browser-side layer is deliberately incapable.** It is not a small
   framework; it is a bridge that cannot make decisions.

Use the comparison to orient yourself, then drop it. Everything above is
literal.

## Where to go next

| You want | Read |
| --- | --- |
| To build something in five minutes | [quick-start.md](quick-start.md) |
| To know where a specific change belongs | [where-code-goes.md](where-code-goes.md) |
| To follow one interaction through every file | [traces.md](https://github.com/kemiller2002/limen/blob/main/docs/traces.md) |
| The exact API | [11-api-reference.md](11-api-reference.md) |
| A word you do not recognise | [glossary.md](glossary.md) |
