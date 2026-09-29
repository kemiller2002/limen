# Offline outbox semantics

The language-neutral definition of the engine-side offline outbox
(kemiller2002/limen#40, LCP-034).
[`outbox.vectors.json`](outbox.vectors.json) is the same definition as eight
scenarios, 61 steps. A library in any language conforms when every step
produces the stated snapshot, emits exactly the stated sends, and ignores
exactly the stated commands. The F# reference is
[`libraries/fsharp/Limen.Outbox`](../../libraries/fsharp/Limen.Outbox/Outbox.fs).
The offline reference page's JavaScript
([`outbox.js`](../../test/browser/packs/offline/outbox.js)) runs the same
steps in `test/outbox-reference.test.ts`, and drives a real reconnect in
Chromium ([docs/49](../../docs/49-offline-and-updates.md)).

The outbox holds the user's pending domain operations, in order. It is
ordinary engine state:

- The engine persists it with its own storage.
- The engine maps each `send` onto an `Http` effect, and the kernel's
  `EffectOutcome` onto an outcome.
- Online and offline come from the lifecycle pack's facts
  ([docs/48](../../docs/48-page-lifecycle.md)).

Nothing here is a Limen protocol type. Nothing here runs in a service worker
or in the kernel: retrying, conflict resolution and reconciliation are
application meaning.

## Operations

Each operation has an `id` the engine chose. The id is the idempotency key
every send of that operation carries, so the server can recognise a repeat.

| Status | Meaning |
| --- | --- |
| `queued` | waiting to be sent |
| `sending` | sent; its answer has not arrived |
| `conflict(version)` | the server refused it against a newer `version`; the engine must resolve it |
| `unknown` | sent with no answer (`OutcomeUnknown`), or in flight when the page reloaded. It may or may not have been applied. It is **not** a failure. |

A confirmed or rejected operation leaves the outbox. A rejection leaves a
notice `{ id, reason }`.

## Sending

The head of the queue is sent when all of these hold:

- the outbox is online;
- it is not held;
- no operation is `sending`, `conflict` or `unknown`.

So one operation is in flight at a time, and a conflict or unknown outcome
stops everything behind it. A later operation may depend on an earlier one,
and only the engine knows whether it does.

## Commands

| Command | Effect |
| --- | --- |
| `enqueue(id, kind, payload)` | Appends a queued operation, then sends if it can. A repeated id is ignored as `duplicate-operation`. |
| `connectivity(online)` | Evidence from the browser. Coming online releases a hold and sends if it can. Going offline cancels nothing: an operation in flight still gets its answer. |
| `flush` | The engine's decision to try again after a failure: releases the hold and sends if it can. Offline, it is ignored as `offline`. |
| `result(id, outcome)` | Only for the operation that is `sending`: `not-sending` otherwise, `unknown-operation` for an id the outbox does not have. The outcomes are listed below. |
| `reconcile(id, applied)` | Only for an `unknown` operation, otherwise `not-unknown`. The engine learned what happened, for example by asking the server about the idempotency key. Applied removes it. Not applied queues it again with the same id. |
| `resolve(id, discard \| replace(payload))` | Only for a `conflict`, otherwise `not-conflict`. `discard` removes it with a `discarded` notice. `replace` queues the rebased payload again with the same id. |
| `restore(operations)` | Rebuilds a persisted outbox after a reload. It starts offline and not held, and a `sending` operation becomes `unknown`, because the reload lost its answer. |
| `dismiss(id)` | Removes a notice. |

The outcomes of `result`:

- `confirmed` removes the operation.
- `rejected(reason)` removes it with a notice.
- `conflict(version)` marks it `conflict`.
- `failed` means it is known not to have been applied. The operation goes
  back to `queued`, and the outbox is **held**: nothing is resent until the
  engine flushes or the browser comes back online.
- `unknown` marks it `unknown`.

## What is never done

- An unknown outcome is never resent on its own, never rolled back, and never
  turned into a failure. `flush` and coming online do not release it; only
  `reconcile` does.
- A conflict is never resolved on its own. Last-writer-wins would be a
  decision, and this library makes none.
- A failure is never retried on a timer. Backoff, if an application wants it,
  is the engine scheduling a `flush`.
