# Async resources and optimistic state

Two engine-side patterns for talking to a server
(kemiller2002/limen#22, LCP-009 and LCP-011):

- a **read** that is loading, ready, refreshing over its previous value,
  failed, or uncertain;
- **optimistic mutations** shown immediately over the confirmed value until
  the server answers.

Both are plain engine state. There is no hidden cache, no renderer state and
no suspension. A mutation is never treated as a read. The kernel is involved
only as it always is: it performs the `Http` effect the engine requests and
reports all four outcomes. `OutcomeUnknown` is never collapsed into a
failure.

The rules are defined once, independent of any language:

- [`conformance/resources/README.md`](../conformance/resources/README.md)
  states them in prose;
- [`conformance/resources/resources.vectors.json`](../conformance/resources/resources.vectors.json)
  states them as seven scenarios, 58 steps.

[`libraries/fsharp/Limen.Resources`](../libraries/fsharp/Limen.Resources) is
the pure F# reference implementation. `check:layers` refuses it any
authority, and `npm run test:libraries` runs every step.

```fsharp
open Limen.Resources

// A read: request, then answer with the kernel's outcome for that request id.
let read, emitted, _ = Read.request Read.initial                 // [Fetch "r1"]
let read, _, _ = Read.result "r1" (ReadOutcome.Success "…") read  // Ready
let read, emitted, _ = Read.request read                          // Refreshing("r2", previous)
// A result for "r1" now is stale; OutcomeUnknown → ReadOutcome.Unknown → Uncertain(previous).

// Optimistic: show the intent now, reconcile with what the server says.
let store, sent, _ = Optimistic.propose "title" "B" (Optimistic.load (Map [ "title", "A" ]))
let store, _, _ = Optimistic.result "m1" MutationOutcome.Unknown store   // Unresolved: still shown
let store, _, _ = Optimistic.reconcile "m1" false None store             // not applied: falls back, with a notice
```

| Criterion | How it holds |
| --- | --- |
| Pure | Both modules are pure transitions; the library has no authority. |
| Previous data stays visible during refresh without losing authoritative state | `refreshing(r, previous)`. A failed or uncertain refresh keeps `previous`, and state records which request is in flight. |
| Superseding user intent is explicit | A new request cancels the old one explicitly. A new proposal marks earlier ones `superseded` and keeps them listed until answered. Confirmations never regress. |
| Unknown mutation outcomes create reconciliation state | `unknown` gives `unresolved`, still displayed, until `reconcile`. A server refresh does not silently resolve it. |

The issue's reference tests map to named scenarios:

| Reference test | Scenario |
| --- | --- |
| Slow old response after fast new response | "a slow old response after a fast new one is rejected" |
| Refreshing with previous value | "refreshing keeps the previous value visible…" |
| Cancelled read | "cancelled reads return to what was there before" |
| Optimistic confirm / reject | "optimistic confirm and reject" |
| Timeout-after-dispatch reconciliation | "timeout after dispatch creates reconciliation state…" |
| Superseding optimistic intent | "superseding optimistic intent is explicit…" |
