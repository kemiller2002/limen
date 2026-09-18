# 03 — Fetch data

## What this demonstrates

The first external effect, and the reason Limen models four outcomes instead of
"it worked / it didn't".

## Concepts

| Concept | Where to see it |
| --- | --- |
| `Http` effect request | `transition`'s `Load` case |
| All four `EffectOutcome` variants as distinct states | `State`, `RecordLoad` |
| `data-each` list rendering | `index.html` |
| Stale-result rejection by correlation id | `RecordLoad` |
| Retryable vs. not | `LoadFailed.retryable` |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | the list, the states, the retry button |
| [`engine.ts`](engine.ts) | state, the Http request, outcome handling |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
Idle ──load──▶ Loading ──Success──▶ Loaded
                  │
                  ├──Failure────────▶ LoadFailed(reason, retryable)
                  ├──Cancelled──────▶ Idle
                  └──OutcomeUnknown─▶ LoadOutcomeUnknown
```

`OutcomeUnknown` is the one people skip. A request that timed out **may already
have reached the server**. For a GET that is harmless and a retry is fine; see
[04-save-data](../04-save-data/) for why the same outcome on a POST is not.

## Event flow

```text
click "Load"
  → SemanticEvent { name: "load" }
  → transition → Loading + one Http effect with a fresh correlation id
```

## Effect flow

```text
Http { method: "GET", url, timeoutMs }
  → kernel: fetch(...)
  → HttpResult { Success{status, body} | Failure{reason, status?} | Cancelled | OutcomeUnknown }
  → transition → Loaded | LoadFailed | Idle | LoadOutcomeUnknown
```

`Failure{ reason: "invalid-response", status }` carries the status on purpose:
a 500 returning an HTML error page is retryable, a 200 returning malformed JSON
is not, and only the engine can act on that difference.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/03-fetch-data/>. **The endpoint does
not exist** without a backend — that is deliberate. What you see is the failure
path, rendered honestly.

## Expected behavior

| You do | You see |
| --- | --- |
| Click Load with no backend | the failure state, with a retry offered |
| Click Load with a backend returning JSON | the list, via `data-each` |
| Click Load twice quickly | only the newest result is adopted |

## Exercises

1. Serve `[{"id":"1","name":"Ada"}]` at the URL the engine requests and watch
   the same code take the success path.
2. Add a "Cancel" button. The kernel already implements cancellation; the
   engine decides when to ask for it.

## Common mistakes

- **Treating a timeout as a failure.** `fetch` may already have sent the
  request. The kernel reports `OutcomeUnknown` precisely because it cannot
  honestly claim otherwise.
- **Ignoring the correlation id.** Without it, a slow first response can
  overwrite a fast second one.
- **Parsing the body in the kernel.** The kernel decodes JSON and stops. What
  the decoded shape *means* is the engine's decision.

## Related

- [docs/07-effects-and-browser-interop.md](../../docs/07-effects-and-browser-interop.md)
- [docs/traces.md](../../docs/traces.md) — a fetch traced through every file it touches
