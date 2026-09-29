# Performance baseline

> **Optional — not Limen Core.** This is performance measurement, a tooling. It composes with the Core concept `projection-output`: it measures what applying projections and loading Limen cost. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

What Limen costs today, measured rather than assumed, so optimization is
chosen from evidence and parity work cannot silently inflate the default
footprint (kemiller2002/limen#19, LCP-004 and LCP-033).

The rule that governs everything below: **measure first, budget from the
measurement, optimize in a separate work item**. Nothing in this document
changed a contract or added a mechanism. Binary codecs, shared memory, delta
protocols and virtualization are all still unjustified: the numbers below do
not call for any of them.

The Core's own size and conceptual surface are gated separately, by
`npm run check:core-budget` ([guardrails](25-guardrails.md#the-core-complexity-budget),
kemiller2002/limen#62). That report measures the minimal consumer's payload
with the same code as the `minimal-consumer` profile here (`bench/size.ts`),
so the two never disagree.

## Reproducing it

```bash
npm run build:guests    # optional: the F#, C# and Rust guests (.NET SDK 8, cargo)
npm run bench           # → bench/results/latest.json
npm run bench -- --runs 5 --only list-10k,guests
npm run bench -- --compare bench/results/baseline-2026-09-29.json --tolerance 2
```

| Part | What | Where |
| --- | --- | --- |
| Page scenarios | The real `BrowserKernel` from `dist/`, driven in Chromium against an in-page engine | [`bench/pages/bench.ts`](../bench/pages/bench.ts) |
| Guest engines | The F#, C# and Rust minimal engines through one host page | `dist-guests/`, from [`scripts/build-guests-site.ts`](../scripts/build-guests-site.ts) |
| Sizes | The import closure of each consumer profile | [`bench/size.ts`](../bench/size.ts), [`bench/budgets.json`](../bench/budgets.json) |
| Harness | Serves, runs, combines runs, records the environment | [`scripts/bench.ts`](../scripts/bench.ts) |

**How a sample is timed.** From the DOM action (a click, a `change`) to the
`MutationObserver` callback that follows the projection. The kernel applies a
projection synchronously, so that callback runs after the whole projection is
in the DOM. That covers event → engine → projection, but not the browser's
own style, layout and paint after it. Each sample also records how many DOM
mutations the projection made.

**Timer resolution.** The harness serves pages cross-origin isolated
(COOP + COEP), so `performance.now()` resolves to 5µs instead of Chromium's
coarsened 100µs. Every result records `crossOriginIsolated`.

**Direct and JSON boundary.** Each page scenario runs twice. The JSON run
serializes every message, parses it, and strictly decodes it with the
generated codec, exactly as the .NET and Rust WebAssembly transports do. The
difference between the two runs is the cost of the boundary itself, apart
from any one language's runtime.

**Why timings are not a CI gate.** Shared runners vary by more than any
threshold worth enforcing. Timings are recorded and compared on demand with
`--compare`. Sizes are deterministic, so they are enforced on every change
by [`test/bench-size.test.ts`](../test/bench-size.test.ts).

## Environment of the recorded baseline

[`bench/results/baseline-2026-09-29.json`](../bench/results/baseline-2026-09-29.json)
holds every run. It was recorded on:

- Linux 6.18, Intel Xeon at 2.80GHz, 4 cores, 15.7 GiB
- Node 22.22.2
- Chromium 141.0.7390.37 through Playwright 1.56.1, headless
- 3 fresh browser contexts per scenario

This is a hosted sandbox. Treat the absolute numbers as that machine's, and
the ratios between rows as the finding.

## Results

Medians, with p95 in parentheses, in milliseconds.

### Boundary round trips

| Scenario | Direct | JSON boundary | DOM mutations |
| --- | --- | --- | --- |
| Kernel start (Initialize round trip + first projection), cold | 1.5 | 2.7 | — |
| Navigation start → kernel running, cold / warm | 67 / 12 | 74 / 14 | — |
| Small semantic event round trip | 0.010 (0.03) | 0.025 (0.09) | 1 |
| One of 100 form fields changed | 0.26 (0.63) | 0.39 (1.05) | 100 |
| All 100 form fields changed | 0.49 (1.30) | 0.64 (2.42) | 100 |
| 100 form fields, nothing changed | 0.25 (2.19) | 0.37 (0.71) | **100** |
| One route change (100 sequential `push` effects) | 0.13 | 0.17 | — |
| Federation request → reply exchange (in-process) | 0.005 (0.03) | — | — |

### Keyed lists

| Operation | 1k direct | 1k JSON | 10k direct | 10k JSON | Mutations (1k / 10k) |
| --- | --- | --- | --- | --- | --- |
| Initial render | 19.4 | 18.9 | 133 | 175 | 2,000 / 20,000 |
| Unchanged re-projection | 1.54 | 3.59 | 22.8 | 48.6 | **1,000 / 10,000** |
| Update one row | 1.52 | 3.43 | 28.7 | 43.5 | 1,000 / 10,000 |
| Insert in the middle | 1.44 | 3.45 | 27.7 | 43.3 | 1,002 / 10,002 |
| Remove from the middle | 2.31 | 4.68 | 40.4 | 52.7 | **2,001 / 20,001** |
| Append | 1.71 | 3.62 | 26.4 | 39.7 | 1,002 / 10,002 |
| Remove the last row | 1.46 | 3.59 | 24.7 | 46.6 | 1,001 / 10,001 |
| Reverse | 3.42 | 5.53 | 55.9 | 70.7 | 2,998 / 29,998 |

### Serialization of one large view (no DOM)

| Rows | JSON bytes | `JSON.stringify` | `JSON.parse` | Generated strict decode |
| --- | --- | --- | --- | --- |
| 1,000 | 41,339 | 0.08 | 0.16 | 1.9 |
| 10,000 | 432,839 | 0.94 | 1.66 | **17.1** |

### Guest engines: one host, one contract

The same unmodified host page and kernel, with the handshake required.
"Handshake" is navigation start → the kernel's verified handshake. "Round
trip" is event → engine → Storage effect → result → engine → projection.

| Guest | Cold download | Requests | Cold handshake | Warm handshake | Round trip |
| --- | --- | --- | --- | --- | --- |
| F# (.NET WebAssembly, untrimmed) | **26.0 MB** | 188 | **1,581** | 349 | 1.53 (4.84) |
| C# (.NET WebAssembly, trimmed) | 5.4 MB | 28 | 534 | 175 | 1.69 (4.63) |
| Rust (raw `wasm32`) | 0.27 MB | 10 | 83 | 25 | 0.48 (1.39) |

All three pass through the same host contract. No guest pulled
language-specific code into Core: the host adapters are separate subpaths,
and the kernel closure (below) is identical whichever guest runs.

### Payload per consumer profile

| Profile | Modules | Raw bytes | gzip, per module | gzip, bundled |
| --- | --- | --- | --- | --- |
| `minimal-consumer` — package root, as `examples/minimal` imports it | 13 | 112,707 | 24,532 | 21,893 |
| `kernel-only` — the `./kernel` subpath | 6 | 83,090 | 16,388 | 15,358 |
| `kernel-with-handles` | 7 | 85,774 | 17,521 | 16,387 |
| `kernel-with-dotnet-host` | 7 | 85,642 | 17,457 | 16,115 |
| `kernel-with-raw-host` | 8 | 88,750 | 18,676 | 16,981 |

These are the 2026-09-29 measurements. The current budgets, and why each
changed, are in [`bench/budgets.json`](../bench/budgets.json) (`history`):
- the binding security policy (#18) re-baselined every kernel profile by about
  2.1 KB gzip;
- the Core HTTP profile (protocol 1.3, #47) added about 1.7 KB gzip more;
- each optional capability pack has its own `kernel-with-<pack>` profile.

`test/bench-size.test.ts` proves that no module under `capability-support/`,
`capabilities/`, `tooling/` or `hosts/` is in the minimal consumer. Optional
code loads only when a consumer imports it; the layer rules in
[`architecture/layers.json`](../architecture/layers.json) keep Core from
importing it.

## What the evidence says

**Not bottlenecks.** A semantic event round trip costs about 10µs, a route
change 0.13ms, a federation exchange 5µs, and starting the kernel 1.5ms. The
boundary's shape — narrow, serializable, one message per interaction — is not
where the time goes. Nothing here justifies a binary codec, shared memory or
a delta protocol.

**Candidate bottlenecks.** Each is split into its own work item. None was
acted on here.

1. **Unchanged bindings are rewritten** (WI-0043). Every projection writes
   every `data-text`, whether or not its value changed. An unchanged 10k list
   costs 10,000 DOM mutations and 22.8ms, and 100 unchanged form fields cost
   100 mutations. Writing only changed values is a kernel-mechanism change
   with no protocol impact. It is the largest DOM-side cost measured.
   *Done in WI-0043:* the kernel compares each `data-text` and each plain or
   URL attribute with the live DOM before writing. Measured on 2026-09-29, on
   this machine:

   | Case | Before | After |
   | --- | --- | --- |
   | list-10k no-op, DOM mutations | 10,000 | 0 |
   | list-10k no-op, time | 32.9 ms | 12.0 ms |
   | list-10k one-row update, DOM mutations | 10,000 | 1 |
   | list-10k removal, DOM mutations | 20,001 | 10,001 |

   The removal figure is halved; WI-0044 (item 2) removes the rest. A node
   changed outside the kernel is still corrected, because the comparison is
   with the DOM, not a cache (`test/kernel.test.ts`).
2. **Removing a keyed row moves every row after it** (WI-0044). A middle
   removal costs twice the mutations of a middle insertion. The stale row
   leaves only after the reorder pass, so each following row fails the
   `nextSibling` check and is re-inserted.
   *Done in WI-0044:* rows whose keys left the list are removed before the
   reorder pass. A middle removal is now one DOM mutation: on list-10k it
   went from 10,001 mutations to 1, and from 26.2 ms to 11.4 ms. Every
   surviving row keeps its node, and no other row moves
   (`test/kernel.test.ts`).
3. **Strict decoding dominates the boundary cost** (WI-0045). Decoding a
   10k-row view takes 17.1ms, ten times `JSON.parse`, and roughly doubles the
   unchanged-list cost at the JSON boundary. The fix is decoder throughput
   (allocation and path bookkeeping), never weaker strictness.
4. **The F# guest is five times the C# guest** (WI-0046). The F# guest is
   26 MB and 188 requests, against 5.4 MB and 28, because FSharp.Core is not
   trim-clean and the F# host publishes untrimmed (see
   [DOCUMENTATION-AUDIT](DOCUMENTATION-AUDIT.md) and the guest notes in
   [24](24-contract-and-capabilities.md)). That is 1.6s to a cold handshake,
   against 0.5s. Suppressing the trim warnings is forbidden, so the fix is a
   trim-clean path.
5. **The minimal consumer loads code it never runs** (WI-0047). Importing
   the package root loads the reference email engine and federation, 30 KB
   raw and 6.5 KB gzipped. The kernel also loads the whole 47.5 KB generated
   core codec to decode one handshake. A bundler would tree-shake both;
   unbundled ES modules, as `examples/minimal` ships, cannot. *Resolved for
   the root by kemiller2002/limen#61:* the
   root no longer loads the reference engine or federation (the
   `minimal-consumer` profile in `bench/budgets.json` forbids both); the
   codec cost remains.

**Virtualization (#37) is not warranted by this evidence.** A one-row update
of 10,000 rows makes 10,000 mutations, the same as an unchanged
re-projection. The cost is the rewriting of unchanged values (item 1) plus
decoding (item 3), not the size of the list. The decision, and the
re-measurement that would reopen it, are recorded in
[DF-LIMEN-2026-0004](../research/decisions/DF-LIMEN-2026-0004--virtualization-evidence-gate.md).
No runtime change was made.

## Budgets

Size budgets are the measured baseline plus 10%, rounded up to a whole KiB.
Raising one needs its own work item saying what grew and why. Lowering one
after an optimization is encouraged.

Timing budgets are relative, not absolute: `--compare` flags any median more
than `--tolerance` times (default 2) its baseline value. Use it on the same
machine as the baseline.
