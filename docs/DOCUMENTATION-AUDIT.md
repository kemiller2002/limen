# Documentation audit

Findings from a full documentation audit and reconstruction of this repository,
conducted 2026-09-14 against commit `43e56ec`.

Findings are classified and left visible. Where something is unresolved, it says
so rather than being quietly fixed or quietly dropped.

**Classification:** `D` documentation · `N` naming · `A` API ergonomics /
architecture ambiguity · `E` missing example · `T` missing test · `P` potential
defect · `B` potential breaking change.

---

## Baseline

| | |
| --- | --- |
| Branch | `claude/wasm-kernel-docs-audit-oyyntv` |
| Starting commit | `43e56ec2d0425e76b4544d11091159aef299c87e` ("Release 0.4.1 with ROS attribution") |
| Package version | `0.4.1` (unchanged by this work) |
| Build at start | ✅ `tsc` clean |
| Tests at start | ✅ **39/39 passing** after `npm install` |
| Tests at start, before `npm install` | ❌ 7/8 files — `Cannot find package 'jsdom'`. Not a code defect; `node_modules` was absent in a fresh clone. |

No baseline tag was created — the repository has no tagging convention for
non-release work, and the starting commit is recorded above.

---

## Severity summary

| ID | Class | Finding | Status |
| --- | --- | --- | --- |
| **A-2** | A | "WASM kernel" contains no WebAssembly | **documented** |
| **A-1** | A | `DirectTypeScriptTransport` is a demo, promoted as an entry point | **documented + JSDoc warning on the class** |
| **P-1** | P | `data-if`/`data-each` fields skip the form pending-field flush | ✅ **FIXED** — insert before binding; regression tests |
| **P-2** | P | `data-if`/`data-each` on a non-`<template>` silently ignored | ✅ **FIXED** — now a reported binding error; found externally (L-2) |
| **P-3** | P | An undecodable response discarded its status code | ✅ **FIXED** — `Failure` now carries `status`; found by building the site |
| **D-9** | D | `dist/main.js` ships and auto-starts the demo on import | ✅ **FIXED** — excluded from the published package |
| N-1 | N | "kernel" and "capability" each carry two meanings | documented |
| N-2 | N | `any`/`dynamic` check is raw-text, matches comments | documented |
| A-3 | A | `architecture.yaml` implies module-scoped `dynamic_types` | pre-existing, noted |
| A-4 | A | Two prompt specs disagree on the protocol shape | pre-existing, documented |
| D-1…D-8 | D | Missing guides, references, and gap documentation | **resolved** |
| E-1 | E | Only one feature and one demo page existed | **resolved** |
| T-1 | T | No verification that examples still work | **resolved** |
| B-1 | B | No breaking-change policy for `0.x` | unresolved |

---

## A — Architecture ambiguity and API ergonomics

### A-2 · The repository is named for a technology it does not contain

**The finding that prompted this audit.** An agent reported not understanding
how the WASM kernel was intended to work.

- The package is `@echelon-foundry/typescript-wasm-kernel`, described as "for
  WebAssembly applications", with keywords `webassembly` and `wasm`.
- A full-text search for `wasm`/`WebAssembly` across `src/`, `test/`,
  `examples/`, and `scripts/` returns **two hits, both comments** labelling test
  sections in `test/kernel.test.ts`.
- There is no `.wasm` file, no loader, no `WebAssembly.instantiate`, no build
  step producing WebAssembly, and no test exercising one.
- The old README mentioned this once, as the sixth bullet in an Architecture
  list: *"`EngineTransport` is the swap point for a future WebAssembly engine."*

An agent that reads the name, searches for the WASM, and finds none has no way
to distinguish "not built yet" from "I am failing to find it". It will either
report confusion or — worse — invent a mental model and proceed.

**Resolved in documentation**, not in code:

- README answers it in the **first section**, before anything else.
- AGENTS.md answers it in its first section, before any instruction.
- [17-wasm-migration.md](17-wasm-migration.md) covers what exists, what does
  not, what a real transport would take, and the open questions.
- Terminology switched to **"the engine"** throughout, with "WASM kernel"
  recorded in the glossary as a discouraged alias.

**Not resolved:** the package name itself. Renaming is a breaking change for
consumers and is not a documentation decision. **Open question for the
maintainer:** rename, or keep the name and treat the docs as the disambiguator?

### A-1 · `DirectTypeScriptTransport` is a demo promoted as an entry point

`DirectTypeScriptTransport` is exported from the package root **and** as the
dedicated subpath `./reference-engine`, and the old README's quickstart showed
it as the code to copy:

