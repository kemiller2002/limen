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
| `unclassified-path` / `ambiguous-path` | a file under `src/` matches no layer, or more than one, in `architecture/layers.json` | place it under a declared layer (see [where code goes](where-code-goes.md)); a new layer is a guardrail item |
| `core-file-undeclared` | a new file appears in a Core layer (`core-contract`, `core-kernel`) that [`architecture/core.json`](../architecture/core.json) does not list | put it in an optional layer; Core grows only through Core Admission |
| `core-imports-optional` | a Core file imports any non-Core layer: federation, reference engine, capability pack or support, host, renderer, tooling, facade | invert it: the optional layer imports a public Core extension point, composed at the host root |
| `private-core-import` | an optional layer imports a Core file the manifest marks `private` | depend only on `public` Core files |
| `binding-primitive-undeclared` / `binding-primitive-limit` | Core reads a `data-*` attribute that is not one of the six primitives (or the `data-key` modifier), or the manifest lists a seventh | an existing primitive, a projected value, or an optional capability |
| `capability-family-added` / `capability-family-limit` | the contract's `EffectRequest` or `Capability` enum gains a fifth built-in family | an optional capability pack through the `Capability` seam |
| `runtime-dependency` | `package.json` declares any `dependencies`, `peerDependencies`, `optionalDependencies` or bundled dependency | implement it in-repo; devDependencies are fine |
| `root-export-unapproved` | `src/index.ts` exports a name in no approved export family of the Core manifest | export it from its own optional subpath |
| `concept-limit` | the manifest lists an eighth canonical Core concept | compose beneath the seven; Core Admission otherwise |
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
| `any-type` | `any` in handwritten boundary TypeScript | `unknown`, narrowed; or the generated type |
| `suppression-directive` | `@ts-ignore`, `@ts-nocheck`, or `@ts-expect-error` outside `test/fixtures/negative/typescript/allowed/` | fix the type error |
| `double-assertion` | `x as unknown as T` | decode with the generated decoder, or narrow with a guard |
| `assertion-bypasses-decoder` | `JSON.parse(…) as T` | `decodeX(JSON.parse(…) as unknown)` from `./contract` |
| `duplicate-protocol-type` | a handwritten type named like a contract type | import the generated one |
| `browser-object-in-message` | a `defineCapability` result or fact type reaches a `lib.dom` type (`Element`, `File`, …) | serialized value or opaque handle id |
| `untyped-capability-dispatch` / `dynamic-dispatch` | `operation: string`, `payload: unknown`, or calling `handlers[name]` directly | a closed generated union, switched exhaustively |
| `non-exhaustive-union` | a `switch` over a literal union misses a variant, or its `default` does not hand the value to a `never` parameter | cover every case, or `default: return assertNever(value)` |
| `script-execution` / `html-injection-sink` | `eval`, `Function`, string timers, `innerHTML`, `insertAdjacentHTML`, `document.write`, `srcdoc` | data the engine projects; `textContent`; an effect |
| generated `stale` / `hand-edited` / `orphan` | see [docs/24](24-contract-and-capabilities.md) | change the contract, regenerate |
| `test/guardrails.test.ts` | a required gate left `npm test` or CI, or a strictness setting was weakened | restore it |

The TypeScript rules apply to the files listed in
[`architecture/typescript-boundary.json`](../architecture/typescript-boundary.json)
(Core, capability packs, the reference engine, the site's WASM transports),
excluding registered contract-gen outputs — pasting the generated marker into
a handwritten file exempts nothing. The same file holds the one sanctioned
exception (the generic capability seam) and a **ratchet** of pre-existing debt:
exact counts tied to the work item that removes them. A new finding fails; a
count that drops fails until the entry is lowered. Debt only shrinks.

## The Core complexity budget

`npm run check:core-budget` (part of `npm test`) measures Limen Core and
compares it with the approved baseline in
[`architecture/core-baseline.json`](../architecture/core-baseline.json). The
report is deterministic (`-- --report` prints it as JSON): handwritten Core
files, lines and bytes; generated Core separately; emitted Core bytes and
gzip; root exports by family; protocol variants; binding primitives;
built-in capability families; runtime dependencies; canonical concepts;
each Core entrypoint's module graph; which optional groups exist and
whether any is in that graph; and the minimal consumer's payload (the same
measure as `bench/budgets.json`).

| Kind | Fails when |
| --- | --- |
| hard gate | a runtime dependency; a seventh binding primitive; a fifth built-in capability family; an eighth concept; an optional module in the minimal graph; Core importing an optional layer; a root export outside every approved family; a new root export family |
| review trigger | more than 10% over the approved baseline in handwritten Core lines, handwritten normalized bytes (comments and whitespace removed, so reformatting cannot game it), emitted Core gzip or normalized bytes, or root exports |

Shrinking lines offsets nothing: each hard gate is judged on its own.
Optional layers, tests, docs and examples are not Core and are not measured
as Core. A breach is a review gate, not proof the change is wrong: it needs a
Core Admission, after which that admission's guardrail work item raises the
approved baseline. The baseline also records the #59 reference commit,
measured from Git; CI re-measures it with `-- --verify-reference`, so it
cannot drift from what that commit contained.

## What is guardrail-owned

[`architecture/guardrails.json`](../architecture/guardrails.json) is the list:
the layer map, the Core manifest (`architecture/core.json`) and budget baseline (`architecture/core-baseline.json`), the guardrail registry itself, `tools/guardrails/**`,
`tools/contract-gen/**`, `scripts/check-*.ts`, CI workflows, `CODEOWNERS`,
`tsconfig*.json`, `contract/targets.json`, guest project files and strictness
attributes, and the guardrail tests. The same paths are in
[`.github/CODEOWNERS`](../.github/CODEOWNERS).

## Commands

```sh
npm run check:architecture # the Core manifest: paths, imports, primitives, families, dependencies, root exports
npm run check:core-budget # the Core complexity budget (part of npm test)
npm run check:layers    # dependency directions (part of npm test)
npm run check:typescript # restricted handwritten TypeScript (part of npm test)
npm run check:scope     # this branch's commits against their scopes (needs origin/main fetched)
npm run contract:check  # generated bindings current (part of npm test)
```

## What these checks cannot do

A manifest that declares `"guardrail": true` is a *claim*. The checks make it
explicit and visible in review; they cannot make it true. Code-owner review is
the human boundary — and it is binding only when branch protection requires it,
which is a repository setting outside this codebase.
