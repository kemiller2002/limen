# Guardrails: what the repository enforces, and how to work inside it

**Audience:** anyone — especially an AI agent — about to change this
repository. These checks run in `npm test` and CI. They exist so the
architecture is harder to violate than to follow. None of them may be relaxed
as part of the work they block.

Decision record: [DF-LIMEN-2026-0002](../research/decisions/DF-LIMEN-2026-0002--dependency-direction-and-work-item-scope.md).

## Before your first edit: declare scope

After `./ros work start WI-####` (see [AGENTS.md](../AGENTS.md)), commit
`architecture/work-scopes/WI-####.json` **first**:

```json
{
  "workItem": "WI-0042",
  "reference": "kemiller2002/limen#23",
  "placement": "Capability Pack",
  "guardrail": false,
  "paths": ["contract/capabilities/focus.contract.json", "src/capabilities/focus/**", "test/focus*.test.ts", "docs/**"],
  "expansions": [],
  "recordedAfterCompletion": false
}
```

Then name the work item in every commit, in a parenthesized group on the
subject line — `feat(focus): provider (GH-23, WI-0042)` — or with a
`Work-Item: WI-0042` trailer. A merely *mentioned* id is not attribution.

If you discover you genuinely need a path outside your scope, add it as an
`expansion` with a reason (at least a sentence) in the same commit. If it is
separate work, capture it with `./ros add` and do it under its own item.

## What fails, and what to do instead

| Rule | Fails when | Do instead |
| --- | --- | --- |
| `layer-direction` | a layer imports one it may not (e.g. `src/kernel/**` → `src/capabilities/**` or `src/engine/**`) | register packs at the composition root with `new BrowserKernel(…, { capabilities })`; keep application code out of Core |
| `capability-pack-cross-import` | `src/capabilities/a/**` imports `src/capabilities/b/**` | compose both in the engine or at the host root |
| `external-dependency` | anything in the published package imports a bare or `node:` module | implement it in-repo; a dependency needs its own justified work item |
| `unresolvable-import` | a computed `import(…)` in a layered file | import a fixed path |
| `engine-library-authority` | code under `libraries/` names browser, JS-interop, network, filesystem or process APIs | request an effect; authority belongs to a provider or host adapter |
| `browser-object-in-protocol` | core-contract code references `File`, `Element`, `Response`, … | serialized values or an opaque handle id, defined in the contract |
| contract `names a browser runtime object` | a contract type is named `File`, `Element`, … | same |
| `unattributed-commit` / `multiple-work-items` | a commit changes meaningful paths with zero or two work items | one commit, one work item |
| `undeclared-scope` / `scope-declared-after-mutation` | no manifest, or it came after the change | commit the manifest first |
| `out-of-scope` | a commit changes a path its manifest does not cover | expansion with a reason, or a separate item |
| `guardrail-modification` | a non-guardrail item touches a guardrail-owned path | stop; record the evidence; change the guardrail under its own `"guardrail": true` item |
| `foreign-scope-edit` | a feature item edits another item's manifest | only your own |
| generated `stale` / `hand-edited` / `orphan` | see [docs/24](24-contract-and-capabilities.md) | change the contract, regenerate |
| `test/guardrails.test.ts` | a required gate left `npm test` or CI, or a strictness setting was weakened | restore it |

## What is guardrail-owned

[`architecture/guardrails.json`](../architecture/guardrails.json) is the list:
the layer map, the guardrail registry itself, `tools/guardrails/**`,
`tools/contract-gen/**`, `scripts/check-*.ts`, CI workflows, `CODEOWNERS`,
`tsconfig*.json`, `contract/targets.json`, guest project files and strictness
attributes, and the guardrail tests. The same paths are in
[`.github/CODEOWNERS`](../.github/CODEOWNERS).

## Commands

```sh
npm run check:layers    # dependency directions (part of npm test)
npm run check:scope     # this branch's commits against their scopes (needs origin/main fetched)
npm run contract:check  # generated bindings current (part of npm test)
```

## What these checks cannot do

A manifest that declares `"guardrail": true` is a *claim*. The checks make it
explicit and visible in review; they cannot make it true. Code-owner review is
the human boundary — and it is binding only when branch protection requires it,
which is a repository setting outside this codebase.
