---
id: RQ-LIMEN-2026-A008
title: Explicit HTTP cache mode on the Core Http effect
status: accepted
version: 1.0.0
created: 2026-10-24
updated: 2026-10-24
owners:
  - limen
related_documents:
  - .praxis/inbox/documents/limen-http-cache-mode.md
  - architecture/work-scopes/WI-0175.json
  - contract/core.contract.json
  - docs/43-http-profiles.md
  - test/http-profile.test.ts
tags: [requirements, http, cache, protocol-1-5, dc-005, wi-0175]
work_items: [WI-0175]
provenance:
  contributions:
    EXE-20261024T133142995Z-6331f1da:
      operations: [created]
      at: 2026-10-24T13:33:40.000Z
      actor:
        kind: agent
        id: anthropic/claude-code
        provider: anthropic
        model: claude-opus-5-5
        runtime: claude-code
      reason: "Define the explicit Http cache mode requirement (DC-005)"
---

# Explicit HTTP cache mode on the Core Http effect

Source input: [`.praxis/inbox/documents/limen-http-cache-mode.md`](../../.praxis/inbox/documents/limen-http-cache-mode.md).
Defect class DC-005: a mutable read answered by the browser HTTP cache, so a
cached `200` masked a later `401` after the user changed their token.

## Functional behavior

1. `HttpEffectRequest` MUST carry an optional `cache` field of the contract
   enum `HttpCacheMode`: `default`, `no-store`, `no-cache` or `reload`.
2. Absent, the kernel MUST pass no `cache` init to `fetch` (today's
   behaviour). Present, it MUST pass the value unchanged and decide nothing.
3. Every generated decoder MUST refuse an undeclared value at `$.cache`.
4. The field is protocol 1.5. An engine MUST send it only after negotiating
   1.5 or later.
5. `force-cache` and `only-if-cached` are out of the contract on purpose.

## Invariant to document

A read whose answer can change with server state or with the credentials
sent MUST set `cache: "no-store"`. Correlation ids are separate: they reject a
stale result, not a stale response.

## Acceptance criteria and verification

- `test/http-profile.test.ts`: absent means no `cache` init; each mode is
  passed exactly.
- `conformance/vectors/core.vectors.json`: valid and undeclared-value
  vectors, run by the TypeScript, F#, C# and Rust bindings.
- `guests/fsharp/Limen.Contract.Conformance`: a typed encode/decode of
  `HttpCacheMode.NoStore`.
- `test/browser/packs/core-http`: in Chromium, a `max-age=60` response is
  served from the cache by default and a `no-store` read reaches the server.
