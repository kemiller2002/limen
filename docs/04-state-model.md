# State model

**What this answers:** where state lives, who may change it, how to shape it,
and what happens when something illegal is requested.

This is the most important document here. Most mistakes made with this kernel
are state-modeling mistakes, not API mistakes.

---

## Definition

**Application state** is everything the application must remember in order to
decide what to do next. Not what is *displayed* — what is *true*.

In this architecture it has one home: a single value inside the engine, of a
type you define. In the reference feature that is `ReferenceEngine.#state`
([`src/engine/engine.ts`](../src/engine/engine.ts)); in every example it is one
closure variable inside the transport.

## Who may change it

Exactly one thing: a transition function, in response to a command.

```text
              ┌──────────────────────────────────────┐
 SemanticEvent├─ eventToCommand ─→ Command ──┐        │
              │                              ▼        │
 EffectResult ├─ (mapped to a Command) ─→ transition(state, command) ─→ new state
              └──────────────────────────────────────┘
```

Nothing else may write it. Not the kernel, not the DOM, not an effect, not a
timer, not a callback. If you find yourself wanting a second writer, that is the
signal the design needs rethinking — see
[13-anti-patterns.md](13-anti-patterns.md).

---

## Shape it as a union, not a bag of flags

This is the single highest-leverage habit in this architecture.

### Wrong

```ts
type State = {
  isLoading: boolean;
  isSaving: boolean;
  hasError: boolean;
  isComplete: boolean;
  data: Customer[] | null;
  error: string | null;
};
```

Six independent fields is 2⁴ × 2 × 2 combinations. Most are nonsense:
`isLoading && isComplete`. `hasError && error === null`. `isSaving && isLoading`.
Nothing prevents any of them. Every function that reads this state must decide
what to do about combinations that should never exist — and different functions
will decide differently.

You will also write this bug, and so will everyone after you:

```ts
setLoading(false);
// ...an early return, or a thrown error, in between...
setComplete(true);       // never reached — the spinner runs forever
```

### Right

```ts
type State =
  | { readonly kind: "Idle" }
  | { readonly kind: "Loading";   readonly correlationId: CorrelationId }
  | { readonly kind: "Loaded";    readonly customers: readonly Customer[] }
  | { readonly kind: "LoadFailed"; readonly reason: string; readonly retryable: boolean };
```

Four states. The impossible combinations cannot be *written down*, so they
cannot occur. And note what the type now enforces:

- `customers` exists only in `Loaded`. There is no "loaded but data is null".
- `reason` exists only in `LoadFailed`. There is no "error message while idle".
- `correlationId` exists only in `Loading`. You cannot forget which request you
  are waiting on, because there is nowhere to lose it.

Real version: [`examples/03-fetch-data/engine.ts`](../examples/03-fetch-data/engine.ts).

### Why this matters more here than elsewhere

Because the projection is a `switch` over `kind`. With
`strict` TypeScript and an exhaustive switch, **adding a state breaks the build
everywhere it must be handled.** `project()` in
[`src/engine/engine.ts`](../src/engine/engine.ts) ends in `assertNever(state)`
precisely so that a new state cannot be silently forgotten.

Booleans give you no such alarm. You add `isRetrying` and nothing complains,
including the four places that should have handled it.

---

## Booleans are fine in the *projection*

The rule is about authoritative state, not about the view.

```ts
export function project(state: State): ViewState {
  return {
    busy:        state.kind === "Loading",
    hasError:    state.kind === "LoadFailed",
    canRetry:    state.kind === "LoadFailed" && state.retryable,
    loadDisabled: state.kind === "Loading",
  };
}
```

These booleans are *derived*, in one place, from one union. They cannot drift,
because nothing stores them. That is the difference: a projected boolean is a
calculation; a stored boolean is a second source of truth.

---

## Illegal transitions

An illegal transition is a command that is not legal from the current state:
submitting a form twice, saving while a save is in flight, processing an entry
that is already processed.

**Reject it explicitly. Do not ignore it, and do not let it through.**

The reference domain returns a typed result
([`src/engine/domain.ts`](../src/engine/domain.ts)):

```ts
export type TransitionResult =
  | { readonly accepted: true;  readonly state: State; readonly effects: readonly EffectRequest[] }
  | { readonly accepted: false; readonly state: State; readonly error: TransitionError };

case "CheckAvailability": {
  if (state.kind !== "Editing" && state.kind !== "Invalid" && state.kind !== "CheckFailed") {
    return { accepted: false, state, error: { kind: "IllegalFromCurrentState" } };
  }
  // ...
}
```

Note that a rejection still returns a state — the *unchanged* one. The engine
never ends up without a state, and the projection still happens, so the UI stays
consistent.

### But the button was disabled — why check?

