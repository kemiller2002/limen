# 06 — Time entries

## What this demonstrates

A realistic feature, assembled only from what the earlier examples introduced:
load on startup, validate a draft, add a row, mutate a row, refresh — with
failures that behave differently depending on what is already on screen.

## Concepts

| Concept | Where to see it |
| --- | --- |
| Load-on-startup | the transport's `Initialize` case |
| A failed refresh that keeps a usable list | `Refreshing` → `Ready` |
| A failed initial load that has nothing to keep | `Loading` → `LoadFailed` |
| Per-row actions with item keys | `MarkProcessed` |
| A mutation already applied is not offered again | `MarkProcessed` on a processed entry |
| Uncertainty after a non-idempotent write | `Submitting` → `OutcomeUnknown` |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | the list, the draft form, notices |
| [`engine.ts`](engine.ts) | the whole feature |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
Loading ──Failure──▶ LoadFailed
   │
   └──Success──▶ Ready(entries, draft, notice)
                   │  ├── addEntry   ──▶ Submitting ──▶ Ready
                   │  ├── markDone   ──▶ Submitting ──▶ Ready
                   │  └── refresh    ──▶ Refreshing ──▶ Ready
```

The asymmetry is the lesson: **`Refreshing` fails back into `Ready`**, because
there is still a usable list on screen; **`Loading` fails into `LoadFailed`**,
because there is not.

## Event flow

```text
click "Mark processed" on a row
  → SemanticEvent { name: "markProcessed", key: "<entry id>" }
  → transition → Submitting + one Http PATCH
```

## Effect flow

```text
Http GET   on startup     → the entries
Http POST  on add         → non-idempotent: a timeout reports uncertainty, and does not retry
Http PATCH on mark        → refused outright if the row is already processed
```

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/06-time-entries/>. The endpoints do
not exist without a backend, so the load-failure path is what you see first —
that path is real behavior, not a placeholder.

## Expected behavior

| You do | You see |
| --- | --- |
| Load with no backend | `LoadFailed`, with a retry |
| Refresh after a successful load, with the backend now down | the list stays, plus "Could not reach the server." |
| Add an entry whose POST times out | "may or may not have been applied" — no automatic retry |
| Mark an already-processed entry | nothing is sent |

## Exercises

1. Add deletion. Decide what a timed-out delete should say, and why it differs
   from a timed-out add.
2. Add a filter over entries, and keep it working across a refresh.
3. Give the feature a URL per entry — that is [08-routing](../08-routing/)
   applied here.

## Common mistakes

- **One `isLoading` boolean for both the first load and a refresh.** They fail
  differently. Two states say so.
- **Optimistically applying a mutation and forgetting to reconcile.** If you
  apply it before the result arrives, decide now what happens on
  `OutcomeUnknown`.
- **Deriving "can this row be processed?" in the HTML.** It is projected per
  row, because bindings inside a `data-each` resolve against the item.

## Related

- [docs/08-multi-screen-applications.md](../../docs/08-multi-screen-applications.md)
- [docs/15-recipes.md](../../docs/15-recipes.md)