```ts
const kernel = new BrowserKernel(new DirectTypeScriptTransport(), document);
await kernel.start();
```

But it constructs `ReferenceEngine`, which is hard-wired to this repository's
email-availability demo. It understands exactly two event names
(`emailChanged`, `checkAvailability`) and throws on anything else, and throws on
any `StorageResult`.

So a developer who installs the package and follows the README verbatim gets a
kernel bound to someone else's demo domain, and the first symptom is
`Unrecognized event: …` at runtime with nothing explaining why.

**Resolved in documentation:** [02-getting-started.md](02-getting-started.md)
teaches writing your own transport and explains why not to use this one;
[11-api-reference.md](11-api-reference.md) marks it **reference-only**;
[13-anti-patterns.md](13-anti-patterns.md) #14 covers the failure mode.

**Not resolved:** the export surface still presents it as a peer of
`BrowserKernel`. **Suggested (not done, needs a decision):** rename the subpath
to `./reference-demo`, or add a runtime warning. Both are API changes.

### A-3 · `architecture.yaml` implies enforcement it does not have

`dynamic_types.allowed_modules: [kernel]` reads as module-scoped, but
`check-architecture.ts` applies a blanket ban on the words `any`/`dynamic`
across all of `src/engine/**` and checks nothing in `src/kernel/**`.

To the repository's credit this is **already self-documented** in the file's own
header comment. Noted here because the mismatch persists and the header is easy
to miss. Pre-existing; not changed.

### A-4 · Two prompt specifications disagree on the protocol

`prompts/minimal-typescript-browser-kernel-responsibility-spec.md` §36 specifies
an imperative `ViewChange[]`/element-id protocol. The zero-authoritative spec
and the implementation use declarative `ViewState` + `data-*` binding.

Pre-existing, deliberately documented rather than silently resolved, in
`docs/ROADMAP.md` and `CLAUDE.md`. The implementation follows the declarative
model. No action.

---

## P — Defects

### P-1 · Conditionally-mounted form fields skip the pending-field flush

✅ **FIXED.** `#applyIf` and `#applyEach` now insert the cloned root into the
document *before* binding it, so `el.form` resolves and the pending-field flush
registers. A companion fix prunes flush callbacks whose element has since been
unmounted, so repeatedly toggling a conditional section no longer accumulates
stale callbacks. Covered by three regression tests in `test/kernel.test.ts`
(`data-if` flush, `data-each` flush, and the unmount-pruning case); the former
`todo` marker is gone.

Original report follows.

**Confirmed by reproduction.**

**Behavior.** `BrowserKernel` flushes pending `change`-bound fields inside a
`<form>` before dispatching the form's own submit event, so a field edited
without blurring still reaches the engine. A field mounted by `data-if` or
`data-each` **does not participate**.

**Reproduction** (both run under jsdom via the existing harness):

| Markup | Dispatched on submit |
| --- | --- |
| `<form data-event="submit"><input data-event="aChanged"></form>` | `["aChanged", "submit"]` ✅ |
| `<form data-event="submit"><template data-if="show"><input data-event="bChanged"></template></form>` | `["submit"]` ❌ |

**Cause.** `#applyIf` and `#applyEach` call `#bindElement` on the cloned root
*before* inserting it into the document:

```ts
const scope = emptyScope();
this.#bindElement(root, scope, binding.itemKey);   // ← still detached here
binding.anchor.after(root);                        // ← inserted after binding
```

`#bindEvent` reads `el.form` to register the flush callback. On a detached
element whose `<form>` ancestor is outside the fragment, `el.form` is `null`, so
nothing is registered. Once mounted, `el.form` resolves correctly — the binding
simply happened too early to see it.

**Impact.** A conditionally-shown field edited without blurring is silently
absent from the draft the engine sees on submit. Silent, and only reachable with
the default `change` trigger — `data-on="input"` masks it, which is why the
examples do not hit it.