Because the projection is a courtesy and the transition rule is the guarantee.
`submitDisabled` improves the experience; it does not enforce anything. A
duplicate event can still arrive from a double-click race, a keyboard
activation, a stale in-flight round trip, or a future refactor of the markup.

[`examples/06-time-entries/engine.ts`](../examples/06-time-entries/engine.ts)
does both, deliberately:

```ts
case "AddEntry": {
  // The projection already disables the button when the draft is invalid, but
  // the engine re-checks: the projection is a courtesy to the user, the
  // transition rule is the actual guarantee.
  if (state.kind !== "Ready" || !isDraftValid(state.draft)) return still(state);
  ...
}
```

Test the illegal case. `test/examples.test.ts` asserts that editing after
submitting leaves the state untouched — an assertion that would have caught the
bug if the guard were ever removed.

---

## Stale evidence

Asynchrony creates a second kind of illegal input: a result that arrives for a
request you are no longer waiting on.

```text
t0  user clicks Load       → request A dispatched, state = Loading(A)
t1  user clicks Load again → request B dispatched, state = Loading(B)
t2  A's response arrives   → must be DISCARDED
t3  B's response arrives   → accepted
```

Without a guard, A's older data overwrites B's newer data and the screen shows
the wrong thing with no error anywhere.

The guard is one line, and every example with an effect has it:

```ts
if (state.kind !== "Loading" || state.correlationId !== command.correlationId) {
  return { state, effects: [] };   // stale — discard
}
```

This is why `correlationId` lives *inside* the state rather than beside it. The
state carries what it is waiting for; anything else is not an answer to the
question it asked.

---

## UI state, DOM state, external state

Four things get confused with each other. They are different.

| Kind | Example | Owner | Notes |
| --- | --- | --- | --- |
| **Application state** | Which screen is showing; what's in the draft; is a save in flight | Engine | Anything the application would behave differently because of |
| **DOM state** | `textContent`, `disabled`, which templates are mounted | The DOM, written by the kernel | **Output.** Never read back as truth |
| **Browser-local presentation state** | Focus, scroll, caret, hover, animation progress | The browser | Deliberately untracked. CSS and native behavior handle it |
| **External state** | Server records, `localStorage` contents | The external system | The engine never holds this — only *evidence about it* |

### "But surely which tab is open is just UI state?"

It is application state. Navigation changes what the user can do, which
transitions are legal, and what data matters. In
[`examples/05-multi-screen/`](../examples/05-multi-screen/) `screen` is an
ordinary field and navigation is an ordinary transition — which is exactly why
"leaving Settings discards the unsaved draft" is one explicit line in the
transition function rather than an emergent consequence of components
unmounting.

### Evidence, not truth

When the server says a customer exists, the engine does not learn that a
customer exists. It learns *that it received a response, at a moment, with a
classified outcome, that said so*. That distinction is what makes
`OutcomeUnknown` representable at all.

---

## Shared vs. screen-local state

Both live in the same authoritative value. "Screen-local" describes a
**lifetime**, not a second store:

```ts
export type State = {
  readonly screen: Screen;
  readonly displayName: string;     // shared — survives navigation
  readonly customerFilter: string;  // screen-local — cleared on leaving
  readonly settingsDraft: string;   // screen-local — reset on entering
};
```

The lifetime is enforced in the transition, in one visible place:

```ts
case "Navigate":
  return {
    ...state,
    screen: command.screen,
    customerFilter: "",                  // discarded deliberately
    settingsDraft: state.displayName,    // reset from shared state
  };
```

Keeping the filter instead is a one-line change *here and nowhere else*. That
is the payoff for having one owner.

---

## Versioning state

The reference domain carries a `version: number` incremented on every accepted
transition ([`src/engine/domain.ts`](../src/engine/domain.ts)). It is not
required by the kernel and nothing in the protocol reads it. It exists as a
monotonic marker for reasoning about ordering and debugging — a projection that
looks stale can be checked against it. Adopt it if you find it useful; it is a
domain convention, not a kernel requirement.

---

## Checklist for a new feature's state

1. What are the distinct situations this feature can be in? Name each one.
2. What data is meaningful in *each* — and only in that one? Put it there.
3. Which transitions are legal between them? Draw the arrows.
4. What must always remain true? Can the type make it unrepresentable?
5. For every async operation: which state holds the `correlationId`?
6. For every illegal command: what does rejecting it do?
7. What capabilities does the UI need, and are they projected explicitly?

---

## Related

- [05-events-and-dispatch.md](05-events-and-dispatch.md) — how commands arrive
- [06-rendering.md](06-rendering.md) — how state becomes a screen
- [09-testing-and-debugging.md](09-testing-and-debugging.md) — testing transitions
- [13-anti-patterns.md](13-anti-patterns.md) — what violations look like
