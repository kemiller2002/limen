# EII-A: .NET WebAssembly interpreter frame-size compatibility check

Status: proposed source input for Praxis.
Priority: P1
Owner system: Limen (F# lifecycle CLI, guest compatibility)
Intake: Praxis document ingestion. Source material, not a canonical requirement.
Initiative: Echelon Engineering Improvement Initiative, Workstream A ("WebAssembly compatibility").

## Evidence

- **Startup failure in a Limen-hosted F# guest.** In kemiller2002/indy-init-rehearsal-005, the page failed to start with:
  `System.InvalidProgramException: Unable to run method 'Causa.App.View:project (Causa.App.Shell/Model)': locals size too big.`
  - The first failing commit is ec6407b (about 21:30Z). The fix is a0e7d4a (23:00Z, "split View.project into nine per-area functions").
  - Nothing caught it: the .NET unit tests run on CoreCLR, which has no such limit, and no startup smoke ran on the WebAssembly build.
- **The limit is in the runtime source.** dotnet/runtime release/10.0 `src/mono/mono/mini/interp/transform.c`, `generate()`, line 9807: `if (td->total_locals_size >= G_MAXUINT16)`.
  - On the first overflow, the method is compiled once more with optimization on and inlining off.
  - If it still overflows, the runtime throws `InvalidProgramException` ("locals size too big").
- **The unit is bytes of interpreter variable slots.** At the first call (tier 0), every argument and every IL local gets its own slot: 8 bytes (`sizeof(stackval)`) for a reference or primitive, more for a value type. The total is aligned to 16.
- **This estimate matched the runtime in every case measured on the rehearsal:**

  | Commit | `View.project` IL locals | Estimated frame | Result |
  | --- | --- | --- | --- |
  | e02d000 | 7,246 | 57,984 B | starts |
  | ec6407b | 8,838 | 70,720 B | fails |
  | 80a0476 | 12,683 | 101,480 B | fails |

- **Source lines do not predict it; IL locals do.** The F# compiler, in Release, inlines small helpers, and each per-key temporary becomes its own IL local. Source line counts barely changed between the passing and the failing commit.
- **Calling the method is the only runtime confirmation.** `RuntimeHelpers.PrepareMethod` does not trigger the interpreter's compile.
- **No existing check sees this.** `limen verify` and `limen doctor` inspect installation state and engine source text. `smoke:site:wasm` runs only Limen's own sample site.

## Requirement (proposed)

- **EII-A-R1, static check.** Limen ships a read-only static check over a guest's built assemblies, implemented in F# with System.Reflection.Metadata and no new dependency.
  - For every method body, it estimates the interpreter's tier-0 frame: arguments plus IL locals, 8 bytes per reference or primitive slot, and value types sized from their fields.
  - A value type whose size cannot be resolved is reported as "size unresolved". It is never silently counted as 8 bytes.
- **EII-A-R2, thresholds.** At ≥ 65,535 bytes the check reports an error; at ≥ 32,768 bytes, a warning. Both thresholds are named constants that cite transform.c.
- **EII-A-R3, actionable output.** The check reports the largest methods with their remedy: split the work per area, and mark small helpers `[<MethodImpl(MethodImplOptions.NoInlining)>]`.
- **EII-A-R4, surface.** The check is exposed the way Limen exposes its other findings, at the smallest surface consistent with the CLI architecture.
  - The core is pure: metadata facts in, findings out.
  - The I/O shell around it is thin.
- **EII-A-R5, controlled examples.** F# fixtures cover six shapes:
  1. a small projection;
  2. a large projection that exceeds the limit;
  3. the same projection split into functions;
  4. a deeply nested projection;
  5. many captured values;
  6. a large generated match.

  Each fixture's static estimate is compared with the real Mono WebAssembly interpreter result (jiterpreter off, `MONO_INTERPRETER_OPTIONS=-ssa,-bblocks`, and defaults). False positives and false negatives are published.
- **EII-A-R6, validation on the real case.** The rehearsal-005 commits are copied to scratch and built in Release; the rehearsal itself is never modified. The check must:
  - flag ec6407b;
  - pass e02d000 and a0e7d4a;
  - report bb89d44 truthfully.
- **EII-A-R7, documentation.** The documentation covers:
  - what the limit is, with the source citation;
  - what the check catches;
  - the false-positive and false-negative risks;
  - how to run it;
  - that a rehearsal adopts it through its pinned Limen version.

## Not claimed

- The check does not prove a method will run. The interpreter's optimized retry can fit a method that overflows at tier 0, and other 16-bit interpreter limits exist.
- A startup smoke on the real WebAssembly build remains the behavioural confirmation.
