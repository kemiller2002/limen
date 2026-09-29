---
identifier: DF-LIMEN-2026-0002
title: Dependency directions and work-item scope are enforced mechanically, per commit
type: decision-record
status: accepted
version: 1.0.0
author_agent: claude-code
created: 2026-09-29
updated: 2026-09-29
related_projects: [limen]
related_documents:
  - architecture/layers.json
  - architecture/guardrails.json
  - docs/25-guardrails.md
supersedes: []
superseded_by: []
tags: [guardrails, governance, architecture, dependency-direction, scope]
work_items: [WI-0034]
external_references: ["kemiller2002/limen#53", "kemiller2002/limen#51"]
---

# DF-LIMEN-2026-0002 — Dependency directions and work-item scope are enforced mechanically, per commit

## Context

#51 requires that an agent working on one capability cannot casually turn
its ticket into a Core redesign, and cannot weaken the checks that block it.
Prompt discipline is not enforcement.

## Decision

1. **Layers are declared data.** [`architecture/layers.json`](../../architecture/layers.json)
   maps paths to layers (core-contract, core-kernel, federation-host,
   reference-engine, package-facade, capability-pack) and says which layers
   each may import. `scripts/check-layers.ts`, part of `npm test`, resolves every
   TypeScript import and rejects:
   - a wrong direction;
   - one capability pack importing another;
   - any external module in the published package;
   - a dynamic import whose target is computed;
   - engine-library code (any language under `libraries/`) that names
     browser, interop, network, filesystem or process APIs;
   - core-contract code that references a browser runtime type.

   The contract generator refuses contract types named after browser runtime
   objects, using the same list.
2. **Scope is declared before mutation, one manifest per work item.**
   `architecture/work-scopes/WI-####.json` records the placement and the
   allowed path globs, plus any expansions. Each expansion needs a written
   reason.
3. **Scope is checked per commit.** `scripts/check-scope.ts` runs in its own
   CI job with full history. Every commit that changes a meaningful path must
   be attributed to exactly one work item, through a parenthesized subject
   group or a `Work-Item:` trailer. The item's manifest must have been
   committed no later than that change, and every path the commit changes must
   be inside the declared scope.
4. **Guardrails are owned.** `architecture/guardrails.json` lists the
   guardrail-owned paths. Changing one requires a manifest that declares
   `"guardrail": true`. `test/guardrails.test.ts` fails if a required gate
   disappears from `npm test` or CI, or if a strictness setting is weakened.
   `.github/CODEOWNERS` requires the owner's review on the same paths.

## Negative knowledge

- **ROS attribution cannot supply per-item scope.** With `ROS_BASE_REF`,
  `work.completed.paths` is the cumulative `base...HEAD` diff. For example,
  WI-0033's completion event lists `.gitignore` and earlier items'
  telemetry. It records that the branch was attributed; it does not record
  which item changed which file. The check therefore reads git, and ROS stays
  the authority for work-item identity and lifecycle.
- **Any mention of a WI id is not attribution.** One commit message on this
  branch mentions WI-0028 but belongs to WI-0029. The checker flagged it
  under the naive rule, which is why the attribution rule exists.
- **A manifest-only guardrail can be self-authorized.** A feature item could
  declare `"guardrail": true` in its own manifest. The mechanism does not
  pretend to stop that. It makes the claim explicit and diff-visible, and
  CODEOWNERS routes the change to a human. Human authorization is the real
  boundary here, and this decision says so rather than implying otherwise.

## Ordo analysis

- **Requirement:** #53 acceptance criteria.
- **States to keep impossible:**
  - a merged commit changing Core under a capability-scoped item;
  - a guardrail edit under a non-guardrail item;
  - an unattributed meaningful change;
  - a scope declared only after the change it covers.
- **Evidence:** failing fixtures in `test/layers.test.ts` and
  `test/scope.test.ts`, the configuration-integrity checks in
  `test/guardrails.test.ts`, and a passing check of this branch's own
  history.
- **Obligation carried:** Branch protection that requires code-owner review
  is a repository setting. An agent cannot configure it from here, so the
  human owner must enable it for CODEOWNERS to be binding.

## Consequences

- An agent's first commit on a work item is its scope manifest.
- WI-0027, WI-0028, WI-0029 and WI-0033 predate this mechanism. Their
  manifests were recorded afterwards from the scopes each declared in its
  ROS description, with every actual out-of-declaration file family recorded
  as a reasoned expansion. They are listed as legacy in `guardrails.json`,
  and no later item may use that exemption.
