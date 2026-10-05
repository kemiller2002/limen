# Naming and compatibility

**What this answers:** what "Limen" names, what it does *not* rename, and the
one distribution change a consumer makes: from 0.7.0 the npm package is
`@echelon-foundry/limen`.

---

## The short version

**Limen is the product name** for the architecture this repository implements:
an explicit boundary that keeps browser capabilities separate from application
authority.

**No API identifier changed.** Every exported symbol, every file path, every
subpath export, the CLI and the wire protocol are exactly what they were.
The GitHub repository was renamed to `kemiller2002/limen` (GitHub redirects
the previous URL), and from **0.7.0** the npm package is published as
**`@echelon-foundry/limen`** instead of `@echelon-foundry/typescript-wasm-kernel`.
Consumers change the dependency name and import specifiers — nothing else
([package rename](#package-rename-070)).

---

## Limen means the boundary

*Limen* (Latin): a threshold — the stone at the base of a doorway.

That is the concept precisely. Limen is not a framework, a renderer, or a
runtime you write code *inside*. It is the threshold your application stands
behind: browser capabilities on one side, application authority on the other,
with a narrow, serializable contract between them.

The name describes what the thing *is*, which the previous names did not.
"TypeScript WASM kernel" named an implementation detail (TypeScript), a
technology the repository does not contain (WASM — see
[17-wasm-migration.md](17-wasm-migration.md)), and an overloaded word (kernel).

---

## "Kernel" still means something specific — and it did not change

This is the part most likely to confuse, so it gets stated directly.

| Term | Means | Status |
| --- | --- | --- |
| **Limen** | the whole architecture: boundary + contract + bridge | new product name |
| **the kernel** | the browser-side bridge component, `BrowserKernel` in `src/kernel/` | **unchanged** — still correct |
| **the engine** | the application side that owns state and decisions | unchanged |

So "the kernel binds `data-*` attributes" is still accurate and still the right
sentence. `BrowserKernel` was never a bad name for what it is — a small
mechanism layer. What was wrong was using *kernel* for the whole product, and
simultaneously using it for the application side in some diagrams.

Where the distinction matters, the docs now say **"the Limen kernel"** for the
bridge and **"Limen"** for the architecture.

---

## Classification of every occurrence

Per the productization rules, each occurrence of the old terminology was
classified before anything was renamed. Nothing was find-and-replaced.

| Class | Examples | Count | Action |
| --- | --- | --- | --- |
| **Published package name** | `@echelon-foundry/typescript-wasm-kernel` | 17 | **PRESERVED** by the naming pass; later **RENAMED → `@echelon-foundry/limen` in 0.7.0** ([package rename](#package-rename-070)) |
| **Public API symbol** | `BrowserKernel`, `EngineTransport`, `DirectTypeScriptTransport`, `ReferenceEngine`, `PROTOCOL_VERSION` | 26 | **PRESERVED** |
| **Wire contract** | `SemanticEvent`, `ViewState`, `EffectRequest`, `EffectResult`, the six `data-*` attributes | all | **PRESERVED** |
| **Filesystem path** | `src/kernel/`, `src/kernel/browser-kernel.ts`, `test/kernel.test.ts` | 3 | **PRESERVED** — renaming churns imports and `dist/` output paths for no functional gain |
| **Component term** | "the kernel" meaning the browser bridge | many | **KEPT** — accurate; clarified to "the Limen kernel" where ambiguous |
| **Product name** | "TypeScript WASM Kernel", "the WASM kernel" as a product | many | **RENAMED → Limen** |
| **Repository name** | `typescript-wasm-kernel` → `limen` | 1 | **RENAMED** — GitHub repository identity now matches the product |
| **Historical / research** | `prompts/`, ROS and research artifacts | all | **PRESERVED** — historical records are not retroactively edited |

---

## What this means for you

### If you consume the package

From 0.7.0, change the package name — nothing else:

```jsonc
// before (0.6.2 and earlier)
"@echelon-foundry/typescript-wasm-kernel": "^0.6.2"
// from 0.7.0
"@echelon-foundry/limen": "^0.7.0"
```

```ts
// every subpath is the same; only the package name changes
import { BrowserKernel } from "@echelon-foundry/limen";
```

The repository rename changed the canonical GitHub URL only. The package
rename is described [below](#package-rename-070).

### Root entrypoint: Core only

The rename changed nothing in the API. A later, separate change did:
kemiller2002/limen#61 made the package root
export **Limen Core only**, so that importing Limen never loads, or teaches,
an optional system. Federation and the TypeScript reference engine are still
supported and unchanged; they moved to the explicit subpaths that already
existed.

| Name | Before (root) | Now |
| --- | --- | --- |
| `ModuleFederation`, `createLazyFederation`, `routeMatches`, `FederationError`, `FEDERATION_PROTOCOL_VERSION`, `noopFederationDiagnostics` and every federation type | `…limen` | `…limen/federation` |
| `ReferenceEngine`, `project`, `DirectTypeScriptTransport`, `State`, `Command`, `EmailAddress`, `TransitionError`, `TransitionResult` | `…limen` | `…limen/reference-engine` |
| everything else | `…limen` | unchanged |

```ts
// before: BrowserKernel, ModuleFederation and DirectTypeScriptTransport all
// came from the package root. Now:
import { BrowserKernel } from "@echelon-foundry/limen";
import { ModuleFederation } from "@echelon-foundry/limen/federation";
import { DirectTypeScriptTransport } from "@echelon-foundry/limen/reference-engine";
```

**Compatibility decision.** This is a breaking change to the root's export
list, released in the next minor version (the package is `0.x`, where a minor
may break). There is deliberately **no deprecation shim on the root**: any
re-export there would put federation and the reference engine back into
every minimal consumer's import graph, which is the thing being removed. The
subpaths themselves are not new — `./federation` is unchanged, and
`./reference-engine` now exports a superset of what it did (it previously
exposed only `DirectTypeScriptTransport`). `npm run check:architecture` and
`npm run check:package` fail if an optional export returns to the root.

### If you write about it

| Prefer | Over |
| --- | --- |
| Limen | "the WASM kernel", "the TypeScript WASM kernel" |
| the Limen kernel | "the kernel" where the bridge vs. product is ambiguous |
| the engine | "the WASM", "the WASM side", "the application layer" |

### If you are an AI agent

Read [AGENTS.md](../AGENTS.md). The architectural rules did not change — only
the name for the whole. In particular: `src/kernel/**` still means the browser
bridge, and it is still the only place allowed to touch `document`, `window`,
`fetch`, or `localStorage`.

---

## Repository rename decision

On 2026-09-23 the GitHub repository was renamed from
`kemiller2002/typescript-wasm-kernel` to `kemiller2002/limen`. Repository
metadata, Pages links, documentation links, Praxis/ROS current identity, and
validation checks now use `limen`. Historical events and telemetry remain
unchanged because they record the identity that existed when they were emitted.

The legacy `typescript-wasm-kernel` CLI executable remains a compatibility
surface. The npm package was renamed separately, in 0.7.0 (next section).

---

## Package rename (0.7.0)

From **0.7.0** the package is published as **`@echelon-foundry/limen`**. The
owner decided the rename before 0.7.0 was first published, so 0.7.0 is the
first version under the new name and the last one under the old name is
**0.6.2**. `@echelon-foundry/typescript-wasm-kernel` is deprecated on npm with
a message pointing at the new name; it is not re-published as a re-export.

What changed and what did not:

| Surface | 0.6.2 and earlier | 0.7.0 on |
| --- | --- | --- |
| npm package | `@echelon-foundry/typescript-wasm-kernel` | `@echelon-foundry/limen` |
| Subpath exports, exported symbols, protocol and contract identities | — | unchanged |
| CLI executable | `limen` (and `typescript-wasm-kernel`) | unchanged |
| Installed workflow | `npx --yes @echelon-foundry/typescript-wasm-kernel verify --strict` | `npx --yes "@echelon-foundry/limen@<installedVersion>" verify --strict` |
| `.echelon/limen.json` `package` | `@echelon-foundry/typescript-wasm-kernel` | `@echelon-foundry/limen` |

A repository with the lifecycle CLI installed moves with one command:

```sh
npx --yes @echelon-foundry/limen@0.7.0 upgrade
```

`upgrade` rewrites an unedited `.github/workflows/limen-verify.yml` to the
pinned new name and records the new package name in `.echelon/limen.json`. An
edited workflow stops the upgrade and nothing is written — see
[20-lifecycle-cli.md § Migrating to 0.7](20-lifecycle-cli.md#migrating-to-07).

---

## Open items, not decisions

The repository and package renames are now resolved. The remaining item is
deliberately unresolved and is recorded rather than guessed at.

| Item | Why it is open |
| --- | --- |
| **Renaming `src/kernel/` → `src/limen/`** | Pure churn: it changes every import and every `dist/` path a consumer might deep-link, and `kernel` remains the accurate name for that component. Recommended against. |


---

## Related

- [01-architecture.md](01-architecture.md) — what Limen actually is
- [17-wasm-migration.md](17-wasm-migration.md) — why "WASM" was a misleading name
- [glossary.md](glossary.md) — canonical terms
- [11-api-reference.md](11-api-reference.md) — the preserved public surface
