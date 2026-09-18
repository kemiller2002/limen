# 04 — Save data

## What this demonstrates

A full write lifecycle, a `Storage` effect for a local draft, and the single
most consequential distinction in the effect model: **a timed-out write must
not be retried automatically.**

## Concepts

| Concept | Where to see it |
| --- | --- |
| `Storage` effect (get/set/remove) | the transport's `Initialize` case |
| Startup I/O as an explicit effect | same place |
| Non-idempotent write safety | `RecordSave`'s `OutcomeUnknown` case |
| Best-effort effects whose failure changes nothing | the draft-write result |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | the editor, status, and resume control |
| [`engine.ts`](engine.ts) | draft restore, save lifecycle, outcomes |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
Restoring ──draft read──▶ Editing ──save──▶ Saving ──Success──▶ Saved
                              ▲                │
                              │                ├──Failure────────▶ SaveFailed
                              └── resume ──────┴──OutcomeUnknown─▶ SaveOutcomeUnknown
```

## Event flow

```text
typing → EditText → Editing (and a best-effort Storage set for the draft)
click Save → Save → Saving + one Http POST
```

## Effect flow

```text
Storage { operation: "get", key }   → StorageOutcome Success{value|null} | Failure
Storage { operation: "set", key }   → best effort; failing changes nothing the user can do
Http    { method: "POST", … }       → the four outcomes
```

`StorageOutcome` has two variants, not four. A single `localStorage` call is
effectively atomic, so there is no honest "dispatched but uncertain" case —
inventing one would be a lie in the type system.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/04-save-data/>. The POST endpoint does
not exist without a backend; the draft-restore path works entirely locally.

## Expected behavior

| You do | You see |
| --- | --- |
| Type, reload the page | your draft is still there |
| Click Save with no backend | `SaveFailed`, with a retry offered |
| A save that times out | "may or may not have been applied" — and **no** automatic retry |

## Exercises

1. Give the POST an idempotency key and let `OutcomeUnknown` retry safely.
   Notice this is a protocol decision between you and your server, expressed in
   the engine.
2. Make a draft-write failure visible without blocking the editor.

## Common mistakes

- **Retrying a POST after a timeout.** You may create two records. The engine
  reports uncertainty instead, and lets a person decide.
- **Restoring the draft in `main.ts`.** Startup I/O is still I/O. It is an
  effect request like any other.
- **Letting a failed draft write block editing.** Best-effort means the failure
  changes nothing about what the user may do.

## Related

- [docs/07-effects-and-browser-interop.md](../../docs/07-effects-and-browser-interop.md)
- [docs/13-anti-patterns.md](../../docs/13-anti-patterns.md)
