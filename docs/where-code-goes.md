# Where does this code go?

A lookup table, a decision tree, and the handful of cases that are genuinely
ambiguous. This document exists because "where does this belong?" is the
question Limen makes people ask most often — and, unusually, it has a
definite answer nearly every time.

> **Vocabulary.** *Engine* = your application's state and decisions
> (`src/engine/` here, yours wherever you put it). *Kernel* = the browser-side
> bridge (`src/kernel/browser-kernel.ts`). *Limen* = the boundary between them,
> defined by `src/protocol.ts`.

---

## The table

| Concern | Goes in | Why |
| --- | --- | --- |
| Domain state (invoices, users, drafts) | **engine** | one source of truth |
| UI state that outlives a keystroke (which tab, which filter, which screen) | **engine** | it is application state with a short lifetime, not a different kind of thing |
| Validation rules | **engine** | a rule the DOM enforces is a rule the DOM can disagree about |
| State transitions | **engine** | `(state, command) → state`, pure |
| Whether an action is currently allowed | **engine**, projected | so the DOM never re-derives it |
| What a route means | **engine** | `/invoices/42` names an invoice only because your engine says so |
| What to show, as named values | **engine**, via `project` | the projection is the view's whole input |
| Document structure | **HTML** | the kernel creates no element you did not write |
| Styling, spacing, theme, animation | **CSS** | the kernel sets no styles and knows no class names |
| Which DOM event a control listens to | **HTML** (`data-on`) | a browser mechanism, chosen where the control is |
| Performing `fetch` | **kernel** | already implemented — request an `Http` effect |
| Reading/writing `localStorage` | **kernel** | already implemented — request a `Storage` effect |
| Writing to the clipboard | **kernel** | already implemented — request a `Clipboard` effect |
| `history.pushState` / `popstate` | **kernel** | already implemented — request a `Navigation` effect |
| A browser API Limen does not expose | **kernel**, as a new capability | protocol change + kernel branch + tests; see [recipes](15-recipes.md) |
| Application logic in JavaScript outside the engine | **nowhere** | this is the mistake the whole architecture exists to prevent |

## The decision tree

```text
I need to add behavior.
│
├─ Is it a decision about what the application means, allows, or shows?
│     → ENGINE. Add a state, a command, a transition, a projected key.
│
├─ Does it need a browser capability?
│     ├─ Http, Storage, Clipboard or Navigation?
│     │     → ENGINE requests the effect. The kernel already performs it.
│     └─ Something else (files, timers, focus, geolocation)?
│           → A new capability: protocol type + kernel branch + outcome + tests.
│             Not a one-off call from application code.
│
├─ Is it document structure?          → HTML
├─ Is it presentation?                → CSS
├─ Is it what a URL means?            → ENGINE
├─ Is it how a URL is pushed/popped?  → KERNEL (already done)
│
├─ Am I about to store application state in JavaScript?
│     → Stop. It already exists in the engine, or it should.
│
└─ Am I about to call a browser API from application code?
      → Stop. Check whether Limen already exposes it as a capability.
```

## Wrong vs. right

### Deciding in the browser

```ts
// WRONG — the DOM decides what is legal
button.disabled = count === 0;
```

```ts
// RIGHT — the engine decides; the DOM displays the decision
const project = (state: State): ViewState => ({ resetDisabled: state.count === 0 });
```
```html
<button data-event="reset" data-bind-disabled="resetDisabled">Reset</button>
```

### A second copy of state

```ts
// WRONG — now two things believe they know the current user
let currentUser = null;
```

```ts
// RIGHT — it is a field of the one authoritative state
type State = { readonly user: User | null; /* … */ };
```

### A raw browser call from application code

```ts
// WRONG — application code touching a browser API directly
await navigator.clipboard.writeText(url);
history.pushState(null, "", "/invoices/42");
```

```ts
// RIGHT — described as effects; the kernel performs them
return { state: next, effects: [
  { kind: "Clipboard", correlationId, operation: "writeText", text: url },
  { kind: "Navigation", correlationId: navId, operation: "push", url: "/invoices/42" },
] };
```

In `src/engine/**` the wrong version is not merely discouraged — `npm run
check:architecture` fails the build on the word `document`, `window`, `fetch(`,
`localStorage` or `sessionStorage`.

### Routing decided by the browser layer

```ts
// WRONG — the bridge deciding what a path means
if (location.pathname.startsWith("/invoices")) showInvoices();
```

```ts
// RIGHT — the kernel splits the URL; the engine decides what it means
case "LocationChanged":
  return respond(transition(state, { kind: "AdoptLocation", location: message.location }));
```

### A hidden effect

```ts
// WRONG — a "pure" transition that quietly performs I/O
function transition(state, command) {
  fetch("/api/save", { method: "POST" });   // invisible, untestable, unordered
  return { ...state, kind: "Saving" };
}
```

```ts
// RIGHT — the effect is part of the return value
function transition(state, command): TransitionResult {
  return { state: { kind: "Saving", correlationId }, effects: [httpPost(correlationId)], accepted: true };
}
```

## The genuinely ambiguous cases

Honest answers, not rules dressed up as obvious.

**Formatting — `"$1,204.00"` or `1204`?**
Project the formatted string when the format carries meaning the user reads
(currency, a relative date). Project the raw value when CSS or an attribute
needs it. Projecting both is fine; they are computed from one state.

**Is scroll position application state?**
Usually not. It is browser-owned, like focus and text selection. It becomes
application state the moment you must restore it deliberately — and Limen has
no capability for that today, so you would be adding one.

**A `<details>` element that opens and closes.**
Leave it to the browser unless the open/closed state changes what the
application *means* (a wizard step) or must survive navigation. Native
behavior you are not overriding is not state you own.

**Debounce.**
The delay is browser mechanism; *what happens after* the delay is application
meaning. Limen has no timer capability, so today the honest options are: a
`data-on="change"` instead of `input`, or adding a Timer capability. Doing it
with a bare `setTimeout` in page JavaScript puts a decision outside the engine.

**A third-party widget (a map, a rich text editor).**
It owns its own internals — that is what you are buying. Treat it like the
browser: mount it in the kernel layer, and let it send `SemanticEvent`s in and
receive projected values out. Do not let it hold application state.

## Before you change Limen itself

If you are changing the kernel or the protocol rather than an application, run
this checklist first:

1. What state changes, and which state union holds it?
2. What message causes it — an `Event`, an `EffectResult`, a `LocationChanged`?
3. Is this application behavior or a browser capability?
4. Does a Limen capability already cover it?
5. Does it need a new effect, and what does its failure look like — *all*
   variants, including "we don't know"?
6. Will this create a second place where something is true?
7. Is it a public API change, and is it additive?
8. Which existing example is closest, and should it be extended instead?
9. What test proves it, including the illegal case?

## Related

- [mental-model.md](mental-model.md) — who owns what, and why
- [13-anti-patterns.md](13-anti-patterns.md) — more wrong/right pairs
- [12-design-rules.md](12-design-rules.md) — MUST/SHOULD/MAY, and how each is enforced
- [14-agent-guide.md](14-agent-guide.md) — the same question, written for agents