**Recorded in the suite** as a `todo` test in `test/kernel.test.ts` ("a data-if
field inside a form flushes before submit") so it is visible without failing CI
and without asserting the wrong behavior as correct.

**Fix applied:** insert before binding in both `#applyIf` and `#applyEach`.

### P-2 · `data-if`/`data-each` on a non-`<template>` was silently ignored

✅ **FIXED.** Found externally, in a real consumer project — see finding **L-2**
in [19-evidence.md](19-evidence.md), where a `data-if` on a `<p>` meant an
empty-state message never disappeared, and it was caught only by loading the
page. No test caught it, in either project.

`#bindElement` guarded on `el instanceof HTMLTemplateElement`; an ordinary
element carrying the attribute fell through both guards with no error and no
warning. It now throws, which `start()` catches and reports as
`BridgeError { phase: "binding" }` before dispatching `Initialize`.

Same silent-failure family as **D-5** — the `data-if` missing-*key* asymmetry —
which remains by design (a falsy key is a legitimate way to keep content
unmounted; a misplaced attribute never is).

---

### P-3 · An undecodable response discarded its status code

✅ **FIXED.** Found by dogfooding — building the demos page for the website
exposed it within minutes, which is the clearest argument for the site existing
at all.

**Behavior.** `#runHttp` reported `Failure { reason: "invalid-response" }` with
no status whenever `response.json()` threw. Since **most servers return HTML
error pages**, that is the ordinary case for a 404 or a 500 — so the status was
being thrown away exactly when it mattered most, and a 500 error page became
indistinguishable from a 200 carrying malformed JSON. The first is often worth
retrying; the second never is.

It also made the documentation wrong: "a 404 is a `Success`" is true only if the
404's body happens to parse as JSON, which is unusual.

**Fix.** `EffectOutcome`'s `Failure` variant gained an optional
`status?: number`, set exactly when a response was received — so on
`invalid-response`, never on `network`/`aborted`. The absence of `status` now
carries the meaning "nothing came back". Additive, so no consumer breaks.

Covered by three tests (a 503 error page, a malformed 200, and a network failure
that must carry no status), plus two at the site level.

## N — Naming

### N-1 · "kernel" and "capability" each carry two meanings

**"Kernel"** means the browser-side bridge (`BrowserKernel`, `src/kernel/`).
But the package is named `typescript-wasm-kernel`, and `docs/ROADMAP.md`'s
mental-model diagram labels the *engine* as "WASM Kernel (today:
ReferenceEngine, TypeScript)". So the same word names both sides of the
boundary depending on the document.

**"Capability"** means both a projected UI permission (`saveDisabled`) and a
browser facility the kernel can perform (`Initialize.capabilities`).

Both are recorded in [glossary.md](glossary.md) with canonical choices
(**kernel** = the bridge; **engine** = the application side) and a recommended
usage table. Existing code and ROADMAP text were **not** renamed — that is churn
with real cost and no functional gain.

### N-2 · The `any`/`dynamic` check is a raw-text regex

`/\b(any|dynamic)\b/` runs over raw file text, not the AST. It matches inside
comments and string literals, so a comment reading "any of these" fails the
build. It is case-sensitive and word-bounded, so `Any` and `company` are safe.

