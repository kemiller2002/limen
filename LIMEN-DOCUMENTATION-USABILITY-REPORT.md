# Limen documentation, examples and npm usability — report

**Mission:** agents and humans were having difficulty understanding how to use
Limen. Treat that as a product defect, and make Limen understandable from three
entry points: cloning the repository, installing the npm package, and arriving
as a coding agent with no institutional knowledge.

**Branch:** `claude/limen-docs-usability-hh5tvh` ·
**Work items:** WI-0014 – WI-0018

---

## 1. Baseline

Measured before any change, at the starting SHA.

| | |
| --- | --- |
| Repository | `kemiller2002/typescript-wasm-kernel` |
| Starting SHA | `5fcaf7e` (`release: 0.5.1 — the first publishable version`) |
| Working tree | clean |
| Package name | `@echelon-foundry/typescript-wasm-kernel` |
| Version | `0.5.1` |
| Build | `npm run build` clean |
| Tests | 89 tests: 88 pass, 1 skipped (the CLI test, which needs the .NET SDK) |
| Documentation | 94 Markdown files; `docs/01` – `docs/22`, plus roadmap, glossary, audit |
| Examples | six (`01-counter` … `06-time-entries`) plus a kitchen sink; **no per-example READMEs** |
| `AGENTS.md` | present and substantial |
| **npm pack** | **33 files, 24.7 kB packed, 84.6 kB unpacked** |

What an npm consumer actually received:

```
LICENSE  README.md  architecture.yaml  bin/limen.js  package.json
dist/**  (js, d.ts, maps)
```

No documentation. No example. No CHANGELOG. And the README's every
documentation link was repository-relative — which is to say dead on npmjs.com,
where most people read it.

`npm pack --dry-run` also ran `prepack` → `npm run check` → which failed,
because `node_modules` was absent in a fresh clone; that is expected, and
`npm install` fixed it.

---

## 2. What the audit found

### Scenario A — the npm-only consumer

Someone who sees only `npm install …` and the package page.

| Question | Could they answer it? |
| --- | --- |
| What is Limen? | Yes — the README is good |
| Where is the first example? | Yes, in the README |
| How do I initialize it? | Yes |
| Which API is public? | **No** — the stability tiers are in `docs/11-api-reference.md`, not shipped, and the README links to it relatively (broken on npm) |
| How do I route? | **No** — not implemented |
| How do I use the clipboard? | **No** — not implemented |
| How do effects work? | Partly — named, not explained |
| Where does state belong? | Partly — stated, not demonstrated |
| Troubleshooting? | **No** — `docs/16` exists, is not shipped, and the link is broken on npm |
| F# integration? | **No** — and the question is based on a false premise; see §3 |

Every "no" required leaving npm for GitHub. Several required leaving GitHub for
the source.

### Scenario B — the repository consumer

The repository is well documented, but its entry points asked a newcomer to
read `docs/01-architecture.md` (long) and `src/protocol.ts` (source) before
anything else. Nothing answered "who owns what?" or "where does my change go?"
on its own; both had to be assembled from `01`, `04`, `07`, `12`, `13` and the
implementation.

### Scenario C — the coding agent

Given *"Add a button that copies a URL to the clipboard using Limen"*, an agent
could not succeed, because **the capability did not exist**. The best available
answer was `docs/15-recipes.md`'s "add a new browser capability" section, which
used clipboard as its *hypothetical* worked example. The same was true of
routing: `docs/08-multi-screen-applications.md` opened by saying there is no
router and no `popstate` handling.

So the mission's own acceptance test — *build an app with state, routing, fetch
and clipboard* — was unsatisfiable by documentation alone. That finding drove
the largest part of this work.

### Findings, classified

