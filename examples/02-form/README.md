# 02 — Input and form

## What this demonstrates

Typing, validation, and an illegal transition that is refused rather than
prevented only by a disabled button.

## Concepts

| Concept | Where to see it |
| --- | --- |
| `data-on="input"` — overriding the default trigger | `index.html` |
| `data-bind-value` — the engine owns the field's value | `index.html` |
| Validation as pure functions | `isNameValid`, `isEmailValid` |
| Messages that appear only once there is something to be wrong about | `nameMessage` |
| `data-if` for conditional content | `index.html` |
| An illegal command refused explicitly | `transition`'s `Submit` case |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | fields, bindings, conditional messages |
| [`engine.ts`](engine.ts) | draft state, validation, transitions, projection |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
Editing(draft)  ──submit (only if valid)──▶  Submitted(draft)
      ▲                                              │
      └──────────────── startOver ───────────────────┘
```

Two states, not a pile of booleans: "submitted but still editing" cannot be
written down, so it cannot happen.

## Event flow

```text
typing in the name field
  → SemanticEvent { name: "nameChanged", value: "…" }
  → transition → Editing with a new draft
  → project → field values, validity messages, submitDisabled
```

## Effect flow

None. Validation is a decision, not a side effect, so nothing leaves the
engine.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/02-form/>.

## Expected behavior

| You do | You see |
| --- | --- |
| Load the page | empty fields, no scolding, Submit disabled |
| Type one character into Name | "Name must be at least 2 characters." |
| Fill both fields validly | messages gone, Submit enabled |
| Submit | the submitted screen |

## Exercises

1. Add a third field with its own rule. Notice that `index.html` gains markup
   and `engine.ts` gains one validator — and nothing else moves.
2. Make Submit legal only when the email is not already in the draft list.
   That rule belongs in `transition`, not in the projection.

## Common mistakes

- **Relying on the disabled button as the rule.** The button is a projection of
  the rule. `transition` refuses an invalid `Submit` regardless, which is what
  the test asserts.
- **Validating in the DOM with `required`/`pattern`.** Native validation is a
  convenience for the user; it is not where the rule lives. (The kernel does
  call `reportValidity()` before dispatching a submit, so the two cooperate.)
- **Keeping a `hasError` boolean next to the draft.** Derive it in `project`.

## Related

- [docs/04-state-model.md](../../docs/04-state-model.md)
- [03-fetch-data](../03-fetch-data/) — the first effect
