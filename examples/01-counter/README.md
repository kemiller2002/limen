# 01 — Counter

## What this demonstrates

The entire mechanism, with nothing else in the way: a click becomes an event,
an event becomes a new state, a state becomes a projection, and the kernel
writes that projection into the DOM.

If you read one example, read this one. Everything later is this, repeated.

## Concepts

| Concept | Where to see it |
| --- | --- |
| `data-event` → `SemanticEvent` | `index.html`, `transition` |
| Pure transition | `transition(state, name)` |
| Pure projection | `project(state)` |
| **Capability projection** | `resetDisabled` |
| The two-method transport | `createCounterTransport` |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | structure and bindings |
| [`engine.ts`](engine.ts) | state, transitions, projection |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
State = { count: number }
```

One number. No `isResettable` flag beside it — that is derived in `project`,
because a flag stored next to the number is a second source of truth that can
disagree with it.

## Event flow

```text
click "Add one"
  → SemanticEvent { name: "increment" }
  → transition → { count: 1 }
  → project → { count: 1, resetDisabled: false }
  → kernel writes "1" into the <span> and enables Reset
```

## Effect flow

None. This example requests no effects at all — the `effects` array in every
response is empty. [03-fetch-data](../03-fetch-data/) adds the first one.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/01-counter/>.

## Expected behavior

| You do | You see |
| --- | --- |
| Load the page | Count: 0, Reset disabled |
| Click Add one | Count: 1, Reset enabled |
| Click Reset | Count: 0, Reset disabled again |

## Exercises

1. Add a "subtract one" button that cannot take the count below zero. Put the
   rule in `transition`, and prove it with a projected `decrementDisabled`
   rather than an `if` in the HTML.
2. Add a second, independent counter. Notice that `State` gains a field and
   nothing else changes shape.

## Common mistakes

- **Reading the count back out of the `<span>`.** The DOM is output. If you
  need the count, it is in `State`.
- **Disabling Reset from the HTML.** `resetDisabled` exists so the engine
  decides. A DOM that re-derives availability will eventually disagree with the
  engine about what is legal.
- **Calling `kernel.start()` twice.** It binds the DOM once. A later projection
  arrives through an event round-trip, never a second `start()`.

## Related

- [docs/quick-start.md](../../docs/quick-start.md) — this example, explained line by line
- [02-form](../02-form/) — the next step: input, validation, illegal transitions
