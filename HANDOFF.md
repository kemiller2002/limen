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
