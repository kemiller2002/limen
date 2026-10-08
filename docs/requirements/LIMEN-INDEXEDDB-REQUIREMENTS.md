---
id: LIMEN-REQ-INDEXEDDB
title: Durable IndexedDB storage for F# engines, and the Arca offline-queue adapter
status: draft
version: 0.1.0
created: 2026-10-08
updated: 2026-10-08
owners:
  - limen
related_documents:
  - docs/41-indexeddb.md
  - contract/store.contract.json
  - research/decisions/DF-LIMEN-2026-0005--indexeddb-adapter-placement-fallback-and-encryption-scope.md
tags: [requirements, indexeddb, storage, offline, fsharp, arca, lcp-018]
work_items: [WI-0156, WI-0157, WI-0158, WI-0159, WI-0160, WI-0161, WI-0162, WI-0163, WI-0164, WI-0165, WI-0166]
external_references: ["kemiller2002/limen#15", "kemiller2002/limen#28", "kemiller2002/arca WI-0016"]
provenance:
  contributions:
    EXE-20261008T150528666Z-2b2b06eb:
      operations: [created]
      at: 2026-10-08T15:13:02.788Z
      actor:
        kind: agent
        id: anthropic/claude-code
        provider: anthropic
        model: unknown
        runtime: claude-code
      reason: "LCP-043..087 derived from Limen's store pack, Arca's offline queue (ARCA-OFF), Chrona, Summa, Signal, Fides, Indy and Helix requirements; coordinator brief 2026-10-08"
---

# Durable IndexedDB storage for F# engines, and the Arca offline-queue adapter

