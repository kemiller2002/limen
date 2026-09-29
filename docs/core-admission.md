# Core Admission

How anything enters or enlarges Limen Core (kemiller2002/limen#59, #63). The
rule it enforces:

> **Limen may grow in capability reach without growing the mandatory Core
> mental model.**

Core is the seven concepts of the [Core mental model](core-mental-model.md),
and exactly the files, root export families, binding primitives, built-in
capability families and dependencies listed in
[`architecture/core.json`](../architecture/core.json). Everything else is
optional, and ships as an optional surface without asking anyone.

## When an admission is required

A work item needs an approved Core Admission record before it may:

- add a canonical concept;
- add a root export family, or export an optional name from the root;
- add a binding primitive (a seventh);
- add a built-in capability family (a fifth);
- add a runtime dependency;
- add a Core file, or make a private Core file public;
- grow Core by more than 10% over the approved baseline in handwritten
  lines, handwritten normalized bytes, emitted bytes or root exports
  (`npm run check:core-budget`).

The checks fail on each of these until the manifest or the baseline changes,
and both are guardrail-owned: only a guardrail work item can change them, and
it must cite the admission.

## Where does it go instead? The decision order

Ask in this order; stop at the first that can hold it. Core Admission is the
last resort, not a shortcut.

1. **Engine** — state, meaning, rules, decisions.
2. **HTML** — structure, native elements and attributes.
3. **CSS** — presentation.
4. **Engine library** — reusable engine-side logic (routing, forms, resources),
   in any guest language, with no host authority.
5. **Optional capability pack** — a browser capability behind the generic
   `Capability` seam, with its own contract unit.
6. **Governed adapter** — a third-party widget or rendering surface, with no
   application authority.
7. **Optional host or renderer** — where the engine runs, or how a page is
   rendered (workers, SSR, fallback).
8. **Tooling or conformance** — tests, traces, checks, the CLI.
9. **Core Admission** — only when none of the above can hold it.

(Forma, the interaction and presentation primitives maintained outside this
repository, is also asked before admission: see field 6.)

## The record

One JSON file per proposal, `architecture/core-admissions/CA-####.json`,
written by a guardrail work item. Start from
[`TEMPLATE.json`](../architecture/core-admissions/TEMPLATE.json). Every field
is required and must say something; "n/a" is allowed only with a reason.

| # | Field | What it must answer |
| --- | --- | --- |
| 1 | `proposedAddition` | Exactly what enters Core: the concept, export, file, primitive, family, dependency or budget growth. |
| 2 | `invariantOrUseCase` | The universal invariant or use case it serves — why every ordinary application needs it. |
| 3 | `whyNotHtmlCss` | Why native HTML, CSS or browser behavior cannot satisfy it. |
| 4 | `whyNotEngineLibrary` | Why an engine library cannot. |
| 5 | `whyNotCapabilityPack` | Why an optional capability pack cannot. |
| 6 | `whyNotForma` | Why Forma cannot. |
| 7 | `whyNotGovernedAdapter` | Why a governed adapter cannot. |
| 8 | `whyNotTooling` | Why tooling or conformance cannot. |
| 9 | `whyNotHostRenderer` | Why an optional host or renderer cannot. |
| 10 | `consumerEvidence` | Independent real consumers that need it: a list of `{ consumer, evidence }`. A new concept, root export family, binding primitive or capability family needs **at least two**; a correctness or security fix to an existing Core mechanism does not. |
| 11 | `complexityDelta` | The change on every dimension of the Core report. |
| 12 | `compatibilityImpact` | What breaks, what migrates, and how. |
| 13 | `negativeBoundaryTests` | The tests proving optional layers still cannot leak into Core. |
| 14 | `guestLanguageImpact` | Impact on F#, C# and Rust engines and their bindings. |
| 15 | `decision` | `{ outcome, by, date, evidence }`: `approved`, `rejected` or `pending`. |

Plus `id`, `title`, `workItem` (a guardrail work item) and `kind`: one of
`new-concept`, `new-root-export-family`, `new-binding-primitive`,
`new-capability-family`, `runtime-dependency`, `core-file`, `budget-growth`,
`correctness-or-security-fix`.

## Who decides

Feature work cannot approve its own admission, and cannot change the
mechanism:

- the records, the manifest, the baseline and the checks are guardrail-owned
  (`architecture/guardrails.json`), so a feature work item that touches them
  fails `npm run check:scope`;
- a record's `workItem` must be a guardrail work item;
- `decision.by` for an approved or rejected record must name a person, not a
  work item, and `decision.evidence` must point at where they decided (an issue
  comment, a review);
- `npm run check:core-budget` validates every record and fails if the approved
  baseline rests on a missing or rejected admission.

A `pending` record changes nothing by itself. It is how a proposal is put to
the owner with its evidence complete.
