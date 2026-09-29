# Core boundary v1: verification record

The hard Core boundary of kemiller2002/limen#59, as built by #60–#63. This
record maps each acceptance criterion and negative test to the check that
enforces it, so a successor can verify the boundary without the conversation
that built it.

**Status:** every criterion is enforced in `npm test` and CI. One decision
belongs to the repository owner and is open: whether to ratify the Core
growth that predates the freeze (`architecture/core-admissions/CA-0001.json`,
outcome `pending`). Until then, `npm run check:core-budget` prints a NOTICE
and freezes Core where it stands.

## Where the boundary lives

| What | File | Enforced by |
| --- | --- | --- |
| Core manifest: version, files, entrypoints, export families, primitives, families, limits, concepts, learning path | `architecture/core.json` | `npm run check:architecture` (`tools/guardrails/core.ts`) |
| Layers, and which are Core | `architecture/layers.json` | `check:architecture`, `check:layers` |
| Complexity baseline: the #59 reference and the approved freeze point | `architecture/core-baseline.json` | `npm run check:core-budget` (`tools/guardrails/core-metrics.ts`); CI's `--verify-reference` |
| Core Admission records | `architecture/core-admissions/` | `check:core-budget` (`tools/guardrails/admission.ts`) |
| The canonical Core model and learning path | `docs/core-mental-model.md`, `AGENTS.md` | `npm run check:docs` (`tools/guardrails/learning.ts`) |
| Who may change any of the above | `architecture/guardrails.json`, `.github/CODEOWNERS` | `npm run check:scope` |

## Acceptance criteria

| #59 criterion | Evidence |
| --- | --- |
| Core has a machine-readable membership manifest | `architecture/core.json`; `test/core-boundary.test.ts` "the manifest records the frozen v1 boundary" |
| CI rejects Core → optional imports | rule `core-imports-optional`; `test/core-boundary.test.ts` (federation, pack, reference engine, host, renderer, tooling) |
| CI rejects optional modules in a minimal Core bundle or import graph | rule `optional-in-minimal-graph` (sources); `scripts/check-package.ts` §4 (packed `dist/`); `test/root-surface.test.ts` |
| No new built-in capability family through ordinary feature work | rule `capability-family-added`; hard gate in `check:core-budget`; the manifest and contract targets are guardrail-owned |
| Zero runtime dependencies mechanically checked | rule `runtime-dependency`; hard gate in `check:core-budget` |
| Six binding primitives recorded and regression-checked | `bindingPrimitives` in the manifest; rules `binding-primitive-undeclared` and `-limit`; hard gate |
| Four built-in capability families recorded and regression-checked | `capabilityFamilies` in the manifest; the contract's `EffectRequest` and `Capability` enum compared on every run |
| Core size, export and concept metrics recorded on every verification run | `check:core-budget` runs in `npm test` and prints the reference / approved / current table |
| More than 10% Core growth requires a Core Admission work item | review triggers in `judge()`; `test/core-budget.test.ts`; `docs/core-admission.md` |
| The root API no longer teaches federation or the reference engine as Core | `src/index.ts`; rule `root-export-unapproved`; `test/root-surface.test.ts` |
| Federation available through an explicit optional import | `./federation`; the manifest's optional entrypoints (rule `entrypoint-mismatch`); `test/root-surface.test.ts` |
| Reference engine available through an explicit reference import | `./reference-engine` (`src/engine/index.ts`); `test/root-surface.test.ts` |
| Minimal F#, C# and Rust consumers prove the same Core contract without optional subsystems | `test/guest-minimal-core.test.ts` (graph = Core + WASM host adapters; no pack; no Capability request); `npm run smoke:guests` |
| One stable Core mental model; optional docs are local | `docs/core-mental-model.md`; `test/learning-contract.test.ts`; 31 optional docs carry the "Optional — not Limen Core" banner |
| #16 extensions add zero capability-specific semantics to Core | Core files name no pack; rule `core-imports-optional`; `private-core-import` |
| Existing public compatibility has a migration plan | `docs/18-naming-and-compatibility.md#root-entrypoint-core-only`; CHANGELOG "Breaking" |
| Checks cannot be weakened by the feature work they constrain | every file above is guardrail-owned; `test/core-budget.test.ts` and `test/core-admission.test.ts` prove a feature item touching them is a `guardrail-modification` |

## Negative tests

| #59 negative test | Where it fails |
| --- | --- |
| A fifth built-in capability added to BrowserKernel | `test/core-boundary.test.ts` "a fifth built-in capability family fails"; `test/core-budget.test.ts` |
| Federation imported from Core | `test/core-boundary.test.ts` "Core importing federation fails…" |
| A capability pack imported from Core | `test/core-boundary.test.ts` "Core importing an optional capability pack fails" |
| A seventh binding primitive without Core Admission | `test/core-boundary.test.ts` "a seventh binding primitive fails…"; `test/core-budget.test.ts` |
| A runtime dependency added | `test/core-boundary.test.ts`; `test/core-budget.test.ts` |
| The root import transitively loads federation | `test/core-boundary.test.ts` "the root exporting federation or the reference engine fails"; `check:package` |
| The root import transitively loads the reference engine | same |
| A Core budget threshold exceeded without admission | `test/core-budget.test.ts` review-trigger tests |
| Ordinary feature work edits the budget or guardrail to pass | `test/core-budget.test.ts` "a feature work item cannot move the baseline…"; `test/core-admission.test.ts` |

## Numbers at the freeze

From `npm run check:core-budget`:

- **Reference 9a835cc:** 3 handwritten files, 675 raw lines, 435 code lines,
  emitted gzip 7112 bytes.
- **Approved freeze:** 7 handwritten files, 1341 raw lines, 922 code lines,
  plus 1031 generated lines; emitted gzip 23540 bytes.
- **Unchanged dimensions:** 59 root exports, 6 binding primitives, 4
  families, 0 dependencies, 7 concepts.

The #59 review's 678 lines counted one extra per file. The growth between the
reference and the freeze is CA-0001.

## Resuming

Run `npm test`. Every gate above is in it, except these:

- `npm run check:scope`, which needs `origin/main`;
- `npm run check:core-budget -- --verify-reference`, which needs Git history;
- the browser smokes.

To grow Core, follow `docs/core-admission.md`. To ship an optional
capability, follow the decision order in `docs/where-code-goes.md`. Neither
touches this record.
