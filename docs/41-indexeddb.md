# Structured storage (IndexedDB)

Durable, structured browser storage with the schema declared by the engine,
and every outcome typed (kemiller2002/limen#28, LCP-018).

Core's `Storage` effect (`localStorage`) stays exactly as it is. It is right
for a few small values. The store pack is for data sets:

- many records;
- keys and indexes;
- queries by range;
- several writes that must succeed or fail together.

```ts
import { storeCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/store";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [storeCapability()] }).start();
```

The contract is [`contract/store.contract.json`](../contract/store.contract.json),
with bindings for TypeScript, F#, C# and Rust.

## The engine declares the schema; the pack enforces only what is declared

```text
open { database, version, stores: [ { name, keyPath, indexes: [ { name, keyPath, unique, multiEntry } ] } ], dropStores }
```

| Situation | Answer |
| --- | --- |
| a new database, or a higher version than stored | the upgrade creates every declared store and index that is missing, rebuilds an index whose definition changed, and deletes the stores in `dropStores`. Nothing else changes. `Opened { version, upgradedFrom }` |
| the stored version, and the stored schema matches the declaration | `Opened { version, upgradedFrom: version }` |
| the stored version, but the schema differs (a store missing or extra, an index changed) | `SchemaMismatch { problems }`, one line per difference. The connection is not kept. |
| a store's `keyPath` changes | IndexedDB cannot change it in place: `SchemaMismatch`, and the upgrade is rolled back. The engine drops the store (and moves its data) in a version of its own. |
| an older version than stored | `VersionConflict { stored }`: this page's code is out of date |
| another page holds an older version open and will not let go | `Blocked`. The pack abandons the attempt; if the browser later lets it through, the pack closes it unused. |
| no usable IndexedDB | `Unavailable { reason }` |

**Migration meaning stays in the engine.** The pack moves no data between
versions and invents no defaults. An engine that needs to transform records
does it with ordinary transactions, before or after the version that changes
their shape.

When **another page** upgrades or deletes the database, this page's pack
closes its own connection, so the other page is not blocked. The engine hears
`VersionChanged { database, newVersion }` (`0` for a deletion) and reopens
when its code understands the new version.

## Transactions are atomic and fully answered

```text
transact { database, mode: "readonly" | "readwrite", operations: [ … ] }
```

The operations run in order in one transaction:

- `get { store, key }` → `Found { value }` or `Missing`;
- `put { store, value }` → `Put { key }` (the key is read from the store's
  `keyPath`);
- `putIf { store, value, expected }` → `Put { key }`;
- `delete { store, key }` → `Deleted`;
- `query { store, index?, range?, limit, reverse }` → `Queried { values }`.
  Records come in key order, at most `limit` (1–1000) of them.

The answer is one of two things, and never partly applied:

- `Committed { results }`: every operation's result, in order;
- `Aborted { reason, operation?, current? }`: nothing was applied.
  - `reason` is one of `conflict`, `constraint` (a unique index), `invalidKey`,
    `quota`, `unknownStore` or `other`.
  - `operation` is the index of the operation that failed. It is absent when
    the browser failed the whole commit, as with quota.

A request the engine cancels while it runs is aborted, and the answer is
`Cancelled`: nothing was applied. Malformed requests are refused with
`InvalidRequest { problem }` before the database is touched. That covers a
write in a readonly transaction, an invalid key, and a limit outside 1–1000.

## Stale writes: compare-and-put

Two tabs read the same record, and both edit it. Without a guard, the second
save silently overwrites the first. `putIf` is the guard, and it is purely
mechanical:

- write `value` only if what is stored under its key is exactly `expected`
  (JSON-equal);
- `expected: null` means "only if absent";
- otherwise the whole transaction aborts as `conflict`, with `current` set to
  what is stored.

What to do then is the engine's decision: merge, ask the user, or retry. A
revision field inside the record makes this cheap, but the pack does not
require one.

## Measured limits (negative knowledge)

**Quota could not be produced in real Chromium.** With the DevTools protocol's
`Storage.overrideQuotaForOrigin` set to 256 KB, `navigator.storage.estimate()`
reported that quota. Yet 11 MB of incompressible records committed, in a
Playwright (off-the-record) context. The override is not enforced for
IndexedDB there. The quota outcome is therefore proven through the provider's
own transaction code against a scripted IndexedDB that aborts the commit with
`QuotaExceededError`
([`test/store.test.ts`](../test/store.test.ts)), not in the browser smoke.
This matches the earlier finding for `localStorage`: storage failure cannot
be produced on demand in real Chromium.

**Chromium compresses stored values.** A repeated character never
approaches any quota, so a quota test needs incompressible data.

## Optional

Nothing in Core imports the pack. `kernel-with-store` has its own payload
budget (its generated codec is the largest part), and the minimal consumer
loads none of it.

| Evidence | Where |
| --- | --- |
| Keys, JSON equality, request validation, schema differences; Unavailable; quota (commit-level abort, no operation) and cancellation mid-transaction through a scripted IndexedDB; unknown store; NotOpen; conformance suite | [`test/store.test.ts`](../test/store.test.ts) |
| Creation; a committed batch with typed results; atomic rollback; upgrade; a unique constraint; schema mismatch; version conflict; a refused `keyPath` change leaving the version unchanged; a stale write from a second tab rejected as conflict; insert-if-absent; another tab's upgrade with `VersionChanged`; a holdout connection making an upgrade `Blocked`; persistence across a real reload; delete — in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/store/`](../test/browser/packs/store/), `npm run smoke:packs` |

The smoke runner records policy violations per page load. Violations from
before the store page's reload are not carried across it; the page makes no
requests that the policy governs.