| # | Class | Finding |
| --- | --- | --- |
| F-1 | Missing capability | No clipboard. Every answer was "extend the protocol yourself". |
| F-2 | Missing capability | No routing/history. Deep links, Back and Forward were impossible. |
| F-3 | **Diagnostic defect** | An effect kind the kernel could not run raised an **unhandled rejection** and sent no result, leaving the engine waiting forever on a correlation id. The `"effect"` diagnostics phase was declared in `DiagnosticEvent` from the beginning and **never emitted**. |
| F-4 | Package defect | No documentation, no example, no CHANGELOG in the tarball. |
| F-5 | Package defect | Every README documentation link was relative, so all of them broke on npmjs.com. |
| F-6 | **Package defect** | `@echelon-foundry/repository-operating-system` was a **runtime dependency**. It is governance tooling; nothing under `src/` imports it. Every consumer installed it transitively, and it made the README's "no runtime dependencies" claim false. |
| F-7 | Documentation gap | No single document answered "who owns what" or "where does this change go". |
| F-8 | Documentation gap | No end-to-end trace of a single interaction through the real files. |
| F-9 | Documentation gap | No per-example README. Examples were listed, not explained. |
| F-10 | Documentation gap | No five-minute path; the shortest was `docs/02-getting-started.md`. |
| F-11 | Navigation | `AGENTS.md`'s reading order began with architecture prose and `src/protocol.ts` — i.e. source-diving was the documented first step. |
| F-12 | Consistency | The website claimed "two browser capabilities" and "no routing or history", which would have become false the moment the code changed. |
| F-13 | **Premise error in the brief** | The mission asks repeatedly for "F# owns application state". It does not, and never has here. See §3. |
| F-14 | Verification gap | No way to run the examples in a real browser, though the repository's own definition of done requires it. |
| F-15 | Verification gap | Nothing checked what the tarball contained, or that it worked once installed. |
| F-16 | Terminology | Residual "Typescript Wasm Kernel" in bootstrap/governance artifacts. Left deliberately; see §10. |

---

## 3. A correction to the brief: F# does not own application state

The mission statement says, in several places, that application state and
decisions "remain in F#", and asks for F# examples throughout. **That is not
this architecture**, and publishing it would have made the documentation worse,
not better. §7 of the brief says to publish the paragraph only if the
implementation verifies it, and to correct the wording otherwise. This is that
correction.

