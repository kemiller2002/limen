---
identifier: DF-LIMEN-2026-0004
title: Virtualization is not built — the evidence gate is not met
type: decision-record
status: accepted
version: 1.0.0
author_agent: claude-code
created: 2026-09-29
updated: 2026-09-29
related_projects: [limen]
related_documents:
  - docs/27-performance-baseline.md
  - bench/results/baseline-2026-09-29.json
supersedes: []
superseded_by: []
tags: [performance, virtualization, evidence-gate, lcp-015]
work_items: [WI-0099, WI-0042, WI-0043, WI-0045]
external_references: ["kemiller2002/limen#37", "kemiller2002/limen#19"]
---

# DF-LIMEN-2026-0004 — Virtualization is not built: the evidence gate is not met

## Context

Issue #37 (LCP-015) allows list and grid virtualization only if controlled
measurements show that normal keyed rendering is insufficient. When the
evidence does not justify it, the issue requires the conclusion to be
recorded and no runtime change to be made. The measurements are the #19
baseline, recorded in `bench/results/baseline-2026-09-29.json` and explained in
[docs/27](../../docs/27-performance-baseline.md). They were taken in real
Chromium, cross-origin isolated, with the kernel applying keyed `data-each`
projections.

## Evidence

Median milliseconds per operation, and the DOM mutations each caused:

| Rows | Initial render | Unchanged re-projection | Update one row | Insert | Remove |
| --- | --- | --- | --- | --- | --- |
| 1,000 (direct) | 19.4 ms, 2,000 | 1.5 ms, 1,000 | 1.5 ms, 1,000 | 1.4 ms, 1,002 | 2.3 ms, 2,001 |
| 10,000 (direct) | 132.8 ms, 20,000 | 22.8 ms, 10,000 | 28.7 ms, 10,000 | 27.7 ms, 10,002 | 40.4 ms, 20,001 |
| 10,000 (JSON boundary) | 175.4 ms | 48.6 ms | 43.5 ms | 43.3 ms | 52.7 ms |

Updating **one** row of 10,000 performs **10,000** mutations. The unchanged
re-projection performs the same number. The update cost is therefore not the
cost of keeping 10,000 rows in the DOM. It is the cost of rewriting every
bound value on every projection (WI-0043). At the JSON boundary, strict
decoding of a 10,000-row view adds 17.1 ms (WI-0045). A removal costs twice an
insertion because each following row is re-inserted (WI-0044).

## Decision

**Virtualization is not built.** At 1,000 rows every operation stays well
inside a frame. At 10,000 rows the per-update cost exceeds a frame, but the
measurements attribute that cost to three kernel inefficiencies, each already
a separate work item. Virtualizing now would hide those costs instead of
removing them. It would also bring the costs the issue warns about: identity,
focus and scroll anchoring across window boundaries, and more renderer surface.

No runtime change is made.

## What reopens this

Re-run `npm run bench -- --only list-10k` after WI-0043 (write only changed
bindings) and WI-0045 (decoder throughput). Add a 100,000-row scenario at the
same time, since it has not been measured. Virtualization becomes warranted
if, after those fixes, either of these holds:

- a one-row update or an unchanged re-projection at the target size stays
  above 16 ms median in Chromium;
- the initial render at the target size remains the user-visible problem for a
  real consumer.

Then #37's own requirements apply:

- stable keyed identity;
- keyboard and focus navigation across window boundaries (the focus and
  measure packs are the mechanisms);
- scroll anchoring when rows are inserted above the viewport;
- sorting and filtering staying in the engine.

## Negative knowledge

- 100,000 rows were not measured. The issue's 10k/100k workload names it, and
  the reopen condition requires it.
- The initial 10,000-row render (133 ms direct) is a one-time cost. It was not
  judged against a real consumer, because none exists yet.