Working as designed — a deliberately blunt instrument — but surprising the first
time. Documented in
[16-troubleshooting.md](16-troubleshooting.md#npm-run-check-fails).

---

## D — Documentation problems (resolved)

| ID | Problem | Resolution |
| --- | --- | --- |
| D-1 | No guide for building a *new* application. `USAGE.md` assumed the reader already understood the model. | [02-getting-started.md](02-getting-started.md) |
| D-2 | No API reference. Signatures were only discoverable by reading source. | [11-api-reference.md](11-api-reference.md), with stability tiers |
| D-3 | `AGENTS.md` contained **no kernel information at all** — pure ROS governance. An agent starting at the standard entry point learned nothing about the architecture, and `src/` was not mentioned. | Rewritten: Part 1 kernel, Part 2 ROS governance preserved verbatim |
| D-4 | No anti-pattern, troubleshooting, glossary, design-rules, or agent-decision documentation | Documents 12–16 and the glossary |
| D-5 | The `data-if` missing-key asymmetry was undocumented. `data-text` **throws** on a missing key; `data-if` treats it as falsy and **silently unmounts**. The most common cause of "my content never appears". | [06-rendering.md](06-rendering.md), [16-troubleshooting.md](16-troubleshooting.md) |
| D-6 | Nested `data-each` is **impossible** — `ViewItem` admits only primitives, so an item cannot hold an array — and this was not stated anywhere. | [06-rendering.md](06-rendering.md), [11-api-reference.md](11-api-reference.md) |
| D-7 | `docs/work-protocol.md` contains two broken links (`../research/decisions/DF-ROS-2026-A008--repository-local-work-backlog.md`, `work-backlog-guide.md`). | **Upstream ROS defect, not fixed here** — editing it would be reverted by the next `ros` install. Excluded from the link checker with a comment naming this finding. |
| D-8 | The rationale for a partial projection aborting its own effects was undocumented — a "frozen page with no network activity" had no explanation. | [03-kernel-lifecycle.md](03-kernel-lifecycle.md), [13-anti-patterns.md](13-anti-patterns.md) #11 |
| D-9 | `src/main.ts` compiles to `dist/main.js` and ships in the published package. Importing it **auto-constructs a kernel and starts the email demo** as a side effect — despite `"sideEffects": false` in `package.json`. Not reachable via any `exports` subpath, so the practical risk is low. | Documented here. **Suggested (not done):** exclude `main.ts` from the published build. |

---

## E / T — Examples and verification (resolved)

**E-1.** The repository had one reference feature (`index.html`) and one demo
page (`examples/kitchen-sink.html`). Neither is an *application*: the first is a
single feature, the second a primitives showcase driven by a throwaway engine.
There was nothing showing how to structure a real application, multiple screens,
a save lifecycle, or a realistic feature.

Six examples added, each with `index.html` + `engine.ts` + `main.ts`:

| Example | Demonstrates |
| --- | --- |
| `01-counter` | the minimum whole app: event → transition → projection → DOM |
| `02-form` | validation, capability projection, rejected illegal transitions |
| `03-fetch-data` | Http effect, list rendering, all four outcomes, stale-result rejection |
| `04-save-data` | full save lifecycle, Storage effect, non-idempotent write safety |
| `05-multi-screen` | screens as state, shared vs. screen-local lifetimes, engine-side filtering |
| `06-time-entries` | a realistic feature: load, validate, add, mutate, refresh |

**T-1.** Nothing verified that examples still worked. `kitchen-sink.js` had no
test at all, and no mechanism existed to catch documentation drift.

Added:

- `test/examples.test.ts` — 28 tests driving every example through the real
  `BrowserKernel`. Markup is read from each example's **actual `index.html`**
  (`exampleBody()` in `test/dom-helpers.ts`), so HTML that drifts from its
  engine fails the suite.
- `tsconfig.examples.json` + `npm run build:examples` — examples are
  type-checked under the same strictness as `src/`.
- `scripts/check-docs.ts` + `npm run check:docs` — verifies Markdown links
  resolve, that file paths named in prose exist, and that no document under
  `docs/` is orphaned.
- Both wired into `npm test`, so CI runs them on every push.

`examples/kitchen-sink.js` remains untested — it is a hand-written demo, not
part of the published package, and testing it would mean testing its fake
`fetch` and `Storage.prototype.setItem` monkey-patches. Left as is, noted here.

---

## B — Compatibility

### B-1 · No breaking-change policy (unresolved)

The package is `0.4.1`. Under semver, `0.x` minor releases may break. Nothing
states whether the protocol is expected to be stable, what would trigger a
`PROTOCOL_VERSION` bump, or what a consumer should pin.

`PROTOCOL_VERSION` exists and is negotiated at `Initialize`, which is the right
mechanism — but no policy governs when it changes.

[11-api-reference.md](11-api-reference.md) now states stability **tiers** and
says plainly that no written policy exists. **Open question for the
maintainer.**

---

## Validation of the core architectural story

Each sentence assessed against the implementation.

| # | Statement | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | The browser owns HTML/CSS rendering. | **Confirmed** | No DOM construction anywhere in `src/engine/`. `ViewState` cannot express markup. `SetInnerHtml`/`eval` banned by `scripts/check-architecture.ts`. Only `textContent`, attributes, and template mount/unmount are written. |
| 2 | JavaScript is a deliberately thin integration boundary between browser capabilities and WebAssembly. | **Partially confirmed** | Thin and generic: ✅ — `src/kernel/browser-kernel.ts` is ~310 lines, six attributes, no domain branching. **"and WebAssembly" is incorrect today** — the far side is in-process TypeScript (`src/engine/transport.ts`). Accurate as *"between browser capabilities and the engine"*. See A-2. |
| 3 | Application state and behavioral decisions live in WASM. | **Incorrect as written; confirmed in substance** | State and decisions do live behind the boundary, in one place (`ReferenceEngine.#state`), with browser access mechanically banned. But that place is **TypeScript, not WebAssembly**. See A-2, [17-wasm-migration.md](17-wasm-migration.md). |
| 4 | Browser events are translated into application events. | **Confirmed** | `#bindEvent`/`#fire` produce `SemanticEvent { name, key?, value? }`. No element id, node, or event object crosses. `eventToCommand` narrows the open string vocabulary to a closed one. |
| 5 | Application events produce explicit state transitions and, when necessary, requests for external effects. | **Confirmed** | `transition(state, command) → { state, effects }` throughout `src/engine/domain.ts` and every example. Effects are returned as data, never performed. |
| 6 | External effects cross the browser boundary explicitly and their results return as events or equivalent kernel inputs. | **Confirmed** | `EffectRequest` → `#executeEffect` → `EffectResult` → `#send` → `dispatch`. Results arrive as ordinary `BrowserToEngineMessage`s, correlated by `CorrelationId`. |
| 7 | The browser then reflects the resulting application/render state. | **Confirmed** | `#applyScope`/`#applyIf`/`#applyEach` apply a complete `ViewState`. The DOM is written to, never read as truth (the sole read, `readValue()`, is event transport). |

**Summary.** Six of seven sentences are confirmed. The two that are not fail on
exactly one point: **they say WebAssembly where the implementation has
TypeScript.** The architecture itself has not drifted — the *description* of it
has, and that single word is the audit's central finding.

An accurate restatement:

> The browser owns HTML/CSS rendering. JavaScript is a deliberately thin
> integration boundary between browser capabilities and the application engine.
> Application state and behavioral decisions live in the engine, behind a
> narrow, serializable boundary designed so that engine can later be
> WebAssembly. Browser events are translated into application events.
> Application events produce explicit state transitions and, when necessary,
> requests for external effects. External effects cross the browser boundary
> explicitly and their results return to the engine as ordinary inputs. The
> browser then reflects the resulting projection.

---

## Changes intentionally not made

| Not done | Why |
| --- | --- |
| Renaming the package | Breaking for consumers; a maintainer decision, not a documentation one. |
| Renaming `DirectTypeScriptTransport` / its subpath | Public API change. Documented as reference-only instead. |
| Excluding `main.ts` from the published build (D-9) | Packaging change with release implications. Documented. |
| Fixing the broken links in `docs/work-protocol.md` | ROS-installed content; edits would be reverted by the next install. Reported upstream-shaped instead. |
| Renaming "kernel"/"capability" in code and ROADMAP | Churn with real cost and no functional gain. Canonical terms recorded in the glossary. |
| Reconciling the two prompt specs (A-4) | Deliberate pre-existing policy: documented, not silently resolved. |
| Rewriting `docs/USAGE.md` | Still accurate. Kept and linked for continuity; superseded in practice by 02/07/11. |
| Testing `kitchen-sink.js` | A hand-written demo outside the package; testing it would mostly test its own `fetch` and storage monkey-patches. |
| Adding browser capabilities (clipboard, history, timers) | Would violate the repository's own 🧊 policy against building ahead of a demonstrated need. Extension procedure documented instead. |

---

## Resources located (for follow-on work)

| Resource | Where | Notes |
| --- | --- | --- |
| Echelon Foundry design system | `github.com/kemiller2002/consulting-company`, `assets/css/style.css` | 190 lines. Canonical palette (`--ef-*` tokens), type scale (Newsreader / Manrope / IBM Plex Mono), layout, cards, stat blocks, research rows, responsive + `prefers-reduced-motion` + `forced-colors` handling. Public repo; clone anonymously. **This is the authoritative source** to reuse for a Limen site rather than approximating. |
| EF page templates | same repo, `src/templates/{layout,header,footer}.html` | Static-build model, `{{title}}`/`{{content}}` substitution via `build.js`. |
| EF Pages workflow | same repo, `.github/workflows/deploy-pages.yml` | Already uses least-privilege `contents: read` / `pages: write` / `id-token: write`, `main`-only, `concurrency: pages`. A sound model to follow. |
| .NET / F# toolchain | **available** — corrected | An earlier entry here recorded the toolchain as unavailable because `builds.dotnet.microsoft.com` is policy-denied (HTTP 403) by the agent proxy. That conclusion was wrong: only Microsoft's own CDN is blocked. The Ubuntu archive carries `dotnet-sdk-8.0`, and `apt-get install dotnet-sdk-8.0` installs a working SDK (8.0.131 as tested). NuGet is reachable, xunit restores, and self-contained cross-publish to all five target platforms succeeds. The lifecycle CLI in `cli/` was built and tested with it. |

## Open questions

Genuinely unresolved. Not guessed at.

1. **Should the package be renamed**, or is the name understood as describing
   the boundary's shape? (A-2)
2. **Which language for a real WASM engine?** F#, C#, Rust, Kotlin, and Java are
   all named in the prompts; no decision record exists.
3. **What is the breaking-change policy for `0.x`?** (B-1)
4. **Should `DirectTypeScriptTransport` remain a top-level export?** (A-1)
5. **Should P-1 be fixed**, or is the flush intentionally limited to statically
   bound fields?
6. **Should `main.ts` ship in the package?** (D-9)
7. **Is there a real consumer requirement for WebAssembly yet?** Per the
   repository's own 🧊 policy, the answer determines whether any of the
   migration work should begin.
