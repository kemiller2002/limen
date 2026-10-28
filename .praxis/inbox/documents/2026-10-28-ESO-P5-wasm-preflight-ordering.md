# ESO-P5: WebAssembly preflight runs before browser integration tests

Status: proposed source input for Praxis.
Priority: P5 within the initiative
Owner system: Limen (documentation of `limen wasm-check`)
Intake: Praxis document ingestion. Source material, not a canonical requirement.
Initiative: Echelon development speed optimization, Priority Five ("WebAssembly preflight").
Work item: WI-0178.

## Evidence

- Rehearsal 5 (kemiller2002/indy-init-rehearsal-005) failed at WebAssembly start: `View.project` exceeded the Mono interpreter's 65,535-byte locals frame ("locals size too big"). Failing commit ec6407b; fix a0e7d4a.
- `limen wasm-check` (WI-0177, EII-A) already detects this statically. Its controlled examples already cover all six shapes Priority Five requires, each compared with the real interpreter:
  - small projection, large projection, split projection, deep nesting, many captured values, large generated match
  - (`cli/tests/InterpreterFrame.Examples/generate.fsx`, `cli/tests/Limen.Core.Tests/InterpreterFrameTests.fs`, docs/57).
- Rebuilt on 2026-10-28 with SDK 10.0.402, `wasm-check` reproduced every static figure in docs/57 to the byte, in 256-320 ms.
- Gap: docs/57 says to run the check "after the guest's `dotnet build -c Release`" but not that it must gate the browser (Playwright) job, which is where the time is lost.

## Requirement (proposed)

- **ESO-P5-R1, ordering.** docs/57 states that a consuming application runs `limen wasm-check` immediately after its Release build and before any browser or Playwright step, and that a failing check (exit 3) stops the pipeline before the browser starts.
- **ESO-P5-R2, no source-size limits.** No source-line or file-size limit is added; the frame estimate is the signal (docs/57 explains why source size did not predict the failure).

## Not claimed

- Nothing new was measured against the Mono interpreter: no case was missing, so no new controlled example was added.
- The browser start smoke remains the behavioural confirmation.