| Part | Language | Status |
| --- | --- | --- |
| The browser kernel (`src/kernel/`) | TypeScript | shipped |
| The application engine (`src/engine/`, and a consumer's own) | **TypeScript** | shipped |
| The lifecycle CLI (`cli/Limen.Core/`, `cli/Limen.Cli/`) | **F#** | shipped, as platform binaries |
| A WASM engine in F# / C# / Rust / Kotlin | — | **not implemented** |

There is no WebAssembly in this repository and no F#-to-browser binding. The
boundary is *designed* so an engine in another language could replace the
TypeScript one without the browser side changing — everything crossing it is
plain data — but that migration has not happened, and
`docs/17-wasm-migration.md` assesses honestly what it would take.

This was already documented. What it lacked was prominence: it is now the
second of three answers in the README's "three things newcomers ask first", and
has its own section. The brief itself arriving with this misconception is the
strongest evidence available that it needed to be said louder.

The corrected one-paragraph description, which is what now appears:

> Limen is an explicit boundary between browser capabilities and application
> authority. The browser performs browser-native operations, Limen carries
> events and effects across the boundary, and application state and decisions
> stay in the engine — TypeScript today, and deliberately replaceable.

---

## 4. Capabilities added

Documentation could not close F-1 and F-2. Both were implemented under the ROS
work protocol (WI-0014), with tests.

### Clipboard

```ts
type ClipboardEffectRequest = { kind: "Clipboard"; correlationId; operation: "writeText"; text: string };
type ClipboardOutcome =
  | { kind: "Success" }
  | { kind: "Failure"; reason: "denied" | "unavailable" | "unknown" };
```

Three decisions worth recording:

- **Write-only.** A `readText` would let an engine pull whatever the user last
  copied — a password, an address — across the boundary on its own initiative.
  No use case here needs it, and a capability that dangerous should not exist
  speculatively.
- **Three failure reasons, because an engine answers them differently.**
  `denied` usually means a stale user gesture and a retry genuinely works;
  `unavailable` means no Clipboard API exists in this context and a retry can
  never work. Collapsing them costs the only honest advice a UI can give.
- **The copied text never reaches diagnostics**, under the rule that already
  keeps HTTP headers out of them. There is a test asserting it.

### Navigation

```ts
type NavigationEffectRequest =
  | { kind: "Navigation"; correlationId; operation: "push" | "replace"; url: string }
  | { kind: "Navigation"; correlationId; operation: "back" | "forward" };

type NavigationOutcome =
  | { kind: "Success"; location: BrowserLocation }
  | { kind: "Dispatched" }
  | { kind: "Failure"; reason: "unavailable" | "not-same-origin" };
```

Plus a new browser→engine message, `LocationChanged`, and a `location` field on
`Initialize`.

- **`Dispatched` is not a weaker `Success`.** `back`/`forward` only *ask*; the
  move arrives later as `LocationChanged`, or never, if there was nowhere to go.
- **`LocationChanged` is not an `EffectResult`**, because no effect was
  requested and nothing correlates it.
- **Cross-origin URLs are refused.** Leaving the origin ends the application
  and discards all engine state; no projection should be able to do that by
  accident. An `<a href>` needs no capability.
- **No history state object is stored.** The engine already owns the state a URL
  stands for; a copy in the history entry is a second source of truth that
  outlives its own schema.
- **The kernel splits a URL into path/query/hash and stops.** What
  `/invoices/42` *means* stays in the engine. There is no route table in Limen,
  and that is the point.

### Protocol change

`Initialize.capabilities` widens from the literal tuple `readonly ["Http",
"Storage"]` to `readonly Capability[]`. It is additive for any engine that
reads it, and it is now documented as saying what the **kernel implements**,
never what the browser will permit — availability and permission are reported
per effect, in that effect's own outcome. Recorded in the CHANGELOG under the
`0.x` protocol-stability caveat.

### The diagnostic defect (F-3)

`#runEffect` is now an exhaustive `switch` ending in `assertNeverEffect`, so a
variant added to `EffectRequest` without a branch is a **compile error** rather
than an effect that silently vanishes. At runtime, an unrunnable effect is
reported as `BridgeError { phase: "effect" }` — the phase that had been declared
and never emitted — instead of raising an unhandled rejection. An engine waiting
on a correlation id that will never be answered is the hardest Limen failure to
diagnose, so it is now the loudest thing the bridge says.

---

## 5. Documentation

### New

| Document | Answers | Ships in npm |
| --- | --- | --- |
| `docs/mental-model.md` | who owns state, the DOM, routing, decisions — with the enforcement mechanism named for **every** claim | yes |
| `docs/where-code-goes.md` | a placement table, a decision tree, wrong/right pairs, a "before you change Limen" checklist, and the genuinely ambiguous cases answered honestly | yes |
| `docs/quick-start.md` | five minutes to something working, nothing elided | yes |
| `docs/traces.md` | three interactions followed through every file and function they touch | no (linked) |
| `docs/routing.md` | typed routes, the push/adopt asymmetry, deep links, base paths, GitHub Pages | no (linked) |
| `docs/clipboard.md` | the capability, and the browser rules you cannot engineer around | no (linked) |
| `CHANGELOG.md` | what changed, by version | yes |

`docs/where-code-goes.md` includes a section most placement guides omit: the
cases that genuinely *are* ambiguous — formatting, scroll position, a native
`<details>`, debounce, third-party widgets — answered as judgement calls rather
than dressed up as rules.

### Updated

`docs/07-effects-and-browser-interop.md` (two new capability sections, plus
"capabilities are not permissions"), `docs/11-api-reference.md` (every new
type, with failure behavior and common mistakes), `docs/03-kernel-lifecycle.md`,
`docs/05-events-and-dispatch.md`, `docs/08-multi-screen-applications.md` (its
opening "limitation" was now false — it is reframed as the deliberate choice it
actually is), `docs/01-architecture.md`, `docs/ROADMAP.md`, `docs/glossary.md`,
`docs/09-testing-and-debugging.md`, `docs/README.md`.

`docs/13-anti-patterns.md` gains three, each drawn from a real failure mode:
pushing a URL in response to `LocationChanged` (which makes a page
inescapable), using the capability list as a permission check, and advising a
retry that cannot succeed.

`docs/15-recipes.md` gains four: copy to the clipboard, handle Back and
Forward, validate a form, and debug an event that goes nowhere. Its
"add a capability" recipe used clipboard as a *hypothetical*; it now points at
the real implementation as the worked example.

### For agents

`AGENTS.md` now opens with the capability table and the non-negotiable rules,
then gives:

- a **deterministic reading order** that starts with the mental model rather
  than the source, and says which three items suffice when context is short;
- **repository landmarks** with real paths, including the new executors;
- a **placement decision tree** with branches for "what a URL means" and "the
  browser moved on its own";
- **common agent mistakes** — twelve of them, each with what to do instead.

### README

Restructured as orientation rather than a manual: what it is, why it exists,
core architecture (two diagrams), install, the smallest working example, how
state works, how browser capabilities work, F# and this repository, examples,
documentation, for agents, the npm package, the CLI, compatibility, the site,
development, evidence, tradeoffs, release, license.

Its documentation links are **absolute**, because relative links break when npm
renders the README on npmjs.com (F-5).

---

## 6. Examples

| Example | Teaches |
| --- | --- |
| `01-counter` | the whole mechanism; capability projection |
| `02-form` | validation as pure functions; an illegal transition refused |
| `03-fetch-data` | the first effect; all four outcomes; the stale-result guard |
| `04-save-data` | a full write lifecycle; storage; why a timed-out POST is not retried |
| `05-multi-screen` | screens as state; shared vs. screen-local lifetimes; **no URLs, deliberately** |
| `06-time-entries` | a realistic feature; a failed refresh keeps the list, a failed first load does not |
| **`07-clipboard`** | **new** — the Clipboard capability; three failure reasons; waiting is a state |
| **`08-routing`** | **new** — typed routes; parse/format round-trip; the push/adopt asymmetry; deep links |
| **`minimal`** | **new** — the npm-shipped copy: four files, plain JavaScript, no build step |

Every example — including the six that existed — now has a README covering what
it demonstrates, its state model, its event and effect flow, how to run it,
expected behavior, exercises, and **the mistakes people actually make with it**.

Both new examples are executed by `test/examples.test.ts` against their own real
`index.html`, so they cannot silently rot. Eleven new example tests, including
the one that pins the routing trap:

```ts
// The push-on-popstate bug in one assertion.
assert.equal(adopted.effects.length, 0, "the browser has already moved; asking again is the history trap");
```

`examples/minimal/` imports the kernel by its **published package name**, so it
is wrong the moment an entry point stops resolving — and the clean-room check
builds it against the installed tarball on every run.

### One thing the examples taught us

Writing `07-clipboard` immediately hit a real constraint that was documented
nowhere: **bindings inside a `data-each` row resolve against the item, not the
top-level view.** A row binding a top-level key fails the entire projection
with `BridgeError { phase: "projection" }`. That is now in the mental model, the
example's own README, the debugging recipe and the troubleshooting guide.

---

## 7. npm package

| | Before | After |
| --- | --- | --- |
| Files | 33 | 48 |
| Packed | 24.7 kB | 61.4 kB |
| Unpacked | 84.6 kB | 209.0 kB |
| Documentation | README only | README, CHANGELOG, 6 documents, docs index |
| Example | none | `examples/minimal/` — four files, complete, no build step |
| Runtime dependencies | 1 (wrongly) | **0** |

The 2.5× is documentation and one working example. Bigger documents — the
traces, routing, clipboard, anti-patterns, the agent guide — stay online and are
linked absolutely.

### Metadata

`description` rewritten to name what the package does; `keywords` reordered to
put `limen` first and add `architecture`, `state-management`, `boundary`,
`interop`, `effects`; `repository`, `bugs`, `homepage`, `types`, `exports`,
`engines` verified accurate. **No compatibility-sensitive identity was
changed** — the package name and every export are untouched.

### F-6: the runtime dependency

`@echelon-foundry/repository-operating-system` was in `dependencies`. Nothing
under `src/` imports it — it is governance tooling driven by `./ros`, which
loads `./tools/ros_cli.mjs` from the repository. Every consumer of Limen was
installing it transitively, and its presence made the README's "no runtime
dependencies" claim false. It is a `devDependency` now.

### Two npm behaviors worth recording

- **npm includes a `README.md` from any directory it packs**, and a `"!"`
  negation in `files` does **not** remove it. `docs/README.md` and
  `examples/README.md` therefore ship whether or not you ask. Rather than
  fighting it, both now open by telling a reader inside `node_modules` which
  files are actually present beside them, and their links are absolute.
- **`npm pack` runs `prepack`**, which runs `npm run check`, which now runs the
  package check. Both new scripts pass `--ignore-scripts` when packing, or the
  check would pack recursively.

---

## 8. Verification added

Two claims were being conflated: *it works in the repository* and *it works when
installed*. They are now checked separately.

### `npm run check:package` — part of `npm run check`

- The tarball's contents against an expected manifest: every promised file
  present, nothing forbidden published (`src/`, `test/`, `dist/main.*`,
  research artifacts, anything that looks like a secret), nothing unexpected.
- Every link in packaged Markdown: a relative one must resolve to another
  **packaged** file; an absolute repository one must point at a path that
  exists.
- Every repository path named in packaged prose exists.

### `npm run check:clean-room` — CI, and the release workflow

Packs the tarball, installs it into an **empty** project, and then:

1. asserts the promised files are present under `node_modules/…`;
2. imports `BrowserKernel` and `PROTOCOL_VERSION` by package name, and the
   `./protocol` subpath export;
3. drives the documented minimal engine through real `Initialize` and `Event`
   messages and asserts the projection;
4. type-checks a TypeScript consumer against the **shipped `.d.ts` files**.

In the release workflow it runs against the real release archive
(`--tarball <path>`), so the artifact being published is the artifact being
proven.

### `npm run smoke:browser` — on demand

The repository's definition of done has always required that DOM-affecting
changes be exercised in a real browser, and there was no way to do it (F-14).
That mattered more than usual here, because jsdom **models** both new
capabilities rather than implementing them: it has no Clipboard API at all, and
its history is a model of session history.

`scripts/browser-smoke.ts` serves the repository from a ~25-line static server
and drives the counter, clipboard and routing examples in real Chromium — it
copies a URL and reads it back out of the actual clipboard, presses the
browser's own Back and Forward buttons, and loads a deep link cold.

**Playwright is deliberately not a dependency.** A package with zero runtime
dependencies does not acquire a browser automation stack for a check that runs
by hand. Without it the script says so and exits 0, so `npm run check` never
depends on it and CI is unchanged.

### `scripts/check-docs.ts`

Taught to follow absolute repository links, so adopting them for npm did not
quietly disable the existence and orphan checks it already performed.

---

## 9. Results

```
npm run check
  Architecture checks passed.
  Documentation checks passed (61 files).
  Site artifact checks passed (6 pages).
  Package checks passed: 48 files, 61.4 kB packed, 209.0 kB unpacked.
  tests 110 · pass 109 · fail 0 · skipped 1 (the CLI test — needs the .NET SDK)

npm run check:clean-room
  installed package contains 48 files, including every documented one
  smoke test passed: entry points resolve and the minimal engine runs
  Clean-room check passed: the packed tarball installs, resolves, type-checks and runs.

npm run smoke:browser   (real Chromium, Playwright installed out of tree)
  16/16 browser checks passed
```

Against the baseline: 89 → 110 tests, 88 → 109 passing. 70 files changed,
+5,571 / −349 lines, 30 files added.

| Verification | Status |
| --- | --- |
| Build (`tsc`) | ✅ |
| Example build | ✅ |
| Site build | ✅ |
| Architecture check | ✅ |
| Docs check | ✅ |
| Site artifact check | ✅ |
| Package contents check | ✅ (new) |
| Unit, kernel, example, site tests | ✅ 109/110, 1 skipped |
| Clean-room install | ✅ (new) |
| Browser smoke test | ✅ 16/16 (new) |
| CLI tests (`dotnet test`) | ⚠️ **not run** — the .NET SDK was not installed in this session; unchanged by this work, and CI runs them |
| Published site | ⚠️ not deployed from here; built and artifact-checked only |

---

## 10. Remaining issues, stated plainly

1. **The CLI tests were not run here.** `npm run test:cli` needs the .NET SDK 8.
   Nothing in this work touches `cli/`, and CI runs them on every push, but this
   session did not.
2. **The browser smoke test is not automated.** It runs on demand and is not in
   CI, because Playwright is not a dependency. Making it automatic is a real
   decision about dependency policy, and should be made deliberately rather than
   as a side effect of this work.
3. **Residual "Typescript Wasm Kernel" naming** in `HANDOFF.md`,
   `PROJECT-CHARTER.md`, `docs/PILOT-MEASUREMENT-PLAN.md`,
   `docs/architecture/README.md` and `docs/decisions/README.md`. These are ROS
   bootstrap and governance artifacts, titled from `ros.json`'s `project` field
   and re-generated by the ROS package; editing them here would be reverted.
   The deliberate historical references in `docs/17`, `docs/18`, the glossary
   and the audit stay, because that is what those documents are for.
4. **Clipboard read is absent, not deferred** — a deliberate refusal, recorded
   in the roadmap and `docs/clipboard.md`.
5. **Still not implemented:** files, timers, focus control, geolocation,
   `IndexedDB`, `sessionStorage`. Each remains a deliberate protocol change.
6. **`docs/README.md` and `examples/README.md` ship in the tarball whether or
   not we want them** (npm's always-include rule). They are made npm-safe rather
   than excluded, which is a workaround, not a fix.
7. **The packaged documentation set is a judgement call.** Six documents plus
   two indexes; the traces, routing and clipboard guides stay online. If package
   size is later found to matter less than offline completeness, the set can
   grow — `scripts/check-package.ts` is the single place that decides.
8. **No release was cut.** This sandbox cannot push tags (`CLAUDE.md` records
   why). Version and tag remain a human step.

---

## 11. Evidence and what is *not* claimed

The mission asks for before/after measures of agent comprehension, and warns
against converting "agents were confused" into a quantitative claim. That
warning is taken seriously here.

**No controlled measurement was performed.** No token counts, no time-to-first-
success, no defect rates, and no comparison against a baseline population of
agents. Nothing in this report, the README, the site or the documentation makes
a quantitative claim about Limen's effect on development time, cost, tokens or
defects — which is the same position `docs/19-evidence.md` already takes, and it
is unchanged.

What *is* claimed, and is verifiable:

- Three specific defects existed and are fixed (F-3, F-5, F-6), each with a
  test or a check that fails if it returns.
- Two capabilities the mission's acceptance test requires did not exist and now
  do, with tests at the unit, integration, example and real-browser levels.
- Every documented public behavior in this change was verified against the
  implementation, not written from memory or intent.
- The tarball's contents, its links, and its behavior once installed are now
  checked mechanically rather than assumed.

The comprehension exercises in §12 are **n=1 qualitative probes**, not
measurements. They are useful for finding gaps and useless as evidence of
improvement, and they are reported as such.

---

## 12. Documentation smoke test and agent comprehension

*(Filled in below from the clean-context exercises.)*
