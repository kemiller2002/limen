# Naming and compatibility

**What this answers:** what "Limen" names, what it does *not* rename, and why
nothing you depend on broke.

---

## The short version

**Limen is the product name** for the architecture this repository implements:
an explicit boundary that keeps browser capabilities separate from application
authority.

**No published identifier changed.** The npm package, every exported symbol,
every file path, and the wire protocol are exactly what they were. If you
depend on this package, Limen is a new name for something you already have —
there is nothing to migrate.

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
| **Published package name** | `@echelon-foundry/typescript-wasm-kernel` | 17 | **PRESERVED** — renaming breaks every consumer |
| **Public API symbol** | `BrowserKernel`, `EngineTransport`, `DirectTypeScriptTransport`, `ReferenceEngine`, `PROTOCOL_VERSION` | 26 | **PRESERVED** |
| **Wire contract** | `SemanticEvent`, `ViewState`, `EffectRequest`, `EffectResult`, the six `data-*` attributes | all | **PRESERVED** |
| **Filesystem path** | `src/kernel/`, `src/kernel/browser-kernel.ts`, `test/kernel.test.ts` | 3 | **PRESERVED** — renaming churns imports and `dist/` output paths for no functional gain |
| **Component term** | "the kernel" meaning the browser bridge | many | **KEPT** — accurate; clarified to "the Limen kernel" where ambiguous |
| **Product name** | "TypeScript WASM Kernel", "the WASM kernel" as a product | many | **RENAMED → Limen** |
| **Repository name** | `typescript-wasm-kernel` | 1 | **PRESERVED** — see open items below |
| **Historical / research** | `prompts/`, ROS and research artifacts | all | **PRESERVED** — historical records are not retroactively edited |

---

## What this means for you

### If you consume the package

Nothing to do.

```jsonc
// still correct, unchanged
"@echelon-foundry/typescript-wasm-kernel": "^0.4.1"
```

```ts
// still correct, unchanged
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
```

No deprecation, no alias, no shim, no codemod. The rename is documentation-only.

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

## Open items, not decisions

These are deliberately unresolved. They are recorded rather than guessed at.

| Item | Why it is open |
| --- | --- |
| **Renaming the npm package to `@echelon-foundry/limen`** | Breaking for every consumer. Would need a deprecation of the old name, a transition period publishing both, and a migration note. Not attempted as part of a naming pass. |
| **Renaming the GitHub repository** | Would change clone URLs and the `repository` field. GitHub redirects, but it is still a visible break. A maintainer decision. |
| **Renaming `src/kernel/` → `src/limen/`** | Pure churn: it changes every import and every `dist/` path a consumer might deep-link, and `kernel` remains the accurate name for that component. Recommended against. |

If the package is ever renamed, the safe sequence is: publish under the new
name, re-publish the old name as a thin re-export that depends on the new one,
mark the old one deprecated with a message pointing at the new one, and keep
both alive for at least one major version.

---

## Related

- [01-architecture.md](01-architecture.md) — what Limen actually is
- [17-wasm-migration.md](17-wasm-migration.md) — why "WASM" was a misleading name
- [glossary.md](glossary.md) — canonical terms
- [11-api-reference.md](11-api-reference.md) — the preserved public surface
