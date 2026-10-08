# Structured storage (IndexedDB)

> **Optional — not Limen Core.** This is the IndexedDB store pack, a capability pack. It composes with the Core concept `typed-capabilities`: structured storage is requested through the Capability seam. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Durable, structured browser storage with the schema declared by the engine,
and every outcome typed (kemiller2002/limen#28, LCP-018).

Core's `Storage` effect (`localStorage`) stays exactly as it is. It is right
for a few small values. The store pack is for data sets:

- many records;
- keys and indexes;
- queries by range;
- several writes that must succeed or fail together.

```ts
import { storeCapability } from "@echelon-foundry/limen/capabilities/store";

await new BrowserKernel(transport, document, diagnostics, {
  capabilities: [storeCapability({ namespace: "chrona" })],
}).start();
```

The contract is [`contract/store.contract.json`](https://github.com/kemiller2002/limen/blob/main/contract/store.contract.json),
with bindings for TypeScript, F#, C# and Rust.

## Two contract versions

| Registration | Offer | Behaviour |
| --- | --- | --- |
| `storeCapability({ namespace, limits? })` | `limen.store` **version 2** (`STORE_CAPABILITY_V2`) | Database names resolve inside the namespace; values and transactions are bounded by size; `Opened` reports the limits; compound keys, `count` and `deleteRange`. Later additions (durability evidence) are version 2 only too. |
| | | A version 1 registration refuses every version 2 field and operation as a malformed request, exactly as 0.7.x's decoder did. |
| `storeCapability()` | `limen.store` **version 1** (`STORE_CAPABILITY`, `STORE_CAPABILITY_V1`) | Exactly 0.7.x: the same fingerprint (`sha256:0ba8d199…`), names used as given, no size limits. |

The handshake accepts a capability only with an identical id, version and
fingerprint. Keeping version 1 for a pack registered without options means an
engine built against 0.7.x is never refused after Limen is upgraded. Its
fingerprint is recomputed in the tests from the frozen 0.7.1 contract,
[`contract/frozen/store.v1.contract.json`](https://github.com/kemiller2002/limen/blob/main/contract/frozen/store.v1.contract.json).
Version 2 is additive: every version 1 request means the same thing. To move
an engine to version 2, select `STORE_CAPABILITY_V2` in its handshake and
register the pack with options in the same release of the host.

## Application namespaces (LCP-048)

Every application on an origin shares one IndexedDB name space, and GitHub
Pages project sites (`<owner>.github.io/<repo>`) are all one origin. A
version 2 host therefore registers the pack with its **application
namespace**:

- every database name the engine gives is stored as `<namespace>/<name>`;
- the engine never sees or names that physical name: facts such as
  `VersionChanged` carry the engine's own name;
- a name that is empty or contains `/` is `InvalidRequest` before anything is
  touched, so no request can open, transact on, close or delete a database
  outside the namespace;
- a namespace is 1 to 64 letters, digits, `.`, `_` or `-`, starting with a
  letter or digit. A host that registers an invalid one gets `InvalidRequest`
  for every request, naming the problem, never a silent default.

**A namespace is not a security boundary (LCP-069).** It keeps well-behaved
applications apart. Any script on the origin can open every namespace's
databases directly. Applications that must not see each other's local data
must be served from different origins. For example, two applications
published as GitHub Pages project sites of one account share
`<owner>.github.io` and can read each other's IndexedDB; give one of them a
custom domain to separate them.

## Size limits (LCP-050)

Quota differs by browser and cannot be produced on demand in Chromium, so the
pack bounds every request by its serialized size, measured in bytes of UTF-8
JSON:

| Limit | Default | Hard maximum |
| --- | --- | --- |
| one stored value (`put`, `putIf`) | 1 MiB (1,048,576) | 16 MiB |
| one transaction (all its operations' JSON) | 8 MiB (8,388,608) | 64 MiB |

```ts
storeCapability({ namespace: "arca", limits: { maxValueBytes: 2 * 1024 * 1024 } })
```

A request over a limit is `InvalidRequest { problem }`, naming the operation
and the sizes, and the database is not touched. `Opened { limits }` reports
the limits in force, so the engine can plan without guessing. The browser's
own quota failure stays `Aborted { reason: quota }`, with nothing applied.

**What comes next.** The requirements for making this store durable and
consumable from F# engines are in
[the IndexedDB durable-storage requirements](https://github.com/kemiller2002/limen/blob/main/docs/requirements/LIMEN-INDEXEDDB-REQUIREMENTS.md)
(LCP-043..087, being built in WI-0157..WI-0166; namespaces and size limits are in). They cover application namespaces, compound key
paths, size limits, persistence and eviction evidence, a functional F# API
with an in-memory fake, WebKit runs, and Arca's IndexedDB adapters for its
offline queue and read cache. The decisions are in
[DF-LIMEN-2026-0005](https://github.com/kemiller2002/limen/blob/main/research/decisions/DF-LIMEN-2026-0005--indexeddb-adapter-placement-fallback-and-encryption-scope.md).

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

## Compound keys (LCP-047, version 2)

A store or an index may be keyed on several fields. Give `keyPaths`, two or
more dotted paths, and leave `keyPath` empty:

```text
{ name: "entries", keyPath: "", keyPaths: ["ns", "seq"], indexes: [
  { name: "bySlot", keyPath: "", keyPaths: ["owner", "slot"], unique: true, multiEntry: false } ] }
```

- The key is the list of the values at each path, for example `["a", 2]`.
  `Put` answers with that list, and `get` and `delete` take one.
- Keys compare element by element, so records sort by `ns` and then by `seq`,
  with numbers compared as numbers (`["a", 2]` before `["a", 10]`).
- A range over a tuple prefix selects one group: from `["a"]` to `["a", []]`
  holds every key whose first element is `"a"`, because a list sorts after
  every string and number.
- A record that lacks any part of a compound key aborts as `invalidKey`; a
  duplicate tuple in a compound unique index aborts as `constraint`.
- A compound index cannot be `multiEntry` (IndexedDB allows only one); that,
  one part only, or both `keyPath` and `keyPaths` is `InvalidRequest`.
- Changing a key path between single and compound is a key path change like
  any other: `SchemaMismatch`.

Keys are strings, finite numbers or lists of keys. Dates, binary data and
`NaN` are not keys.

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
  Records come in key order, at most `limit` (1–1000) of them;
- `count { store, index?, range? }` → `Counted { count }` (version 2): how
  many records are in the range, or in the store when `range` is absent. It
  agrees with a `query` of the same range, without reading the records;
- `deleteRange { store, range? }` → `RangeDeleted` (version 2): delete every
  record in the range, or clear the store when `range` is absent. It is a
  write, so it is refused in a readonly transaction, and an aborted
  transaction removes nothing.

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

## Durability and availability evidence (LCP-061..064, version 2)

Browsers evict best-effort storage silently, and some contexts refuse
IndexedDB. The pack reports what it can observe and decides nothing.

| Request | Answer |
| --- | --- |
| `persist` | `Persisted { granted }`: the browser's answer to `navigator.storage.persist()`. A rejected promise is `granted: false`. |
| `persisted` | `Persistence { persistent }`: whether storage is persistent now. |
| `estimate` | `Estimate { usage?, quota? }`: the browser's own approximation, in non-negative integer bytes. A count the browser did not report is absent, never `0`. Advisory only: the hard answers stay `InvalidRequest` (size limits) and `Aborted { reason: quota }`. |
| `availability` | `Availability { availability, reason? }`, one of `Available` (a probe database opened and was deleted inside the namespace), `Missing` (no `indexedDB`), `Refused` (a `SecurityError`, or the `InvalidStateError` some private modes give), `Broken` (any other failure). `reason` is the exception name only. |

Each of the first three answers `Unsupported` when the browser has no such
API, never a refusal. **The pack never asks for persistence on its own.**
Ask after the first offline write is queued, when the person has something
to lose and the browser's heuristics are most likely to grant it, and never
at first load: Firefox prompts (OQ-LIMEN-IDB-004).

Browsers deliberately hide whether private-mode storage is memory-backed, so
`availability` never claims to detect it.

**Connection loss.** When the browser closes a connection under the page
(site data cleared, or storage evicted while open), the pack forgets it and
the engine hears `ConnectionLost { database }`. The pack never reopens on its
own: later requests on that database are `NotOpen` until the engine opens it
again.

**Creation evidence.** `Opened { created }` says whether this open created the
database. A database found newly created where the engine's other evidence
says it existed (a marker kept elsewhere, a sign-in record) was lost. Only the
engine has that evidence, so only it can tell "lost" from "first use", and it
should never claim a loss it cannot know.

Version 1 registrations refuse all of these requests as malformed and emit
no `ConnectionLost`, exactly as 0.7.x.

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

## F# packages (LCP-044, LCP-079)

F# engines consume the store through NuGet packages released with Limen, at
the npm package's version (lockstep, OQ-LIMEN-IDB-005):

| Package | Contents |
| --- | --- |
| `EchelonFoundry.Limen.Contract` | The generated bindings for Core and every pack, including `Limen.Contract.Store`, each with its contract fingerprint (`Contract.Fingerprint`). |
| `EchelonFoundry.Limen.Guest` | The engine's half of the handshake (`Limen.Guest.Handshake.answer`). |

Both target `net8.0`, are trimmable and reflection-free, and depend on
nothing beyond FSharp.Core (9.0.100 or later) and the BCL. An engine selects
`limen.store` by putting `Limen.Contract.Store.Contract`'s identity in its
required capabilities. A kernel offering a different fingerprint is refused
at the handshake, never at the first request.

They ship as **Sigstore-attested GitHub release assets** on the Limen release,
with `checksums.txt`, the interim channel Arca and Fides use until nuget.org
Trusted Publishing exists. Consumers install them through Conditor's NuGet
release-asset feed. `npm run pack:nuget` and `npm run check:nuget` (CI's "F#
packages" job, and the publish workflow before it attests) pack them, refuse a
missing or mis-versioned one, and build a consumer from the files alone. That
consumer selects `limen.store` with the TypeScript pack's fingerprint, has a
mismatched fingerprint refused, and round-trips a request.

## Conformance vectors and real tabs (LCP-075, LCP-077)

[`conformance/store/`](https://github.com/kemiller2002/limen/blob/main/conformance/store/README.md)
defines version 2 as 32 language-neutral vectors: requests across named
tabs, the results and facts they must produce, and named faults. The pack
passes all 32 under node, with every fault injected, and 27 in Chromium. The
5 it cannot run there need a fault the browser cannot be made to produce on
demand (quota, a failing or missing `indexedDB`, no `navigator.storage`), and
are reported unsupported, never passed. The F# fake runs the same file.

Real second tabs (`openPage`, a BroadcastChannel between them) prove what
provider instances in one page cannot:

- **Compare-and-put across tabs (LCP-058).** Both tabs `putIf` the same
  record from the same read at once: exactly one commits, and the other
  aborts as `conflict` with the winner's value.
- **No partial batch is ever visible (LCP-051).** A reader in the other tab
  counts a store in a loop while this tab commits 500 records in one
  transaction. Measured over three runs: 113 to 163 reads, every one 0 or
  500.
- **A tab closed mid-transaction (LCP-051, LCP-077).** The other tab starts a
  4,000-record transaction and is closed at once. All or nothing remains;
  measured: nothing, in every run (the close interrupted the transaction).
- **An older tab after an upgrade (LCP-057).** The newer tab's upgrade
  completes, the older tab hears `VersionChanged`, and its next write is
  `NotOpen` and never applied.

## WebKit (LCP-076)

Every store page also runs in Playwright **WebKit** in CI
(`npm run smoke:packs:webkit`, the "Store pack in WebKit" job), under the
same strict policy. WebKit does not enforce Trusted Types; the run says so.
The shared vectors: 25 passed, 7 unsupported (named), 0 failed. The two-tab
page: a reader in the other tab saw only 0 or 500 in 187 reads, and a tab
closed mid-transaction left nothing.

What differs from Chromium, measured with WebKit 26.0 (Playwright 1.56.1, on
Linux):

- **WebKit reports `blocked` for the page's own closing connection.** A
  connection the pack has closed still counts while a transaction on it is in
  flight, even one that only read the schema. The first WebKit run turned the
  pack's own upgrades into `Blocked`. The pack now waits for the transactions
  of every connection it closed before it opens or deletes again, in both
  engines (`test/store-durability.test.ts` pins the order).
- **No `navigator.storage` persist, persisted or estimate.** `persist`,
  `persisted` and `estimate` answer `Unsupported` there, which is the
  contract's answer for a missing API.
- **No DevTools protocol**, so the runner cannot clear site data under the
  page. The `ConnectionLost` scenario is a named "NOT RUN" check in WebKit,
  and runs in Chromium.

**Playwright WebKit on Linux is not iPad Safari.** It runs WebKit's IndexedDB
engine, not iOS storage policy such as the 7-day eviction of script-writable
storage. Each release therefore adds a manual iPad Safari checklist
(OQ-LIMEN-IDB-006; see the release notes). Eviction itself is covered by
detection (`Opened { created }`, `ConnectionLost`), not by a test.

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

**`Refused` could not be produced in Chromium on demand.** No DevTools
protocol command blocks IndexedDB for an origin, and an opaque-origin
(sandboxed) frame cannot load the pack's modules under the strict policy. The
`Refused` class is proven through scripted IndexedDBs that throw or report
`SecurityError` and `InvalidStateError`
([`test/store-durability.test.ts`](https://github.com/kemiller2002/limen/blob/main/test/store-durability.test.ts)).

**Chromium compresses stored values.** A repeated character never
approaches any quota, so a quota test needs incompressible data.

## Optional

Nothing in Core imports the pack. `kernel-with-store` has its own payload
budget (its generated codec is the largest part), and the minimal consumer
loads none of it.

| Evidence | Where |
| --- | --- |
| Keys, JSON equality, request validation, schema differences; Unavailable; quota (commit-level abort, no operation) and cancellation mid-transaction through a scripted IndexedDB; unknown store; NotOpen; conformance suite | [`test/store.test.ts`](../test/store.test.ts) |
| Version 2 options; the version 1 offer and its fingerprint recomputed from the frozen 0.7.1 contract; two namespaces on one origin (isolation, a delete that leaves the other intact, the physical name never shown); a separator in a name refused; values at limit−1, limit and limit+1; an over-limit transaction; default limits; invalid options — against an in-memory IndexedDB | [`test/store-namespaces.test.ts`](https://github.com/kemiller2002/limen/blob/main/test/store-namespaces.test.ts) |
| The 32 shared vectors, every one passing under node with quota, open failures, storage cleared, a missing `indexedDB` and both storage environments injected; every result and fact variant expected; the runner reports a wrong expectation as failed and a missing requirement as unsupported | [`test/store-conformance.test.ts`](https://github.com/kemiller2002/limen/blob/main/test/store-conformance.test.ts), [`conformance/store/`](https://github.com/kemiller2002/limen/blob/main/conformance/store/README.md) |
| The same vectors in Chromium: 27 passed, 5 unsupported (named), 0 failed | [`test/browser/packs/store-conformance/`](https://github.com/kemiller2002/limen/blob/main/test/browser/packs/store-conformance/) |
| Every store page in WebKit: 76 checks, with the vectors at 25 passed and 7 unsupported, and each WebKit-only skip named | `npm run smoke:packs:webkit` (CI job "Store pack in WebKit") |
| Two real tabs: concurrent compare-and-put, a reader never seeing part of a batch, a tab closed mid-transaction, an older tab after an upgrade | [`test/browser/packs/store-tabs/`](https://github.com/kemiller2002/limen/blob/main/test/browser/packs/store-tabs/) |
| Compound keys: the tuple as key, lexicographic order, a tuple-prefix range, a compound unique violation, a missing part, single-to-compound as SchemaMismatch, invalid compound schemas; count against query, on a store and an index; deleteRange of a range, of the store, inside an aborted and a readonly transaction; version 1 refusing all of them as malformed — against an in-memory IndexedDB | [`test/store-compound.test.ts`](https://github.com/kemiller2002/limen/blob/main/test/store-compound.test.ts) |
| The same compound-key, count and deleteRange rules in Chromium | [`test/browser/packs/store-compound/`](https://github.com/kemiller2002/limen/blob/main/test/browser/packs/store-compound/) |
| persist, persisted and estimate over a scripted `navigator.storage` (granted, refused, rejected, missing counts, Unsupported); availability Missing, Available (probe deleted), Refused (thrown and reported), Broken; created on first use, not on reopen, again after deletion; ConnectionLost and NotOpen after a forced close, never reopened; version 1 refusing all of it — over scripted and in-memory IndexedDBs | [`test/store-durability.test.ts`](https://github.com/kemiller2002/limen/blob/main/test/store-durability.test.ts) |
| persisted, persist, estimate and availability against real Chromium; creation evidence; site data cleared through the DevTools protocol mid-session giving ConnectionLost, NotOpen, and a reopen that finds the database newly created | [`test/browser/packs/store-durability/`](https://github.com/kemiller2002/limen/blob/main/test/browser/packs/store-durability/) |
| Version 2 negotiated through the kernel; namespaces `a` and `b` isolated, physical names, a delete confined to its namespace; a value at the limit and one byte over; a second tab's upgrade reported under the engine's own name — in Chromium | [`test/browser/packs/store-namespaces/`](https://github.com/kemiller2002/limen/blob/main/test/browser/packs/store-namespaces/) |
| Creation; a committed batch with typed results; atomic rollback; upgrade; a unique constraint; schema mismatch; version conflict; a refused `keyPath` change leaving the version unchanged; a stale write from a second tab rejected as conflict; insert-if-absent; another tab's upgrade with `VersionChanged`; a holdout connection making an upgrade `Blocked`; persistence across a real reload; delete — in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/store/`](../test/browser/packs/store/), `npm run smoke:packs` |

The smoke runner records policy violations per page load. Violations from
before the store page's reload are not carried across it; the page makes no
requests that the policy governs.