This document extends **LCP-018** (IndexedDB / structured offline storage,
kemiller2002/limen#28) of the
Limen Capability Parity Specification (kemiller2002/limen#15).
It uses the same requirement format as that specification:

- an `LCP-NNN` heading;
- Status, Priority and Placement, in its vocabulary;
- Requirement, Acceptance criteria and Reference tests.

Each requirement adds a **Rationale** and its **Sources** (the consumer
requirement IDs it serves).

The new IDs are **LCP-043 to LCP-087**. They continue the specification's
numbering, which ends at LCP-042, and form one cluster under LCP-018. Keywords
follow RFC 2119.

> **Scope of this document: requirements and backlog only.** Nothing here is
> implemented by WI-0156. The build is sliced into WI-0157..WI-0166
> ([section 17](#17-work-items-and-build-order)).

## 1. What exists, and what is missing

Measured against `main` at `9b54737` (2026-10-08). This is not a guess.

**Limen already ships the browser half.** The optional store pack
(`limen.store` v1, [`contract/store.contract.json`](../../contract/store.contract.json),
[docs/41](../41-indexeddb.md)) provides the following:

- engine-declared databases, stores and indexes;
- atomic batches of `get`, `put`, `putIf`, `delete` and `query`;
- `Committed`/`Aborted` with a reason;
- `VersionConflict`, `SchemaMismatch`, `Blocked`, `Unavailable`, `NotOpen`,
  `Cancelled` and `InvalidRequest`;
- the `VersionChanged` fact.

It is tested under jsdom with a scripted IndexedDB, and in real Chromium under
a strict CSP with Trusted Types.

**What is missing:**

| Gap | Evidence |
|---|---|
| F# consumers cannot use it | The generated F# binding (`guests/fsharp/Limen.Contract/Generated/Store.fs`) is not packable. Limen releases only the npm package. Chrona hand-codes Limen's protocol in F# (its `Chrona.Application` `AppProtocol` module). Arca recorded this as the blocker for its IndexedDB adapter (DF-ARCA-2026-0005, OQ-ARCA-003). |
| No functional F# API | The binding is raw records over `RawJson`. Values carry no typed codec, and outcomes are not shaped as `Result`. |
| Compound key paths | `StoreSchema.keyPath` is one dotted path. A key *value* may be an array, but a store or index cannot be keyed on two fields. |
| No durability evidence | Nothing calls `navigator.storage.persist`, `persisted` or `estimate`, and an abnormal connection close is not reported. |
| No application namespace | Database names are free strings, and every application on an origin shares them. GitHub Pages project sites share `<owner>.github.io`. |
| No size policy | There is no per-value or per-transaction limit. Quota is the only bound. |
| Chromium only | No repository in the family runs WebKit. Indy targets iPad Safari, and Forma's QD-BROWSER-001 requires Safari/WebKit. |
| No shared conformance suite or F# fake | The pack passes the generic provider conformance. There is no store-specific vector set that a fake must also pass. |
| No Arca adapter | Arca's queue persists to localStorage (`Arca.GitHub.LocalStorageQueue`), behind the `QueueStore` port. |

**A hazard in the current interim adapter.** The `QueueStore` port saves the
whole queue as one snapshot. Two tabs of one application each load the
snapshot, enqueue, and save. The second save overwrites the first, so an entry
that only the overwritten tab holds is lost from storage. It is lost for good
if that tab closes before it syncs.

The localStorage adapter has this property today. Chrona WI-0033 runs on it.
LCP-059 removes it for the IndexedDB adapter without changing the port.

## 2. Consumers and what they need

| Consumer | Need | Sources |
|---|---|---|
| **Arca** | The offline change queue must be durable across refresh and restart. The adapter replaces `LocalStorageQueue` without changing the core or the `QueueStore` port. | ARCA-OFF-001..006, ARCA-D-010, DF-ARCA-2026-0005, Arca WI-0016 |
| **Chrona** | Offline time recording (CHX-230), with every change queued write-ahead (WI-0033, on localStorage today). The persisted active timer (WI-0055) stays a small value in Core `Storage`. Cached derived indexes (CHX-380; WI-0034, not yet merged) are rebuildable caches and future candidates. Local storage must never become a competing authority (CHX-021). Updates must not lose pending time (CHX-370). | CHX-021, CHX-230, CHX-370, CHX-380 |
| **Chrona: offline-start read cache** (coordinator, 2026-10-08) | A read-only, rebuildable local copy of the records it has already read: activities by month, the derived activity index, reference data and the roster. With it, the app opens and shows data without GitHub. The cache records the commit or change token it reflects, is revalidated against it when online, is never used for a write decision without revalidating, and is cleared under the sign-out and shared-device policy. The unsent-change queue gains `sharedDevicePolicy` (`ask` \| `discardOnSignOut`). Covered by LCP-082..087. | CHX-021, CHX-230, CHX-370, CHX-380; Chrona WI-0034 |
| **Summa** | It has no offline queue today. Local indexes and caches may exist for performance, but they must be rebuildable from GitHub. | SUM0-002, SUM0-015, INV-ARCH-009 |
| **Signal** | **It opts out of the offline queue.** ADM-070 says mutating capabilities "MUST become unavailable unless a future explicit offline-operation journal is designed", and the application "MUST NOT pretend a write succeeded while offline". DF-SIGNAL-2026-0001 records the opt-out: a read-only degraded mode (ARCA-OFF-005). A future verified template cache, keyed by hash (ADM-055), is a read-only cache use. Credentials are memory or session only (ADM-071). | SIG ADM-055, ADM-070, ADM-071 |
| **Fides** | Tokens are retained in memory by default, or per tab. Persistence happens only by explicit user choice (FID-CLI-002). Nothing in this capability stores a token. | FID-CLI-002, ARCA-AUTH-002 |
| **Indy** | Its primary target is iPad Safari (R9.1). It needs offline tolerance (R10.5), local durability of queued commands (P32.8) and honest local-data guarantees (P35.10). This is the WebKit requirement. | indy-init R9.1, R10.5, R10.7, P32.8, P35.10 |
| **Helix** (note only; not in this effort) | It is built on Strata. Its requirements keep only small preferences and drafts in browser `localStorage`: chat mode and dismissal (HN-REQ-091), form auto-save drafts (HN-REQ-093) and language preference (HN-REQ-095). It does not need IndexedDB now. Drafts of health data in browser storage are a privacy point for Helix's own backlog. Nothing in Helix is changed here. | HN-REQ-091, HN-REQ-093, HN-REQ-095 |

## 3. Platform constraints

- **Limen/Forma WASM.** Engines are .NET WebAssembly behind Limen's serialized
  boundary. An engine path must never name a browser API
  (`architecture/boundary-rules.json`). Every browser effect is a request the
  kernel performs, and only JSON crosses the boundary.
- **CSP.** Packs run under the strict policy in
  [docs/29](../29-binding-security.md), with `'wasm-unsafe-eval'` added for
  WASM guests. IndexedDB, `navigator.storage` and Web Locks need no CSP
  source. A worker or SharedWorker hub needs `worker-src` and a Trusted Types
  policy for its URL ([docs/53](../53-cross-context-coordination.md)).
- **Browsers.** Every family repository tests with Playwright Chromium only.
  WebKit matters for Indy on iPad and for Forma's QD-BROWSER-001. Playwright
  WebKit on Linux is not iPad Safari. It gets WebKit's IndexedDB engine, not
  iOS storage policy, such as the 7-day eviction of script-writable storage.
- **Measured limit (from docs/41).** Real Chromium did not enforce an
  overridden quota for IndexedDB. Quota is proven through a scripted
  IndexedDB, not in a real browser.

## 4. Scope and layering

## LCP-043 — One generic store pack, extended additively
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack

### Requirement
The IndexedDB capability MUST remain the single optional `limen.store` pack.
Every addition in this document MUST be an additive change to its contract,
with Core unchanged. The pack MUST stay semantically blind: it knows no queue,
no record meaning and no migration meaning.

### Rationale
LCP-018 already provides the mechanism. A second IndexedDB pack, or a
queue-shaped pack, would duplicate it and pull Arca's meaning into Limen.

### Acceptance criteria
- No new built-in capability family, Core file, binding primitive or runtime dependency (`check:architecture`, `check:core-budget`).
- Each contract change keeps existing requests and results decoding unchanged. Bindings are regenerated for TypeScript, F#, C# and Rust.
- No request, result or fact in the pack names an Arca, Chrona or queue concept.

### Reference tests
- Existing `test/store.test.ts` and the `smoke:packs` store page pass unchanged after each addition.
- `contract:check` passes.

*Sources: LCP-018; ARCA-D-003.*

---

## LCP-044 — Consumable F# contract bindings
**Status:** Required · **Priority:** P1 · **Placement:** Tooling / Conformance (release)

### Requirement
Limen MUST publish its generated F# contract bindings, including
`limen.store`, as a versioned NuGet package (`EchelonFoundry.Limen.Contract`)
that a .NET WebAssembly engine can reference. The package MUST carry each
unit's contract fingerprint, so the handshake can refuse a kernel and engine
that disagree.

### Rationale
The binding exists but cannot be consumed. Arca WI-0016 is blocked on exactly
this, and Chrona re-implements the protocol by hand.

### Acceptance criteria
- The package builds trimmed and reflection-free (WI-0143 flags), targets `net8.0`, and has no dependency beyond FSharp.Core and the BCL.
- Its version equals the npm package version that ships the matching pack.
- A consumer selects `limen.store` through the handshake with the fingerprint from the package. A mismatched fingerprint is refused at the handshake, never at the first request.

### Reference tests
- A clean-room F# WASM consumer, built from the packed `.nupkg` alone, opens a database through the store pack in Chromium.
- A fingerprint mismatch is refused.

*Sources: DF-ARCA-2026-0005; OQ-ARCA-003; LCP-001.*

---

## LCP-045 — Functional F# store API
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library (`EchelonFoundry.Limen.Store`)

### Requirement
Limen MUST provide a pure F# library over the store binding:

- schemas, requests and results are immutable values;
- every outcome is returned as a closed union inside `Result`, never thrown;
- the only effect is a **`StoreExecutor`** function that the host supplies
  (`StoreRequest -> Async<StoreResult>`). In the browser, this is the engine's
  Limen request loop. In tests, it is the fake (LCP-074).

The library MUST NOT expose mutable state, and MUST NOT read the clock or
draw randomness. Time and identifiers are inputs.

### Rationale
The user's standing preference is a functional style. Arca already uses this
shape: `LocalStorageQueue.store` takes an executor function and describes
requests as data (ARCA-D-006).

### Acceptance criteria
- Public types are records and unions with structural equality. There is no `mutable`, no `ref` cell and no class with settable state in the public surface.
- No public function throws for a browser outcome. Each pack variant maps to exactly one union case (LCP-053).
- The library passes `limen verify`'s engine-authority rules: no browser, interop, network, filesystem or process API.
- Request builders are total: an invalid schema, key or limit is an `Error` before any request exists.

### Reference tests
- Property tests: every builder input either yields a request that the pack's validator accepts, or yields `Error`.
- An architecture test fails if the public surface gains a mutable member.

*Sources: ARCA-D-006; user preference (functional, effects at the edges).*

---

## LCP-046 — Arca queue-store adapter: placement and an unchanged port
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter, outside Limen (`EchelonFoundry.Arca.Limen`, in kemiller2002/arca)

### Requirement
The IndexedDB implementation of Arca's `QueueStore` port MUST live in a new
Arca package, `EchelonFoundry.Arca.Limen`. It references
`EchelonFoundry.Arca.Core` and `EchelonFoundry.Limen.Store`, and nothing else
from either family. Arca's `QueueStore` record, `QueueStoreFailure`,
`OfflineQueue` and `OfflineSync` MUST NOT change. Placement is decided in
[DF-LIMEN-2026-0005](../../research/decisions/DF-LIMEN-2026-0005--indexeddb-adapter-placement-fallback-and-encryption-scope.md).

### Rationale
- Limen is the lower layer, so it must not depend on Arca.
- Putting the adapter in `Arca.GitHub` would make every GitHub-provider user,
  including Signal, which opts out of the queue, take a Limen dependency.
- The localStorage key format and the migration (LCP-066) are Arca knowledge.

### Acceptance criteria
- `Arca.Core` and `Arca.GitHub` gain no reference to Limen.
- The adapter's `QueueStore` passes Arca's queue-store conformance suite (Arca WI-0019). The localStorage adapter and an in-memory store also pass it.
- Replacing `LocalStorageQueue.store` with the IndexedDB adapter in a host changes only the composition root.

### Reference tests
- Arca's existing `OfflineQueueTests` run against the IndexedDB adapter, over the Limen fake, with no edits.
- The queue-store conformance suite passes against all three stores.

*Sources: ARCA-OFF-002; ARCA-D-008, ARCA-D-010; DF-ARCA-2026-0005; Fides.Arca precedent (DF-FIDES-2026-0008).*

---

## 5. Data model

## LCP-047 — Databases, object stores, keys (including compound keys) and indexes
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack

### Requirement
The schema MUST support the following:

- databases, versions, object stores and indexes (`unique`, `multiEntry`), as
  today;
- **compound key paths**: a store or index `keyPath` that is a list of
  dotted paths;
- keys that are strings, finite numbers, or arrays of keys.

Dates, binary data and `NaN` MUST NOT be keys.

### Rationale
Queues and per-period records are naturally keyed on several fields, for
example `[namespace, sequence]` or `[organization, month]`. Without compound
key paths, consumers concatenate strings and lose range-query order.

### Acceptance criteria
- A compound-key store answers a `query` over a key range in lexicographic array order.
- A compound unique index rejects a duplicate tuple with `Aborted constraint`.
- Schema comparison reports a change from a single to a compound key path as `SchemaMismatch`, exactly as for any keyPath change.

### Reference tests
- Conformance vectors (LCP-075): compound store put/get/query; range bounds over a tuple prefix; a compound unique-index violation.

*Sources: ARCA-OFF-001 (ordered entries per namespace); CHX-380.*

---

## LCP-048 — Application namespaces for databases
**Status:** Required · **Priority:** P1 · **Placement:** Capability Pack

### Requirement
The host MUST register the pack with an **application namespace**, for
example `storeCapability({ namespace: "chrona" })`. Every database name an
engine gives MUST be resolved inside that namespace. No request can open,
transact on, close or delete a database outside it.

### Rationale
Applications on one origin share one IndexedDB name space. GitHub Pages
project sites are one origin. Without a namespace, Chrona and Summa could
open or delete each other's databases by accident.

### Acceptance criteria
- The engine never sees, or names, the resolved physical name.
- A name containing the namespace separator, or empty, is `InvalidRequest` before the database is touched.
- `deleteDatabase` cannot remove another namespace's database.

### Reference tests
- Two kernels on one origin, with namespaces `a` and `b`, each open `queue`. Writes in one are invisible in the other, and `b`'s delete leaves `a`'s database intact.

*Sources: ARCA-LOC-002 (application-owned namespaces); SUM0-005.*

---

## LCP-049 — Value serialization across the WASM boundary
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library + Capability Pack

### Requirement
Stored values MUST be JSON, as they are on the wire today. They are stored as
the structured-clone of the parsed JSON, never of a browser object. The F#
API MUST pair every stored type with an explicit codec: an encoder to JSON,
and a decoder to `Result`. A value MUST round-trip unchanged (JSON-equal). A
value that does not decode is a typed `Undecodable` result naming the store
and key, never an exception and never silently skipped.

### Rationale
- JSON is the only thing that crosses the boundary.
- An implicit reflection serializer is unavailable: the guests are
  reflection-free (WI-0143).
- A record that a newer version wrote must be detectable as unreadable.

### Acceptance criteria
- 64-bit integers that exceed 2^53 are encoded as strings by the library's built-in codecs.
- Timestamps are encoded as ISO-8601 strings with an offset.
- Floats that are not finite are refused at encode time.
- The decoder error names the store, the key and the field path, and contains no value content.

### Reference tests
- Property test: `decode (encode x) = Ok x` for the built-in codecs.
- A stored record with an unknown shape yields `Undecodable`.

*Sources: ARCA-REC-001 (canonical JSON); ARCA-INT-001 (stored content is untrusted input).*

---

## LCP-050 — Size and quota policy
**Status:** Required · **Priority:** P1 · **Placement:** Capability Pack + Engine Library

### Requirement
The pack MUST bound each request by its serialized size:

- each value is at most **1 MiB** by default;
- each transaction's operations total at most **8 MiB** by default;
- each limit is configurable when the pack is registered, up to a hard
  maximum of 16 MiB per value and 64 MiB per transaction.

A request over a limit MUST be `InvalidRequest { problem }` before the
database is touched. The browser's own quota failure MUST remain
`Aborted { reason: quota }` with nothing applied.

### Rationale
- Quota differs by browser and is not producible on demand in Chromium.
- A request-level bound makes the common overflow deterministic and testable
  everywhere.
- Arca's queue is about 2 MB at most today (`LocalStorageQueue.DefaultBudget`
  is 1,000,000 UTF-16 code units). That fits a single 1 MiB value only when
  it is under budget, so the adapter keeps its own budget (LCP-059).

### Acceptance criteria
- The limits are reported in the pack's `Opened` result, so the engine can plan without guessing.
- An over-limit value and an over-limit transaction each yield `InvalidRequest`, and the database is unchanged.
- A quota abort reports no `operation` index (a commit-level failure), as today.

### Reference tests
- Vectors at limit−1, limit and limit+1 bytes.
- Quota through the scripted IndexedDB.
- On WebKit, a real quota attempt is recorded: produced, or recorded as negative knowledge.

*Sources: ARCA-OFF-002; DF-ARCA-2026-0005 (explicit quota failure, nothing truncated); CHX-370.*

---

## 6. Transactions

## LCP-051 — Atomic multi-operation transactions; no partial write is ever visible
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack

### Requirement
A `transact` request MUST apply all of its operations, across all of the
stores it names, or none of them. No reader, in this tab or another, may ever
observe a state in which some but not all of a committed transaction's writes
are present. A tab closed or crashed during a transaction MUST leave, after
reload, either the whole transaction or nothing.

### Rationale
Arca's write-ahead protocol depends on it. The in-flight marker must be
durable before a commit is sent, or not at all (ARCA-OFF-004).

### Acceptance criteria
- An abort at operation *n* leaves operations 0..n−1 unapplied.
- Under a concurrent readonly transaction in a second tab, a readwrite batch is seen entirely before or entirely after.
- A tab closed between `transact` and its answer leaves all or nothing.

### Reference tests
- The existing atomic-rollback smoke.
- The new two-tab interleaving and tab-close-mid-transaction scenarios (LCP-077).

*Sources: LCP-018; ARCA-OFF-004; Indy P32.5.*

---

## LCP-052 — Read-only versus read-write
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack + Engine Library

### Requirement
A transaction MUST declare `readonly` or `readwrite`. A write in a readonly
transaction MUST be `InvalidRequest` before anything runs. The F# API MUST
make the mode part of the request's type, so that a write cannot be built
into a readonly transaction.

### Rationale
Readonly transactions do not serialize against each other. Making the mode a
type removes a class of runtime refusals.

### Acceptance criteria
- In F#, building a `put` into a readonly transaction does not compile.
- The pack refuses the same request as `InvalidRequest` when it is sent raw.

### Reference tests
- A compile-failure fixture in the F# test project.
- A pack vector for the raw refusal.

*Sources: LCP-018.*

---

## LCP-053 — An explicit, closed outcome set
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack + Engine Library

### Requirement
Every request MUST end in exactly one typed outcome. The F# API MUST expose
these outcomes as one closed union per request kind:

- **open:**
  - `Opened { version, upgradedFrom, created }`;
  - `VersionBlocked` (pack: `Blocked`);
  - `Outdated { stored }` (pack: `VersionConflict`);
  - `SchemaMismatch { problems }`;
  - `Unavailable { reason }`;
- **transact:**
  - `Committed { results }`;
  - `Aborted { reason, operation?, current? }`, with `QuotaExceeded` as its
    own case;
  - `NotOpen`;
  - `Cancelled`;
  - `Invalid { problem }`;
  - `Unavailable`.

The store has **no unknown outcome**. An IndexedDB transaction either commits
atomically or does not, and a consumer that lost the answer, for example to a
reload, reads the truth back.

### Rationale
The brief names committed, aborted, quota-exceeded, version-blocked and
unavailable. Limen's rule 6 requires every variant to be represented and
none collapsed, because each recovery differs.

### Acceptance criteria
- The F# match over each union is exhaustive with warnings as errors (`--warnaserror:25`).
- Each pack variant maps to exactly one F# case.
- No case is reached by catching an exception.

### Reference tests
- One vector per variant (LCP-075). The F# mapping is tested per variant.

*Sources: LCP-018; Limen rule 6; ARCA-OUT-001 (unknown outcomes stay distinct, and here are proven absent).*

---

## LCP-054 — Counting and range deletion
**Status:** Required · **Priority:** P2 · **Placement:** Capability Pack

### Requirement
Transactions MUST support `count { store, index?, range? }` and
`deleteRange { store, range }` (an omitted range clears the store), with the
same atomicity and typed results as the other operations.

### Rationale
- Queue depth and storage diagnostics need a count, without reading every
  record (LCP-073).
- Pruning and sign-out clearing (LCP-070) need a range delete, without a
  read-then-delete across the boundary.

### Acceptance criteria
- `count` agrees with a `query` of the same range.
- `deleteRange` inside an aborted transaction removes nothing.

### Reference tests
- Vectors for both, including in an aborted batch.

*Sources: ARCA-OFF-001 (inspectable queue); CHX-230 (visible sync state).*

---

## 7. Schema versioning and migrations

## LCP-055 — Declarative, versioned schema; forward-only, engine-owned data migration
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack + Engine Library

### Requirement
The engine declares each database's schema as a value: version, stores and
indexes. The pack creates what is declared and drops only what is named, as
it does today. Data migration MUST be forward-only and engine-owned. The F#
library MUST provide a pure planner that takes the stored version and an
ordered list of `(version, step)` and returns the steps to run. Each step
MUST be idempotent and recorded in a migration marker in the same transaction
as its data, so that an interrupted migration resumes rather than repeats.

### Rationale
IndexedDB upgrades can only change structure, inside `onupgradeneeded`.
Moving data is application meaning (docs/41).

### Acceptance criteria
- Versions are positive integers that only increase.
- A step list with a gap or a repeat is refused by the planner.
- A step whose marker is present is skipped.
- A step and its marker commit atomically.

### Reference tests
- Planner property tests.
- A migration interrupted between steps, by reload, resumes at the next step with no duplicated record.

*Sources: ARCA-MIG-002; ARCA-REC-005 (schema versioning); LCP-018.*

---

## LCP-056 — Defined behaviour on downgrade
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack + Engine Library

### Requirement
When the stored version is newer than the code's, the open MUST be
`Outdated { stored }`. The library MUST NOT delete, recreate or write to the
database. The application MUST tell the person that this page is out of date
and offer a reload. Until then, it runs in its declared fallback mode
(LCP-065), never on a fresh empty database.

### Rationale
An older tab after an update, or a rolled-back deployment, must not destroy
data that a newer version wrote, including unsent queue entries.

### Acceptance criteria
- After `Outdated`, every write request from that engine is refused locally by the library, without touching the database.
- No API path exists that turns `Outdated` into `deleteDatabase`.

### Reference tests
- Open at version 2, then at 1: `Outdated { stored: 2 }`, and the version-2 data is intact after a reload at version 2.

*Sources: CHX-370 (updates must not lose pending time); ARCA-OFF-006.*

---

## LCP-057 — Several tabs: `versionchange` and `blocked`
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack + Engine Library

### Requirement
The rules, as today:

- a tab running the pack MUST close its connection on `versionchange`, and
  tell its engine `VersionChanged { database, newVersion }`;
- an upgrade held up by a connection that will not close MUST be
  `VersionBlocked` and abandoned.

Added by this requirement:

- the F# library MUST turn `VersionChanged` into a state in which further
  writes are refused locally (`NotOpen`) until the engine reopens at a version
  it understands;
- `VersionBlocked` MUST carry no automatic retry. Retrying is the engine's
  decision.

### Rationale
Two tabs on different deployments are normal after an update. Neither may
write with a schema it does not understand, and neither may wait forever.

### Acceptance criteria
- With two tabs that both run the pack, a newer tab's upgrade always completes, because the older tab closes.
- `VersionBlocked` occurs only with a connection that ignores `versionchange`.
- After `VersionChanged`, a write from the older engine is `NotOpen` and is never sent.

### Reference tests
- The existing two-tab upgrade and holdout smokes.
- New: an older-tab write after `VersionChanged` is refused (Chromium and WebKit).

*Sources: LCP-018; CHX-370.*

---

## 8. Concurrency across tabs

## LCP-058 — Cross-tab isolation and compare-and-put
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack

### Requirement
Readwrite transactions with overlapping stores MUST be serialized across
tabs, which is IndexedDB's own guarantee and is proven here.
`putIf { value, expected }` MUST stay a mechanical compare-and-put: on a
mismatch, the whole transaction aborts as `conflict`, with `current`.

### Rationale
Compare-and-put is the stale-write guard that LCP-059's fencing is built on.

### Acceptance criteria
- Two tabs that `putIf` the same record from the same expected value: exactly one commits, and the other aborts with `conflict` and the winner's value as `current`.

### Reference tests
- The existing stale-write smoke, extended to WebKit (LCP-076).

*Sources: LCP-018; ARCA-CON-001 (optimistic concurrency).*

---

## LCP-059 — One queue owner per namespace, with fencing
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter (`EchelonFoundry.Arca.Limen`) + coordination pack (LCP-040)

### Requirement
At most one tab at a time MUST own the queue of an Arca namespace.

**Taking ownership.** The adapter's factory MUST:

1. acquire a coordination-pack lock named for the namespace
   (`acquire { name: "arca.queue/<app>[/<dataset>]", wait: false }`);
2. on `Acquired`, increment a **fencing epoch** stored beside the snapshot,
   using `putIf`;
3. return a `QueueStore` bound to that epoch.

**What a save does.** Every `Save` MUST `putIf` the snapshot and the epoch
against the epoch this owner holds.

**Losing ownership.** A save after another tab has taken ownership
(`LockLost`, or a higher epoch) MUST fail as
`QueueStoreFailure.Unavailable`, with nothing written. The adapter reports
the reason `OwnedElsewhere` through its diagnostics (LCP-073).

**Tabs that are not the owner.** The factory returns
`OwnedElsewhere`, outside the port, and does not hand those tabs a store.

### Rationale
- The port saves whole snapshots, so two writers lose entries (section 1).
- The port must not change, so it cannot gain a conflict case or a merge.
- A single owner removes the race, and the epoch fences an owner that was
  pre-empted but still runs.
- Web Locks release automatically when a tab closes, crashes or navigates
  (LCP-040).

### Acceptance criteria
- Two tabs: exactly one gets a `QueueStore`, and the other gets `OwnedElsewhere`.
- The owner closes: the waiting tab acquires ownership, loads exactly the last saved snapshot, and owns a higher epoch.
- A pre-empted owner's `Save` writes nothing.
- Where Web Locks are unsupported, the factory answers `OwnershipUnsupported`. It never falls back to unfenced multi-writer saves.
- The factory signature, `OwnedElsewhere` and `OwnershipUnsupported` are adapter API. `QueueStore` and `QueueStoreFailure` are unchanged.

### Reference tests
- Over the F# fake: two owners, steal, and stale save fenced.
- In Chromium and WebKit: two tabs, close the owner, the second tab takes over with no lost entry.

*Sources: ARCA-OFF-002, ARCA-OFF-004; LCP-040; CHX-230 (scenario 34, cross-device sync).*

---

## LCP-060 — FIFO per namespace, and exactly-once hand-off to the sync worker
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter (`EchelonFoundry.Arca.Limen`)

### Requirement
**Order.** The adapter MUST persist and restore a namespace's queue with its
entry order and sequence numbers exactly preserved (FIFO per namespace).
Namespaces MUST be stored under separate keys and never mixed. A stored
queue holding another namespace's entries MUST be refused as `Corrupt`, as
`LocalStorageQueue` does today.

**Hand-off.** Only the queue owner (LCP-059) may run `OfflineSync`. A new
owner hands work on exactly once:

- it `recover`s an entry left `InFlight` by a previous owner to
  `OutcomeUnknown`;
- it reconciles that entry before sending anything else, through Arca's
  existing write-ahead and idempotency-key protocol.

### Rationale
Exactly-once *effect* at the provider comes from Arca's idempotency keys and
reconciliation (ARCA-OUT-002). The adapter's part is to never let two workers
send and never lose the in-flight marker.

### Acceptance criteria
- `Load` after `Save q` returns `q` (structural equality) for any generated queue.
- No two tabs run `OfflineSync.step` for one namespace at the same time.
- Ownership moved mid-send produces one provider commit, never two.

### Reference tests
- Property: save/load round-trip over Arca's `queueGen`.
- Fault test: the owner stops after `markInFlight` is saved and before `Commit` answers; the new owner reconciles and commits once.

*Sources: ARCA-OFF-001, ARCA-OFF-004, ARCA-OUT-001, ARCA-OUT-002; CHX-230 (scenarios 31, 33).*

---

## 9. Durability

## LCP-061 — Request persistent storage where available
**Status:** Required · **Priority:** P1 · **Placement:** Capability Pack + Engine Library

### Requirement
The pack MUST offer:

- `persist`, answered `Persisted { granted }` or `Unsupported`;
- `persisted`, answered `Persistence { persisted }` or `Unsupported`.

Both are over `navigator.storage`. The engine decides when to ask. The pack
never asks on its own.

### Rationale
- Persistent storage exempts the origin from best-effort eviction.
- Browsers grant it by heuristic, and Firefox prompts, so the moment is a
  product decision (OQ-LIMEN-IDB-004).

### Acceptance criteria
- No `persist` call happens without an engine request.
- A missing API is `Unsupported`, never `granted: false`.
- A rejected promise is `Persisted { granted: false }`, with the error name in diagnostics only.

### Reference tests
- A Chromium smoke for `persist` and `persisted`.
- WebKit result recorded.
- Scripted `Unsupported`.

*Sources: CHX-230; Indy P32.8.*

---

## LCP-062 — Detect and surface eviction and connection loss
**Status:** Required · **Priority:** P1 · **Placement:** Capability Pack + Engine Library + Consumer adapter

### Requirement
- The pack MUST report `ConnectionLost { database }` as a fact when the
  browser closes a connection abnormally (the `IDBDatabase` `close` event:
  storage cleared or evicted while open).
- `Opened` MUST say whether this open **created** the database.
- The Arca adapter MUST record, outside the snapshot, that a queue existed on
  this device (a durable marker written with the first save). When the
  database is next found newly created, the adapter MUST report
  `LocalQueueLost` to the application instead of starting silently empty.

### Rationale
- Eviction is silent in every browser.
- iOS Safari may evict script-writable storage after inactivity. That policy
  is not testable in Playwright WebKit.
- What can be detected is: a connection closed under the page, and a
  database that is new when the device's other evidence says it should not
  be.

### Acceptance criteria
- Clearing site data during a session yields `ConnectionLost`, and later writes are `NotOpen`, never silently reopened.
- An application reloaded after its storage was cleared can tell "first use" from "lost". It shows the loss only where it has evidence (the marker or a sign-in record), and never claims a loss it cannot know.

### Reference tests
- Chromium: storage cleared through the DevTools protocol mid-session, giving `ConnectionLost`.
- The adapter, over the fake: database recreated with the marker kept elsewhere gives `LocalQueueLost`.

*Sources: CHX-370 (browser reliability); ARCA-OFF-003 (unsynchronized data never shown as synchronized); Indy P35.10.*

---

## LCP-063 — Quota estimation
**Status:** Required · **Priority:** P2 · **Placement:** Capability Pack + Engine Library

### Requirement
The pack MUST offer `estimate`, answered `Estimate { usage, quota }` or
`Unsupported`. It is the origin's estimate, which the browser itself
approximates.

### Rationale
Applications warn before a write fails (LCP-073). The estimate is advisory,
and the hard answers stay `InvalidRequest` and `Aborted quota`.

### Acceptance criteria
- Values are non-negative integers in bytes.
- The F# type names them as estimates.
- No decision in the library depends on them.

### Reference tests
- Chromium smoke.
- WebKit result recorded.
- Scripted `Unsupported`.

*Sources: ARCA-API-005 (growth measures); SIG ADM-058.*

---

## 10. Availability and fallback

## LCP-064 — Availability classification
**Status:** Partial · **Priority:** P1 · **Placement:** Capability Pack

### Requirement
The pack MUST answer an `availability` request with one of:

- `Available`;
- `Missing` (no `indexedDB`);
- `Refused { reason }` (a `SecurityError`, or an open refused in a private
  mode or with storage blocked);
- `Broken { reason }` (an open that errors for another reason).

It MUST NOT claim to detect ephemeral, memory-backed private storage, which
browsers deliberately hide.

### Rationale
The application chooses its fallback (LCP-065) from a typed reason, not from
a thrown exception.

### Acceptance criteria
- Each class is reachable through the scripted IndexedDB.
- Reasons carry the exception name only.
- `Available` means that a probe database opened and closed in the namespace.

### Reference tests
- Scripted vectors per class.
- Chromium with storage blocked by the DevTools protocol, giving `Refused`.

*Sources: ARCA-OFF-002; SIG AER-031 (offline and degraded behaviour explicit).*

---

## LCP-065 — Explicit durability mode; never silent data loss
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter + application

### Requirement
Limen MUST NOT fall back from IndexedDB to anything. Fallback is the
consumer's explicit, observable choice. The Arca adapter MUST offer a
composer that tries the stores in a declared order and reports the
**durability mode** it obtained:

- `IndexedDb`;
- `LocalStorage { budget }`, through the existing `LocalStorageQueue`;
- `MemoryOnly`.

`MemoryOnly` means that unsent changes do not survive closing the tab. An
application in that mode MUST say so before accepting an offline write, or
refuse offline writes ([DF-LIMEN-2026-0005](../../research/decisions/DF-LIMEN-2026-0005--indexeddb-adapter-placement-fallback-and-encryption-scope.md) §2).

### Rationale
The brief forbids silent data loss. A fallback that the person cannot see
changes what "saved on this device" means without telling them.

### Acceptance criteria
- The mode is part of the composer's result and of the adapter diagnostics. It cannot be ignored without discarding a value.
- Chrona shows the mode wherever it shows sync state.
- No path writes the queue to two stores at once.

### Reference tests
- Composer tests over the fake: `Missing` gives `LocalStorage`; both refused gives `MemoryOnly`; the mode is reported in each case.

*Sources: ARCA-OFF-002, ARCA-OFF-003, ARCA-OFF-005; CHX-230; Indy P35.10.*

---

## 11. Migration from localStorage

## LCP-066 — One-time, idempotent move of Arca's localStorage queue
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter (`EchelonFoundry.Arca.Limen`)

### Requirement
When it first owns a namespace (LCP-059) with IndexedDB available, the
adapter MUST move the localStorage snapshot under `arca.queue.<app>[.<dataset>]`
into IndexedDB, exactly once:

1. Read the IndexedDB snapshot and the localStorage text. If the localStorage
   key is absent, stop.
2. Decode the localStorage text with `LocalStorageQueue.loaded`. A corrupt or
   foreign queue is left in place, and the adapter reports
   `LegacyQueueUnreadable`. It is never deleted.
3. If the IndexedDB queue has no entries:
   - `putIf` the decoded queue, together with a **migration marker**: the
     SHA-256 of the localStorage text;
   - read the queue back and compare;
   - then remove the localStorage key.
4. If the IndexedDB queue has entries, defer. The adapter reports
   `LegacyQueuePending`, and the legacy queue is adopted only once the
   IndexedDB queue holds no entries. Two queues are never merged, and neither
   is dropped.
5. If the marker equals the localStorage text's digest, step 3 already
   committed. Remove the localStorage key only.

### Rationale
- The core has no queue merge. Re-sequencing another queue's entries would
  break FIFO and the in-flight state.
- Draining one queue before adopting the other keeps both orders intact.

### Acceptance criteria
- Running the migration twice equals running it once.
- No entry is in both stores after it completes.
- The core is unchanged: the migration uses only `LocalStorageQueue.loaded`, `OfflineQueue.encode` and `decode`.

### Reference tests
- Over the fake plus a scripted localStorage: absent, present, corrupt, foreign, IndexedDB non-empty (deferred, then adopted), and rerun.

*Sources: ARCA-OFF-002; DF-ARCA-2026-0005 consequences ("a one-time migration of the persisted snapshot"); ARCA-D-012 (copy, verify, retire the source explicitly).*

---

## LCP-067 — The move is safe when interrupted
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter

### Requirement
An interruption at any point MUST end, after the next successful run, with
every entry exactly once in IndexedDB and the localStorage key removed. The
interruption may be a reload, a crash, a lost lock, or a quota failure. The
source MUST be removed only after the target is verified (copy, verify,
retire).

### Rationale
DF-ARCA-2026-0008: migrations copy, verify, then retire the source
explicitly.

### Acceptance criteria
- For each cut point:
  - before the IndexedDB commit: IndexedDB is unchanged and localStorage
    remains;
  - after the commit, before the removal: the marker matches and the next
    run removes only;
  - after the removal: done.
- A quota abort at the commit leaves both stores as they were, and reports `QuotaExceeded`.

### Reference tests
- A fault-injection test per cut point over the fake.
- One real-browser test that closes the tab between commit and removal (Chromium, WebKit).

*Sources: ARCA-MIG-002; DF-ARCA-2026-0008; CHX-370.*

---

## 12. Security and privacy

## LCP-068 — No secrets or tokens in the store
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library + Consumer adapter + documentation

### Requirement
The store MUST NOT be used for credentials. Fides tokens stay in memory, or
per tab, as decided (FID-CLI-002). Arca's queue holds no credential
(ARCA-AUTH-002). Diagnostics and errors MUST NOT contain stored values.

### Rationale
IndexedDB is readable by any script on the origin, survives sign-out unless
cleared, and is not encrypted (LCP-071).

### Acceptance criteria
- docs/41 states the rule.
- Arca's adapter test proves that a persisted snapshot never contains the access token. This is the same sentinel technique as Chrona's sign-in browser test.
- `StoreError` and diagnostics carry names, counts and sizes only.

### Reference tests
- A sentinel-token test over the adapter.
- A diagnostics redaction test in the F# library.

*Sources: FID-CLI-002; ARCA-AUTH-002; CHX-023; SIG ADM-071; ARCA-TEST-004.*

---

## LCP-069 — Origin and namespace isolation, honestly bounded
**Status:** Required · **Priority:** P1 · **Placement:** Capability Pack + documentation

### Requirement
Data is stored per origin by the browser, and per application namespace by
the pack (LCP-048). Documentation MUST state the following:

- the namespace keeps well-behaved applications apart;
- it is **not a security boundary**: any script on the origin can read every
  namespace;
- applications that must not see each other's local data MUST be served from
  different origins.

This mirrors ARCA-LOC's per-repository permission caveat.

### Rationale
Same-origin isolation is the browser's only boundary. Claiming more would
breach Indy P35.10 ("must not claim secure-at-rest properties it does not
implement").

### Acceptance criteria
- docs/41 carries the caveat and the GitHub Pages shared-origin example.
- LCP-048's tests pass.

### Reference tests
- LCP-048's two-namespace test.

*Sources: ARCA-LOC-002, ARCA-LOC-003 (and their caveat); Indy P35.10.*

---

## LCP-070 — What is cleared on sign-out, and what is kept
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library + Consumer adapter + application

### Requirement
**Always cleared on sign-out, under every policy:** rebuildable caches and
derived data held for that account. This includes the offline-start read
cache (LCP-082..087), cached records, reference data, the roster and derived
indexes.

**Kept:** non-secret device preferences.

**Unsent queue entries** belong to the account that made them, and are never
sent with another account's credential. What happens to them at sign-out
follows the application's declared **`sharedDevicePolicy`**:

- **`ask`** (the default for a personal device): when unsent entries exist,
  sign-out MUST say how many there are, and offer either to keep them for
  that account on this device, as Chrona does today, or to discard them.
  Discarding is explicit, confirmed, and uses `deleteRange` (LCP-054).
- **`discardOnSignOut`** (a deployment's choice for shared devices): before
  signing out, the application MUST show how many unsent entries will be
  discarded, and offer to synchronize first when online. On sign-out, it
  discards them, and the discard is recorded in diagnostics. It never
  discards silently.

The policy is a value the adapter receives. The adapter offers both clearing
operations, and never chooses a policy itself.

**Clear this device.** A separate action removes every database in the
application's namespace. Its outcome is typed, including `VersionBlocked`
while another tab holds a connection.

### Rationale
- Discarding unsent work silently is data loss.
- Keeping it silently on a shared device is a privacy surprise.
- Chrona already keeps another account's unsent changes and refuses to send
  them.

### Acceptance criteria
- After sign-out, no cache for that account remains, under either policy.
- Under `ask`, unsent entries remain unless the person discarded them.
- Under `discardOnSignOut`, they are gone after sign-out, and the count was shown before.
- "Clear this device" leaves no database in the namespace, or reports why it could not.

### Reference tests
- Adapter and library tests over the fake.
- A Chrona browser test when it adopts the adapter (Chrona WI-0056).

*Sources: CHX-021, CHX-023, CHX-230; SIG ADM-071; SUM0-015 (caches rebuildable).*

---

## LCP-071 — At-rest encryption: out of scope for now
**Status:** Intentional non-parity (for now) · **Placement:** Intentional Non-Parity

### Requirement
The store MUST NOT claim or provide at-rest encryption in this effort. Values
are opaque JSON to the pack, so a later encrypting codec can be added in the
F# layer without a contract change. Arca's per-application at-rest encryption
remains deferred (Arca **WI-0014**, ARCA-D-007). See
[DF-LIMEN-2026-0005](../../research/decisions/DF-LIMEN-2026-0005--indexeddb-adapter-placement-fallback-and-encryption-scope.md) §3.

### Rationale
- A key usable after reload must itself be stored on the same origin, or
  derived from a session that is memory-only by default (FID-CLI-002).
- The first gives no protection against same-origin script. The second makes
  offline data unreadable after a reload, which defeats durability.
- Disk encryption is the operating system's job.

### Acceptance criteria
- docs/41 states that nothing is encrypted at rest.
- No API name implies otherwise.

### Reference tests
- None until a new decision. An architecture review checks the wording.

*Sources: ARCA-D-007, ARCA-LOC-010; Arca WI-0014; SIG ADM-025; Indy P35.10.*

---

## 13. Observability

## LCP-072 — Structured errors
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library + Consumer adapter

### Requirement
Every failure the F# library or the adapter returns MUST be a case of a
closed union (`StoreError`, and the adapter's failures). It names:

- the operation;
- the database or store;
- the class (`Unavailable`, `Quota`, `Conflict`, `Version`, `Invalid`,
  `Undecodable`, `ConnectionLost`, `OwnedElsewhere`).

Unexpected operational failures at the adapter edge MUST be classifiable
through Aegis, as Arca's boundary failures are (ARCA-ARCH-007).

### Rationale
Applications render failures as text, and Aegis classifies unexpected ones.
Neither may parse strings.

### Acceptance criteria
- No failure is a `string` alone.
- Every case has a stable diagnostic code.
- Errors contain no stored value.

### Reference tests
- Exhaustive mapping tests.
- A redaction test (LCP-068).

*Sources: ARCA-ARCH-007; SIG AER-002, AER-003; CHX-005 (stable diagnostics).*

---

## LCP-073 — Diagnostics an application can show
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library + Consumer adapter

### Requirement
The F# library MUST produce `StoreDiagnostics`:

- the usage and quota estimate (LCP-063);
- whether storage is persisted (LCP-061);
- the databases open, with their versions.

The adapter MUST produce `QueueDiagnostics`:

- the durability mode (LCP-065);
- the queue depth, by `SyncStatus` state;
- the snapshot size against its budget;
- the time of the last successful save;
- the time of the last entry that became `Synchronized` (the **last sync**);
- the ownership state (LCP-059).

All times are inputs from the host, never read by the library.

### Rationale
CHX-230 and SIG ADM-070 require visible sync state, and Chrona shows it. The
person needs to know whether their changes are kept, how many are waiting,
and when anything last reached GitHub.

### Acceptance criteria
- Every field is a value: no callbacks, no mutable cells.
- An unknown measurement is `None`, never zero.
- Chrona's sync-state view can be produced from `QueueDiagnostics` alone.

### Reference tests
- Diagnostics over the fake in each mode, including `MemoryOnly` and `OwnedElsewhere`.

*Sources: ARCA-OFF-003; CHX-230; SIG ADM-070; ARCA-API-005.*

---

## 14. Testing

## LCP-074 — An in-memory fake with the same contract, for F# unit tests
**Status:** Required · **Priority:** P1 · **Placement:** Tooling / Conformance

### Requirement
The F# store package MUST ship a fake `StoreExecutor` whose core is a pure
transition: `FakeStore.step : FakeState -> StoreRequest -> FakeState * StoreResult`.
It MUST model the following:

- several connections (tabs);
- `versionchange` and `blocked`;
- the size limits;
- quota, unavailability, eviction and connection loss, injected on demand;
- compound keys, indexes and ranges.

### Rationale
Consumer tests (Arca, Chrona) need the real contract without a browser, as
Arca's `InMemoryStore` gives for providers.

### Acceptance criteria
- The pure `step` is total.
- The executor wrapper is the only stateful part, and it is not exposed beyond construction.
- The fake passes the shared conformance vectors (LCP-075).

### Reference tests
- The F# conformance runner over the vectors.
- The Arca adapter suite over the fake.

*Sources: ARCA-TEST-001 (in-memory provider for consumers); LCP-031.*

---

## LCP-075 — One conformance suite that both the pack and the fake pass
**Status:** Required · **Priority:** P1 · **Placement:** Tooling / Conformance

### Requirement
`conformance/store/` MUST hold a language-neutral vector set
(`store.vectors.json` with a README), in the style of
`conformance/outbox/`. Each vector is a sequence of requests across named
connections, with the expected results and facts. The real pack, in jsdom
with a scripted IndexedDB and in real browsers, and the F# fake MUST both
pass every vector. A vector that a runner cannot express MUST be reported as
**unsupported, never as passed**.

The adapter level has its own suite: Arca's queue-store conformance (Arca
WI-0019), run against the localStorage, in-memory and IndexedDB stores.

### Rationale
Two implementations of one contract drift unless they share executable
expectations.

### Acceptance criteria
- Every `StoreResult` and `StoreFact` variant is covered by at least one vector.
- The run reports passed, failed and unsupported counts separately.

### Reference tests
- `npm test` (TypeScript runner).
- `npm run test:libraries` (F# runner).

*Sources: LCP-031; ARCA-TEST-001.*

---

## LCP-076 — Real-browser tests in Chromium and WebKit
**Status:** Required · **Priority:** P1 · **Placement:** Tooling / Conformance

### Requirement
The store pack smoke and the conformance vectors MUST run in Playwright
**Chromium and WebKit** in CI, under the strict CSP. Trusted Types is not
enforced in WebKit, and the run records that. Behaviour that differs between
the engines MUST be recorded in docs/41 as measured negative knowledge. A
manual iPad Safari checklist accompanies each release until an automated
device run exists (OQ-LIMEN-IDB-006).

### Rationale
Indy targets iPad Safari, and Forma requires Safari/WebKit
(QD-BROWSER-001). Safari has a history of IndexedDB defects and its own
eviction policy.

### Acceptance criteria
- CI fails if either engine's run fails.
- A WebKit-only skip must name the WebKit behaviour and link its evidence. It never passes silently.

### Reference tests
- `npm run smoke:packs` with the WebKit project added.

*Sources: Indy R9.1; Forma QD-BROWSER-001; CHX-370.*

---

## LCP-077 — Multi-tab, quota-exceeded and interruption tests
**Status:** Required · **Priority:** P1 · **Placement:** Tooling / Conformance

### Requirement
Executable scenarios MUST cover the following:

- two tabs writing the same store and the same queue namespace (LCP-058,
  LCP-059);
- quota exceeded (scripted, and real where the engine enforces it, LCP-050);
- a tab closed mid-transaction (LCP-051);
- ownership moved mid-send (LCP-060);
- migration cut at each point (LCP-067);
- storage cleared mid-session (LCP-062).

### Rationale
These are the failure modes that lose data. Each needs a test that fails if
data is lost.

### Acceptance criteria
- Each scenario asserts the full stored state after recovery, not only the outcome value.

### Reference tests
- The browser scenarios in Chromium and WebKit.
- The fake-based scenarios in the F# and Arca test suites.

*Sources: CHX-430 (scenarios 31, 33, 34); ARCA-OFF-004.*

---

## 15. Performance

## LCP-078 — Performance budgets
**Status:** Required (provisional numbers) · **Priority:** P2 · **Placement:** Tooling / Conformance

### Requirement
The budgets below are p95, measured through the F# WASM boundary on CI's
runners. They are **provisional** until WI-0165's baseline, and are then set
in `bench/budgets.json` with the repository's headroom convention. WebKit
gets the same numbers, and its baseline is recorded.

| Operation | Typical size | Budget (p95) |
|---|---|---|
| Open an existing database, schema matches | up to 5 stores | ≤ 50 ms |
| Open and create a new database | up to 5 stores | ≤ 100 ms |
| One small `get` or `put` round trip | ≤ 4 KB value | ≤ 10 ms |
| `query` of 100 records | ≤ 1 KB each | ≤ 25 ms |
| Arca snapshot `Load` or `Save` | 64 KB (about 100 entries) | ≤ 20 ms |
| Arca snapshot `Load` or `Save` | 1 MB (the localStorage budget's size) | ≤ 100 ms |
| One-time localStorage migration | 1 MB snapshot | ≤ 250 ms |
| Payload: `kernel-with-store` bundle | — | the existing `bench/budgets.json` profile; the F# package adds ≤ 100 KB to a trimmed WASM publish |

### Rationale
Chrona must sync the queue "when the records open, without blocking the first
render" (WI-0033). It must not need history to render today (CHX-380). Each
change is saved twice (write-ahead), so a save must fit comfortably inside an
interaction.

Sizes come from Arca's `LocalStorageQueue.DefaultBudget` (1,000,000 UTF-16
code units). A day of offline time entries is tens of operations, so 64 KB is
typical and 1 MB is the ceiling. Summa has no offline queue, and its future
rebuildable index (SUM0-015) is not sized yet.

### Acceptance criteria
- `npm run bench` reports every row in both engines.
- A budget miss fails the bench gate, or is recorded as evidence with a decision. It is never silently re-baselined.

### Reference tests
- `npm run bench -- --only store` (added by WI-0165).

*Sources: CHX-380, CHX-230; WI-0033; LCP-033 (WASM boundary budgets); DF-LIMEN-2026-0004 (evidence before change).*

---

## 16. Release and distribution

## LCP-079 — Versioning and attested release assets
**Status:** Required · **Priority:** P1 · **Placement:** Tooling / release

### Requirement
The TypeScript pack MUST keep shipping in `@echelon-foundry/limen`
(subpath `./capabilities/store`), published to npm with provenance, as today.
The F# packages `EchelonFoundry.Limen.Contract` and
`EchelonFoundry.Limen.Store` MUST be released in lockstep with the npm
version, as **Sigstore-attested GitHub release assets** on the same Limen
release. The release workflow creates the tag after its checks pass, as
today.

### Rationale
Limen's GitHub releases carry no assets today: it publishes npm with
provenance plus a GitHub release with notes. Attested `.nupkg` assets are the
interim NuGet channel that Arca and Fides use (DF-ARCA-2026-0006,
DF-FIDES-2026-0006) until nuget.org Trusted Publishing exists. Lockstep keeps
the F# fingerprint and the TypeScript pack from disagreeing.

### Acceptance criteria
- `gh attestation verify <nupkg> --repo kemiller2002/limen` succeeds for each package.
- The release fails if a package is missing or its version differs from `package.json`.

### Reference tests
- The publish workflow's packed-artifact verification step, extended to the `.nupkg` files.

*Sources: ARCA-ARCH-006; DF-ARCA-2026-0006; REG-REL-010, REG-REL-012.*

---

## LCP-080 — echelon-registry entry and consumption through Conditor
**Status:** Required · **Priority:** P1 · **Placement:** Tooling / release (cross-repository)

### Requirement
Each release MUST be recorded in echelon-registry
(`releases/limen/<version>.release.json`), with the NuGet artifacts and their
digests, and selected in `echelon-current`. Consumers (Arca, Chrona) MUST
obtain the F# packages through Conditor's NuGet release-asset feed
(`vendor/nuget`, a `limen.lock`), never from a public feed.

### Rationale
This is the same supply chain Arca's packages already use in Chrona
(`vendor/nuget/arca.lock`).

### Acceptance criteria
- `conditor upgrade --current --check` lists the Limen NuGet feed.
- `conditor verify` proves the digests in a consuming repository.

### Reference tests
- Arca WI-0016's build consumes the packages through Conditor.

*Sources: ARCA-D-011; docs/consuming-arca.md (the pattern).*

---

## 16a. Out of scope

## LCP-081 — Out of scope
**Status:** Intentional non-parity · **Placement:** Intentional Non-Parity

### Requirement
The following are deliberately **not** provided:

- general ORM-like or ad-hoc querying: joins, filters on non-indexed fields,
  aggregation beyond `count`, or a query language;
- cross-origin storage or synchronization;
- any sync, replication, merge or conflict policy in Limen. That stays in Arca
  and the application;
- an automatic fallback inside Limen (LCP-065);
- binary or `Blob` values, `File` handles, or structured-clone types beyond
  JSON;
- storage buckets, OPFS or Cache Storage;
- at-rest encryption (LCP-071);
- multiple writers to one Arca namespace queue (LCP-059);
- forwarding a non-owner tab's writes to the owner (OQ-LIMEN-IDB-001);
- a read cache that serves write decisions, or that holds unsent changes
  (LCP-085, LCP-083);
- treating IndexedDB as complete offline support, which LCP-034 already
  forbids.

### Rationale
Each of these is either application meaning, a separate capability, or a
weakening of the boundary.

### Acceptance criteria
- Proposals for any of these require a new decision record.

### Reference tests
- None.

*Sources: LCP-034; LCP-019 (the precedent for intentional non-parity).*

---

## 16b. Offline-start read cache

Chrona asked for a read-only, rebuildable local copy of what it has already
read, so it can open without GitHub (coordinator, 2026-10-08). The same
mechanism serves:

- Summa's rebuildable runtime index (SUM0-015);
- Signal's verified template cache by hash (ADM-055);
- the cached snapshots that Signal's read-only offline mode may show
  (ADM-070).

## LCP-082 — Read-cache placement: an Arca-facing adapter over the generic pack
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter (`EchelonFoundry.Arca.Limen`), with a pure port in `Arca.Core`

### Requirement
The read cache MUST be a **second Arca-facing adapter**, not only a
documented pattern on the store pack:

- `Arca.Core` gains a pure **read-cache port**: cache entries as data, and
  freshness rules as total functions;
- `EchelonFoundry.Arca.Limen` implements the port over `limen.store`;
- an in-memory implementation serves tests.

Limen stays generic. It supplies namespaces (LCP-048), compound keys
(LCP-047), `deleteRange` (LCP-054), size limits (LCP-050) and durability
evidence (LCP-061..063), and learns nothing about caches, tokens or records.
Decided in
[DF-LIMEN-2026-0005](../../research/decisions/DF-LIMEN-2026-0005--indexeddb-adapter-placement-fallback-and-encryption-scope.md) §4.

### Rationale
- What makes a cache safe is Arca knowledge: which change token a read
  reflects, how to compare it with the provider's, the content hash and
  integrity validation (ARCA-INT-001), and namespace identity.
- A documented pattern would have Chrona, Summa and Signal each re-derive the
  staleness rules, and the rules are the risky part.
- A pure port keeps the rules testable without a browser.
- This follows the queue precedent: the port is in the core and the
  IndexedDB adapter is in `Arca.Limen` (LCP-046).

### Acceptance criteria
- The port has no Limen or browser type, and `Arca.Core` stays pure (ARCA-ARCH-001).
- The IndexedDB implementation, the in-memory implementation and any later one pass one read-cache conformance suite.
- Limen's contract gains no cache-specific request.

### Reference tests
- Read-cache conformance over the in-memory and IndexedDB implementations (via the Limen fake).

*Sources: Chrona request (coordinator 2026-10-08); CHX-021, CHX-380; SUM0-015; SIG ADM-055, ADM-070; ARCA-ARCH-001, ARCA-MIG-001.*

---

## LCP-083 — Every cached entry records what it reflects
**Status:** Required · **Priority:** P1 · **Placement:** Arca port + consumer adapter

### Requirement
Each cache entry MUST carry:

- the namespace, the account it was read with, and the partition, such as an
  activity month, the reference folder, the roster or a derived index;
- the **change token** (the commit it reflects);
- the content hash of every record in it;
- its record schema version;
- the time it was read (an input).

An entry is keyed by `[account, namespace, partition]`, a compound key
(LCP-047). The cache MUST hold only what was read and validated from the
provider (ARCA-INT-001). It never holds unsent changes, which live only in
the queue, and never anything derived from them.

### Rationale
Without the token, a reader cannot tell how old a cached state is or what to
compare it against. Mixing in unsent changes would turn the cache into a
competing authority (CHX-021, ARCA-OFF-006).

### Acceptance criteria
- An entry without a token, or with a mismatched content hash, is refused on load as `Corrupt`, dropped and re-read. It is rebuildable, so nothing is lost.
- A cached derived index records the source token it was built from (ARCA-MIG-001).

### Reference tests
- Round-trip and tamper tests over the port.
- A derived-index entry carries its source token.

*Sources: ARCA-INT-001, ARCA-MIG-001, ARCA-OFF-006; CHX-021, CHX-380, CHX-400.*

---

## LCP-084 — Revalidated against the provider when online
**Status:** Required · **Priority:** P1 · **Placement:** Arca port + consumer adapter + application

### Requirement
**Opening offline.** The application may render cached partitions at once,
marked "as of" their token and read time (ARCA-OFF-003).

**When the provider is reachable,** the adapter MUST compare each shown
partition's token with the provider's current change token, and then:

- an **equal** token confirms the entry;
- a **different** token refreshes the partition from the provider, then
  replaces the entry. If the refresh fails, the entry stays marked stale; it
  is never shown as current;
- a partition the provider says no longer exists is **removed**.

Once Arca offers namespace-scoped change tokens (Arca WI-0018), the
comparison SHOULD use them, so that another application's commit does not
invalidate Chrona's cache.

### Rationale
GitHub is the source of truth. The cache only shortens the time to first
render.

### Acceptance criteria
- After going online, no partition stays "current" without a token match.
- A refresh failure leaves a visible stale marker.
- Revalidation reads only the shown partitions' tokens: no repository-wide scan (ARCA-API-001).

### Reference tests
- Over the in-memory provider: equal token (kept), changed token (refreshed), removed partition (dropped), provider unreachable (stale marker).

*Sources: CHX-021, CHX-230, CHX-380; ARCA-API-001, ARCA-OFF-003; SIG ADM-070 ("whether displayed data may be stale").*

---

## LCP-085 — Never the basis of a write decision without revalidating
**Status:** Required · **Priority:** P1 · **Placement:** Arca port (types) + application

### Requirement
Cached values MUST have a type distinct from values read from the provider,
for example `Cached<'T>` and `Fresh<'T>`. No Arca function that builds or
conditions a write accepts a `Cached` value or its token. A write's expected
base and change token come only from a provider read. Write decisions made
offline are queued (LCP-060), and Arca's existing reconciliation re-decides
them against provider state before they are sent (ARCA-OFF-004, Chrona's
`Reconcile`).

### Rationale
A stale cache that drove a write would overwrite newer data without knowing
it. Making the distinction a type removes the mistake rather than reviewing
for it.

### Acceptance criteria
- A compile-failure fixture: passing a `Cached` token to `Operation`'s change-token condition does not compile.
- Promoting a cached value to `Fresh` requires a provider read whose token matches.

### Reference tests
- The compile-failure fixture.
- Property: no sequence of cache operations yields a `Fresh` value without a provider read.

*Sources: ARCA-CON-001, ARCA-CON-002, ARCA-OFF-004, ARCA-OFF-006; CHX-021, CHX-200; Indy P31.9.*

---

## LCP-086 — Cleared by the sign-out and shared-device policy
**Status:** Required · **Priority:** P1 · **Placement:** Consumer adapter + application

### Requirement
On sign-out, the read cache for that account MUST be cleared under both
`sharedDevicePolicy` values (`ask` and `discardOnSignOut`). It is one
`deleteRange` over `[account, …]` (LCP-054, LCP-070).

"Clear this device" removes every account's cache. An entry read with
another account's credential MUST never be shown to, or revalidated with, a
different account.

Clearing the cache never touches the queue. The queue follows LCP-070's
policy rule.

### Rationale
The cache holds the account's records in readable form on the device. It is
rebuildable, so clearing it costs only an online re-read.

### Acceptance criteria
- After sign-out under either policy, a `count` over the account's range is 0.
- A second account on the device sees none of the first account's entries.
- A clearing failure is reported (`VersionBlocked`, `Unavailable`), never ignored.

### Reference tests
- Over the fake: two accounts; sign-out of one under each policy; clearing blocked by another tab.

*Sources: LCP-070; CHX-023; SIG ADM-071; FID-CLI-002.*

---

## LCP-087 — Bounded and best-effort
**Status:** Required · **Priority:** P2 · **Placement:** Consumer adapter

### Requirement
The cache MUST have a per-namespace size budget. When it is over budget, the
least recently used partitions are evicted first. The cache MUST never
compete with the queue for space:

- a cache write that fails for any reason (quota, size limit or
  unavailable) MUST NOT fail the read that produced it.
  The failure is reported in diagnostics only;
- before a queue save that would exceed the quota, cache partitions are
  evicted first.

Unlike the queue, any tab may write the cache. Each entry is a whole
partition written with `put`, and two tabs writing the same partition both
hold provider-validated states, either of which is valid.

### Rationale
The cache is an optimization, and losing it loses nothing. The queue holds
the person's unsent work.

### Acceptance criteria
- At the budget, the oldest partition is evicted first.
- With quota exhausted, a read still succeeds, and a queue save is attempted after cache eviction.
- `QueueDiagnostics` and the cache's diagnostics report cache size and evictions (LCP-073).

### Reference tests
- Budget and eviction over the fake.
- A scripted quota abort on a cache write leaves the read's result intact.

*Sources: CHX-380; SUM0-015; ARCA-OFF-002; LCP-050.*

---

## 17. Work items and build order

The Limen items are in this repository's Praxis queue. The adapter and
consumer items are in their own repositories' queues. Each item cites its
requirement IDs.

| Order | Work item | Slice | Requirements | Depends on |
|---:|---|---|---|---|
| 0 | WI-0156 | These requirements, DF-LIMEN-2026-0005 and the backlog | all | — |
| 1 | WI-0157 | Store pack: application namespaces and size policy | LCP-043, 048, 050, 069 | WI-0156 |
| 2 | WI-0158 | Store pack: compound key paths, `count`, `deleteRange` | LCP-043, 047, 054 | WI-0157 |
| 3 | WI-0159 | Store pack: `persist`, `estimate`, `ConnectionLost`, creation evidence, availability | LCP-061..064 | WI-0158 |
| 4 | WI-0160 | Store conformance vectors; the TypeScript pack passes them; multi-tab, quota and interruption scenarios in Chromium | LCP-051..053, 057, 058, 075, 077 | WI-0159 |
| 5 | WI-0161 | WebKit real-browser runs (guardrail: CI) | LCP-076 | WI-0160 |
| 6 | WI-0162 | Publishable `EchelonFoundry.Limen.Contract`; attested `.nupkg` release assets (guardrail) | LCP-044, 079 | WI-0156 (parallel to 1–5) |
| 7 | WI-0163 | Functional F# API `EchelonFoundry.Limen.Store` | LCP-045, 049, 052, 053, 055..057, 072, 073 | WI-0159, WI-0162 |
| 8 | WI-0164 | F# in-memory fake and F# conformance runner | LCP-074, 075 | WI-0160, WI-0163 |
| 9 | WI-0165 | Performance baseline and budgets, Chromium and WebKit | LCP-078 | WI-0161, WI-0163 |
| 10 | WI-0166 | Release Limen 0.8.0 with the F# packages; registry entry; Conditor proof; consumer, privacy and sign-out guidance in docs/41 | LCP-068..071, 079, 080 | WI-0161, WI-0164, WI-0165 |
| A1 | Arca WI-0019 | Queue-store port conformance suite (localStorage, in-memory; IndexedDB when it exists) | LCP-046, 060, 075 | — (can start now) |
| A2 | Arca WI-0016 | `EchelonFoundry.Arca.Limen`: the IndexedDB `QueueStore`, ownership and fencing, durability-mode composer, diagnostics | LCP-046, 059, 060, 062, 065, 068, 070, 072, 073 | Limen WI-0166, Arca WI-0019 |
| A3 | Arca WI-0020 | One-time localStorage-to-IndexedDB migration | LCP-066, 067 | Arca WI-0016 |
| A4 | Arca WI-0021 | Read-cache port in `Arca.Core` (`Cached`/`Fresh`, token freshness rules), in-memory implementation and read-cache conformance suite | LCP-082..086 | — (can start now) |
| A5 | Arca WI-0022 | IndexedDB read cache in `EchelonFoundry.Arca.Limen`: compound-keyed partitions, revalidation, policy-driven clearing, budget and eviction | LCP-082..087 | Arca WI-0016, Arca WI-0021 |
| C1 | Chrona WI-0056 | Adopt the IndexedDB queue adapter: ownership notice for a second tab, durability mode in sync state, `sharedDevicePolicy` (`ask` \| `discardOnSignOut`) at sign-out, migration on first run | LCP-059, 065, 070, 073 | Arca WI-0020 released |
| C2 | Chrona WI-0057 | Offline start from the read cache: activities by month, derived activity index, reference data and roster, shown "as of" their token, revalidated online, cleared on sign-out | LCP-082..087 | Arca WI-0022 released; Chrona WI-0034 for the derived index |

## 18. Open questions

Only questions this document cannot settle. Each has a **proposed** answer for
the user to confirm.

| ID | Question | Proposed answer |
|---|---|---|
| OQ-LIMEN-IDB-001 | A second tab of the same application cannot own the queue (LCP-059). Should it forward its writes to the owner tab over the coordination channel, or work without queued offline writes? | **Proposed:** v1 needs no forwarding. The second tab says that another tab holds this device's unsent changes, offers "use this tab instead" (steal the lock; the first tab is fenced), and still writes directly while online. Forwarding is a later item if real use needs it. |
| OQ-LIMEN-IDB-002 | Which `sharedDevicePolicy` is the default when a deployment does not set one? | **Proposed:** `ask`. Unsent changes are kept for that account (Chrona's current behaviour), with a visible count and an explicit, confirmed "discard". `discardOnSignOut` is opted into per deployment for shared devices (LCP-070). The read cache is cleared on sign-out under both (LCP-086). |
| OQ-LIMEN-IDB-003 | The new IDs continue the LCP numbering (LCP-043..087) outside issue #15's scorecard. Should #15 list them? | **Proposed:** yes. Add one scorecard row, "LCP-043..087 durable storage cluster (extends LCP-018)", linking this document, so the numbers cannot be reused. |
| OQ-LIMEN-IDB-004 | When should an application call `persist`? | **Proposed:** after the first offline write is queued, when the person has something to lose and the browser's engagement heuristics are most likely to grant it. Never at first load, because Firefox prompts. |
| OQ-LIMEN-IDB-005 | Should the F# packages share the npm version (lockstep) or have their own? | **Proposed:** lockstep (LCP-079). The contract fingerprint ties them anyway, and one version is one thing to pin. |
| OQ-LIMEN-IDB-006 | Is Playwright WebKit enough for Indy's iPad Safari target? | **Proposed:** Playwright WebKit in CI, plus a manual iPad Safari checklist per release (open, write, reload, two tabs, private mode), until a device run exists. iOS eviction policy cannot be automated and is covered by LCP-062's detection, not by a test. |

## 19. Requirement count

| Area | IDs | Count |
|---|---|---:|
| Scope and layering | LCP-043..046 | 4 |
| Data model | LCP-047..050 | 4 |
| Transactions | LCP-051..054 | 4 |
| Schema versioning and migrations | LCP-055..057 | 3 |
| Concurrency across tabs | LCP-058..060 | 3 |
| Durability | LCP-061..063 | 3 |
| Availability and fallback | LCP-064..065 | 2 |
| Migration from localStorage | LCP-066..067 | 2 |
| Security and privacy | LCP-068..071 | 4 |
| Observability | LCP-072..073 | 2 |
| Testing | LCP-074..077 | 4 |
| Performance | LCP-078 | 1 |
| Release and distribution | LCP-079..080 | 2 |
| Out of scope | LCP-081 | 1 |
| Offline-start read cache | LCP-082..087 | 6 |
| **Total** | | **45** |
