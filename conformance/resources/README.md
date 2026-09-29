# Async-resource and optimistic-mutation semantics

The language-neutral definition of two engine-side patterns
(kemiller2002/limen#22, LCP-009 and LCP-011).
[`resources.vectors.json`](resources.vectors.json) is the same definition as
seven scenarios, 58 steps. A library in any language conforms when every step
produces the stated snapshot, emits exactly the stated requests, and ignores
exactly the stated commands.

Both are ordinary engine state. There is no hidden cache, no renderer state
and no Suspense-style suspension. A read is not a mutation and is never
modelled as one. Neither pattern is a Limen protocol type. The engine maps
what they emit onto `Http` effects, and the kernel's `EffectOutcome` onto
their outcomes. `OutcomeUnknown` is never collapsed into a failure.

## Reads

| State | Shows | Meaning |
| --- | --- | --- |
| `notRequested` | nothing | nothing asked yet, or the first request was cancelled |
| `loading(r)` | nothing | the first request `r` is in flight |
| `ready(v)` | `v` | the answer |
| `refreshing(r, previous)` | `previous` | a newer request `r` is in flight; the previous value stays visible |
| `failed(reason, previous?)` | `previous`, if any | the last request failed; nothing on the server changed |
| `uncertain(previous?)` | `previous`, if any | the last request went unanswered (`OutcomeUnknown`); a read can be retried, but this is not a failure |

| Command | Effect |
| --- | --- |
| `request` | Emits `fetch(rN)` with a fresh id. From a state showing a value it moves to `refreshing(rN, value)`; otherwise to `loading(rN)`. A request already in flight is **superseded**: `cancel(old)` is emitted first, and its answer is stale when it arrives. |
| `cancel` | Emits `cancel(r)` and returns to what was shown before: `refreshing(_, p)` goes to `ready(p)`, `loading` to `notRequested`. With nothing in flight it is ignored as `nothing-in-flight`. |
| `result(r, outcome)` | Applied only if `r` is the request in flight; otherwise `stale`. `success(v)` gives `ready(v)`; `failure(reason)` gives `failed(reason, shown)`; `cancelled` behaves as `cancel` without emitting; `unknown` gives `uncertain(shown)`. |

## Optimistic mutations

A store holds the **confirmed** values (what the server has acknowledged) and
an ordered list of **mutations** (`mN`, one per user intent). Each mutation
is `pending`, `superseded`, `unresolved` or `superseded-unresolved`.
**Displayed** is the confirmed values, with each key's newest mutation that
is not superseded on top.

| Command | Effect |
| --- | --- |
| `load(values)` | Sets the confirmed values; no mutations, no notices. |
| `propose(key, value)` | Emits `send(mN, key, value)`. Every earlier mutation for that key is marked **superseded** (`unresolved` becomes `superseded-unresolved`). They stay listed until their answers arrive, so supersession is explicit, not a silent overwrite. |
| `result(m, confirmed(v))` | The server applied it: the confirmed value becomes `v` (the server's own value, which may be normalized), and the mutation is removed. **Confirmations never regress**: one from an older mutation, arriving after a newer one was confirmed, does not overwrite it. |
| `result(m, rejected(reason))` / `result(m, failed)` | Not applied: the mutation is removed and the display falls back. A notice `{ id, key, reason }` (`failed` for a failure) is raised only if it was the user's current intent; a superseded one was already replaced by the user. |
| `result(m, unknown)` | Dispatched, no answer: the mutation becomes `unresolved` (or `superseded-unresolved`) and **stays displayed**. It is never rolled back silently. |
| `reconcile(m, applied, value?)` | Only for an unresolved mutation, otherwise `not-unresolved`. `applied` confirms it (with `value`, or the mutation's own). Not applied removes it, with a `not-applied` notice if it was current. |
| `refresh(values)` | An authoritative server snapshot updates the confirmed values. Pending and unresolved mutations stay: a refresh is evidence, and reconciling is the engine's explicit decision. |
| `dismiss(id)` | Removes a notice. |

A result for a mutation the store does not have is `unknown-mutation`. A
second result for one already unresolved is `not-pending`.
