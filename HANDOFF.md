# Limen handoff

## Current objective

Keep Limen's browser boundary small and generic while proving that substantial
application authority can live behind it in F# WebAssembly.

The product site is now the in-repository self-hosting consumer.

## Current state

- ROS 1.2.1 is installed and validating.
- Limen's npm runtime remains a TypeScript browser kernel/protocol with zero
  runtime dependencies.
- The lifecycle CLI remains F# and is exercised cross-platform.
- The interactive Limen product site no longer has a TypeScript application
  engine.
- Site application state, transitions, evidence handling, capabilities,
  obligations, stale-result rejection, reconciliation and projection live in
  `site/fsharp/Limen.Site.Engine/`.
- `site/fsharp/Limen.Site.Wasm/Program.cs` is a one-method .NET
  `[JSExport]` marshalling shim and contains no application decision.
- `site/app/wasm-engine-transport.ts` performs runtime loading plus JSON
  serialization only.
- `scripts/check-architecture.ts` mechanically rejects JS/browser/I/O
  authority in the F# site engine and representative application logic in the
  C# shim.
- Pages and normal CI build the F# WebAssembly host.
- The built site is smoke-tested in real headless Chrome. The check succeeds
  only if a value projected by F# initialization reaches the DOM.

## Product-site demonstrations

The old counter-focused showcase has been replaced with cases where the
boundary matters:

1. **Release gate**
   - test/security evidence;
   - approval capability;
   - deployment capability;
   - success/network-failure browser effects;
   - deterministic `OutcomeUnknown` evidence injection;
   - reconciliation before another deployment attempt.
2. **Stale evidence race**
   - policy A begins;
   - newer policy B begins;
   - A arrives last;
   - F# records and discards the stale result instead of overwriting B.
3. **Boundary-placement challenge**
   - twelve nontrivial placement decisions;
   - includes route meaning, HTTP status interpretation, retry legality,
     browser history, storage, semantic HTML, CSS, focus and clipboard read;
   - unsupported browser authority correctly resolves to **Protocol change**.
4. **Transition trace**
   - projected by the F# engine;
   - records accepted state transitions and effect/reconciliation evidence.

## Important design distinctions

- Limen does **not** itself make illegal domain states unrepresentable. A
  consumer's typed engine can do that. The F# site engine does.
- The npm package does **not** require WebAssembly. WebAssembly is one real
  engine transport now demonstrated by the product site and the external
  time-entry consumer.
- A timeout-after-dispatch demo on a static Pages site cannot be made reliably
  slow with a local fixture. The site injects an already-classified
  `OutcomeUnknown` into F# for deterministic recovery testing; the kernel's
  timeout classification is tested separately.
- Performance, startup cost, token savings, defect reduction and development
  speed remain unmeasured comparative claims.

## Verification

The current branch has passed:

```text
ROS validation                              PASS
F# lifecycle core                           PASS
F# site-engine tests                        PASS
TypeScript/kernel/examples/site tests       PASS
Architecture checks                         PASS
Documentation cross-checks                  PASS
Pages artifact checks                       PASS
Real-Chrome F# WebAssembly startup          PASS
npm package dry-run                         PASS
Clean-room packed-package install           PASS
Packaged CLI — Linux                        PASS
Packaged CLI — Windows                      PASS
Packaged CLI — macOS                        PASS
```

The real-browser smoke requires the F# engine to initialize through the .NET
WebAssembly runtime and project:

`Release is not yet legal. Resolve the obligations below.`

into the DOM. Static markup alone cannot satisfy the check.

## Primary implementation paths

- `site/fsharp/Limen.Site.Engine/`
- `site/fsharp/Limen.Site.Wasm/`
- `site/app/wasm-engine-transport.ts`
- `site/app/main.ts`
- `site/pages/index.html`
- `site/pages/demos.html`
- `site/pages/architecture.html`
- `site/pages/evidence.html`
- `scripts/check-architecture.ts`
- `scripts/check-site.ts`
- `scripts/smoke-site-wasm.sh`
- `test/site.test.ts`
- `docs/17-wasm-migration.md`
- `docs/19-evidence.md`

## Work item

`WI-0022` — Rework the Limen site around product value, architectural
clarity, verified evidence, and honest WASM status.

Complete it only with implementation and test evidence after the final branch
head passes the repository gates.

## Next evidence question

The repository now proves feasibility and boundary integrity, not comparative
superiority.

A useful future experiment would compare the same substantial UI requirement
under:

- Limen + F# WebAssembly;
- a conventional browser-state architecture;

while holding model, requirements and verification method constant and
recording rework, defects, changed files, build cycles and available
cost/context telemetry.

---

## GH-57 — site positioning: Why Limen, language-neutral WASM, agent-safe correctness

Work item: `GH-57` (external ID; GitHub issue #57, context #15 and #51). A local
`WI-####` was deliberately not used: open PR #56 already allocates
WI-0027…WI-0038, and a new local number would collide when both merge.

### Ordo record

- **Prior state:** product-level copy said "The application is F#" and
  "F# application authority"; no Why Limen page; no comparative-claims
  section; no link to the #15/#51 specifications.
- **Required state:** Limen presented as a language-neutral WebAssembly
  boundary; this site's F#/.NET engine presented as the reference consumer;
  every claim labelled as implemented, accepted/in progress, or unmeasured.
- **Legal transition:** communication-only change to `site/pages`,
  `site/templates`, `scripts/build-site.ts`, the site CSS, and
  `test/site.test.ts`. No protocol, kernel, engine, or guardrail change.
- **Evidence:** `npm run check` (137 pass, 1 pre-existing skip: CLI binary not
  built), `npm run smoke:site:wasm` in real Chromium, docs cross-check of the
  quoted `EffectOutcome`, Playwright inspection at 320–1440px (no horizontal
  overflow), keyboard focus trail, forced colors, reduced motion.
- **Negative knowledge (checked on `main`, 2026-09-29):** no neutral contract
  source, no generated bindings, no fingerprint handshake, no C# or Rust
  engine, no dependency/path-scope check, no restricted-TS checker beyond the
  `src/engine` substring ban, no generic fake host, no trace/replay tooling.
  This site's F# protocol types are a handwritten mirror of `src/protocol.ts`.
  Canonical repository documents for the neutral contract do not exist yet, so
  the Docs page links the #15 and #51 issues instead.
- **Stale-claim guard:** `test/site.test.ts` now fails if the old product-level
  F# phrases return, if Why Limen leaves the primary navigation, or if the
  evidence page stops marking the seven comparative outcomes "Not established".

### When #52/#55/#17 land

The site states their work as "Accepted, in progress". When PR #56 (or its
successors) merges, update the status cells in `why-limen.html` (guardrail and
language tables), `architecture.html` (contract model table), `agents.html`
(status card and the handwritten-mirror exception), and link the new canonical
documents from `docs.html`. Do not upgrade a status without the merged
implementation and its checks.

### Follow-ups observed, not fixed here

- `site/fsharp/federation/*/publish/` build outputs are not git-ignored, so a
  local build leaves untracked meaningful paths that fail `ros validate`.
  Already addressed on PR #56 (its WI-0027); not duplicated here.
- `npm install` rewrites `package-lock.json` to mark
  `@echelon-foundry/repository-operating-system` as a dev dependency (it
  already is in `package.json`). Lockfile drift predates this work; left
  untouched to keep the diff bounded.
- Visual Engineering context (`.visual-engineering/`) is git-ignored and must
  be regenerated with `npx @echelon-foundry/visual-engineering init` in a fresh
  checkout before `verify` passes.
