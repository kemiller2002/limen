---
identifier: DF-LIMEN-2026-0005
title: The Arca IndexedDB adapters live in an Arca bridge package; Limen never falls back silently; no at-rest encryption for now
type: decision-record
status: accepted
version: 1.0.0
author_agent: claude-code
created: 2026-10-08
updated: 2026-10-08
related_projects: [limen, arca, chrona]
related_documents:
  - docs/requirements/LIMEN-INDEXEDDB-REQUIREMENTS.md
  - docs/41-indexeddb.md
  - contract/store.contract.json
supersedes: []
superseded_by: []
tags: [indexeddb, storage, offline, arca, fallback, encryption, lcp-018]
work_items: [WI-0156]
external_references: ["kemiller2002/limen#28", "kemiller2002/arca WI-0016", "kemiller2002/arca WI-0014", "DF-ARCA-2026-0005", "DF-ARCA-2026-0002"]
provenance:
  contributions:
    EXE-20261008T150528666Z-2b2b06eb:
      operations: [created]
      at: 2026-10-08T15:13:03.474Z
      actor:
        kind: agent
        id: anthropic/claude-code
        provider: anthropic
        model: unknown
        runtime: claude-code
      reason: "Adapter placement, fallback policy, encryption scope and read-cache placement for LCP-043..087"
---

# DF-LIMEN-2026-0005 — IndexedDB adapter placement, fallback policy, encryption scope and the read cache

## Context

Arca's offline change queue persists to localStorage through an interim
adapter, behind the `QueueStore` port (ARCA-OFF-002, DF-ARCA-2026-0005).
Limen already ships the IndexedDB store pack (`limen.store`, LCP-018). Its F#
binding is not consumable, and nothing yet connects the two. Chrona has also
asked for an offline-start read cache.

[The requirements](../../docs/requirements/LIMEN-INDEXEDDB-REQUIREMENTS.md)
(LCP-043..087) needed four decisions:

- where the Arca adapter lives;
- what happens when IndexedDB is not usable;
- whether at-rest encryption is in scope;
- whether the read cache is an Arca adapter or a documented pattern.

## Decision

### 1. The Arca adapters live in a new Arca bridge package: `EchelonFoundry.Arca.Limen`

The package is in kemiller2002/arca. It references `EchelonFoundry.Arca.Core`
and `EchelonFoundry.Limen.Store`. It implements the existing `QueueStore`
port unchanged, and the read-cache port (section 4).

Alternatives:

| Option | Why not |
|---|---|
| In Limen | Limen is the lower layer: it would depend on Arca, and its releases on Arca's. The localStorage key format and the queue migration are Arca knowledge. |
| In `Arca.GitHub`, beside `LocalStorageQueue` | Every user of the GitHub provider would take a Limen dependency, including Signal, which opts out of the offline queue (ADM-070, DF-SIGNAL-2026-0001). |
| In `Arca.Core` | The core performs no I/O and references no host (ARCA-ARCH-001). |
| **A bridge package** | Chosen. Neither family depends on the other. The dependency is explicit and opt-in. The pattern is `EchelonFoundry.Fides.Arca` (DF-FIDES-2026-0008). |

Limen's own share is generic:

- the pack additions (LCP-047, 048, 050, 054, 061..064);
- `EchelonFoundry.Limen.Contract` and `EchelonFoundry.Limen.Store`
  (LCP-044, 045);
- the fake and the conformance vectors (LCP-074, 075).

**Single ownership, inside the adapter.** The port saves whole snapshots, so
two tabs saving one namespace lose entries. The localStorage adapter does so
today. Because the port must not change, the adapter makes one tab the owner,
through a coordination-pack lock, and fences a pre-empted owner with an epoch
compared by `putIf` (LCP-059). Ownership is adapter API, outside the port.

### 2. Fallback: Limen never falls back; Arca's composer does, visibly

The store pack answers `Unavailable` or `availability` with a typed reason
(LCP-064), and nothing else. The Arca adapter offers a composer that tries
**IndexedDB, then localStorage, then memory**. It returns the durability mode
it obtained (LCP-065), and the application must display it.

In `MemoryOnly` mode, the application either:

- warns before accepting an offline write that unsent changes will not
  survive closing the tab; or
- refuses offline writes.

Which of the two is the application's choice. It never shows a durable state
that is not durable. The queue is never written to two stores at once. Moving
from localStorage to IndexedDB is the one-time, drain-then-adopt migration
(LCP-066, 067).

### 3. At-rest encryption is out of scope (LCP-071)

The two ways to give a browser key are both bad:

- **A key stored on the same origin** gives no protection against the only
  attacker that can read the origin's IndexedDB.
- **A key derived from the session** makes offline data unreadable after a
  reload, because Fides retains tokens in memory by default (FID-CLI-002).
  That defeats the purpose.

Arca already deferred per-application encryption (ARCA-D-007, Arca
**WI-0014**). Values are opaque JSON to the pack, so an encrypting codec can
later be added in the F# layer with no contract change. Until then,
documentation states that nothing is encrypted at rest (Indy P35.10).

### 4. The offline-start read cache is a second Arca-facing adapter, not a Limen pattern (LCP-082)

- `Arca.Core` gains a pure read-cache port, with the types `Cached` and
  `Fresh` and freshness rules over change tokens and content hashes.
- `EchelonFoundry.Arca.Limen` implements the port over `limen.store`.
- Limen adds nothing cache-specific.

**Why not a pattern documented on the generic pack?** The safety rules are
Arca knowledge:

- which change token a read reflects;
- integrity validation (ARCA-INT-001);
- namespace and account identity;
- that a cached value can never condition a write (ARCA-CON-001).

Chrona, Summa (SUM0-015) and Signal (ADM-055, ADM-070) would each re-derive
those rules from prose. A pure port makes the rules testable and shared, and
makes `Cached` versus `Fresh` a type rather than a review item (LCP-085).
docs/41 points to the Arca cache rather than describing a parallel one.

**Clearing.** Clearing follows the application's `sharedDevicePolicy`
(`ask` | `discardOnSignOut`):

- the read cache is cleared at sign-out under both values;
- the policy decides only what happens to unsent queue entries (LCP-070,
  LCP-086).

## Consequences

- Arca WI-0016 is redefined as the `Arca.Limen` package and its queue store.
  New Arca items cover:
  - WI-0019: queue-store conformance;
  - WI-0020: migration;
  - WI-0021: the read-cache port;
  - WI-0022: the IndexedDB read cache.
- Chrona adopts the adapter (WI-0056) and the cache (WI-0057). It can show a
  second tab why it does not hold the queue.
- Limen's work (WI-0157..WI-0166) is all generic, and is consumable by any F#
  engine.
- A multi-writer queue, and forwarding a second tab's writes to the owner, are
  explicitly not built (LCP-081, OQ-LIMEN-IDB-001).

## What reopens this

- **Section 1:** the `QueueStore` port gains per-entry operations. Multiple
  writers could then be safe without a single owner.
- **Section 2:** a browser exposes a reliable signal for ephemeral, private
  storage.
- **Section 3:** a user decision on Arca WI-0014, or a key-custody mechanism
  that survives reload without living on the origin.
- **Section 4:** a non-Arca consumer needs a cache with the same freshness
  rules. The port would then move down into a shared library.
