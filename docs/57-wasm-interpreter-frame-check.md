# .NET WebAssembly interpreter frame check (`limen wasm-check`)

> **Optional — not Limen Core.** This is the `wasm-check` command of the lifecycle CLI, a tooling. It composes with the Core concept `engine-owns-meaning`: it checks that a .NET engine, which owns meaning, can actually run on the WebAssembly interpreter that hosts it. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

A .NET guest engine runs in the browser on the Mono **interpreter**. That interpreter refuses to run any method whose frame reaches 65,535 bytes. CoreCLR, where .NET unit tests run, has no such limit. The failure therefore appears only when the WebAssembly build starts in a browser, and it looks like this:

```text
System.InvalidProgramException: Unable to run method
'Microsoft.FSharp.Collections.FSharpMap`2<string, Limen.Contract.Core.Types/ViewValue>
 Causa.App.View:project (Causa.App.Shell/Model)': locals size too big.
```

`limen wasm-check` reads a guest's built assemblies and reports every method that will hit this limit, or is past half of it, before anything runs.

```sh
dotnet build -c Release src/app/App.fsproj
npx @echelon-foundry/limen wasm-check src/app/bin/Release/net10.0/
```

The check is read-only, needs no browser and no WebAssembly workload, and took about 0.3 seconds on the Causa build that failed.

## The limit

The authority is the runtime source, dotnet/runtime `release/10.0`, under `src/mono/mono/mini/interp/`.

- **The check that throws.** `transform.c`, `generate()`, line 9807:

  ```c
  if (td->total_locals_size >= G_MAXUINT16) {
      if (td->disable_inlining && td->optimized) {
          ... "Unable to run method '%s': locals size too big." -> InvalidProgramException
      } else {
          // We give the method another chance to compile with inlining disabled and optimization enabled
          td->retry_compilation = TRUE; ...
  ```

  The limit exists because variable offsets are 16-bit operands in the compacted interpreter code. The same limit is in v10.0.0 (line 9791) and in `main` (line 9846).

- **What is measured.** `total_locals_size` is a byte count of interpreter variable slots, not IL bytes, IL instructions or source lines.

- **How it is laid out at the first call (tier 0).** `interp_method_compute_offsets` (line 4662) gives every argument and every IL local its own slot, and never reuses a slot:
  - a reference, a primitive or an enum takes 8 bytes (`MINT_STACK_SLOT_SIZE` = `sizeof(stackval)`, `interp-internals.h`);
  - any other value type takes `mono_type_size`, its wasm32 size, aligned to 8;
  - the argument area is aligned to 16 (`MINT_STACK_ALIGNMENT`), the IL locals follow it, and the total is aligned to 16 again.

- **What happens on overflow.** The interpreter retries once, with optimization on and inlining off. The optimized allocator reuses slots only for variables that live inside one basic block. If the method still does not fit, the call throws.

`wasm-check` computes exactly that tier-0 figure for every method body. Its thresholds are named constants in `cli/Limen.Core/InterpreterFrame.fs` that cite the lines above:

| Constant | Value | Meaning |
| --- | --- | --- |
| `LocalsSizeLimitBytes` | 65,535 | `G_MAXUINT16`. At or above it, `LIMEN030` (error). |
| `WarningThresholdBytes` | 32,768 | Half the limit. At or above it, `LIMEN031` (warning). |
| `StackSlotBytes` | 8 | `sizeof(stackval)`: the smallest slot. |
| `FrameAlignmentBytes` | 16 | `MINT_STACK_ALIGNMENT`. |
| `PointerBytes` | 4 | Size of a reference inside a value type on wasm32. |

The warning threshold leaves room to grow. Causa's projection gained about 1,600 IL locals (12,800 bytes) per feature commit, and its source line count barely moved while it did. A source-size limit would not have warned.

## Why F# hits it

In Release, the F# compiler inlines small helpers into a large expression, for example a projection that is one big list literal. Every intermediate value becomes its own IL local, and F# does not reuse locals across the elements.

When an element of a list literal contains a branch (an `if`, a `match`, `&&`), the compiler first spills every pending element of that literal to a new local. The local count then grows with the square of the number of elements, not linearly.

**The compiler version matters.** The controlled examples below, built with .NET SDK 10.0.402 (F# 10), produce frames of up to 122,416 bytes. The same source built with SDK 8.0.132 (F# 8) spills almost nothing: its largest method frame is 1,296 bytes. A guest that passes on one SDK can fail on another, so run the check on the build you ship.

## What the check reports

For every method body in the assemblies it reads, `wasm-check`:

- lists the largest estimated frames (`--top N`, 10 by default), with argument and local counts;
- reports `LIMEN030` (error) for a frame of 65,535 bytes or more;
- reports `LIMEN031` (warning) for a frame of 32,768 bytes or more;
- names the method, its assembly, the figure and the runtime source, and gives the remedy:
  - split the method per area into separate top-level functions;
  - mark the small helpers it calls `[<MethodImpl(MethodImplOptions.NoInlining)>]`;
  - confirm with a startup smoke of the WebAssembly build.

Other findings:

| Code | Severity | Meaning |
| --- | --- | --- |
| `LIMEN030` | error | A method's tier-0 frame is at or over 65,535 bytes. |
| `LIMEN031` | warning | A method's tier-0 frame is at or over 32,768 bytes. |
| `LIMEN032` | information | Some value-type sizes could not be resolved, so those frames are lower bounds. |
| `LIMEN033` | warning | An input was skipped: a Webcil `.wasm` file, or not a .NET assembly. |
| `LIMEN034` | error | An input does not exist, or no assembly could be checked. A check of nothing is not a pass. |

Exit codes:

- `0`: no method reaches the limit (warnings may still be reported);
- `3`: a method reaches the limit, or nothing was checked;
- `2`: invalid arguments.

`--json` emits the same report as one JSON document (`schemaVersion` 1, `command: "wasm-check"`).

### Value types

Value types are sized from their fields, never assumed to be 8 bytes.

- **Generic arguments.** Generic arguments are substituted before a type is sized (for example `ValueTuple<decimal, decimal, decimal, decimal>` is 64 bytes). Explicit layouts and declared sizes are respected.
- **Where definitions come from.** Definitions are read from:
  1. the checked assemblies;
  2. the package assemblies named by the output's `*.deps.json` (a library build leaves FSharp.Core in the NuGet cache);
  3. `--reference` directories;
  4. the newest browser-wasm runtime pack in the NuGet cache (`microsoft.netcore.app.runtime.mono.browser-wasm`), when present. Its `native/System.Private.CoreLib.dll` defines `DateTime`, `Decimal` and similar types.

  A small built-in table covers common framework value types when none of these are available.
- **Unresolved types.** A value type whose definition cannot be found counts as 8 bytes, is marked as unresolved, and makes that frame a **lower bound** (`>=` in the text output, `"lowerBound": true` in JSON, and `LIMEN032`).

The controlled example `StructLocals` shows why this matters. Counted at 8 bytes per local, its frame is 9,168 bytes, which looks safe. Sized from its fields, it is 72,720 bytes, and the interpreter did refuse it.

### Inputs

- **What to pass.** Pass the guest's `.dll` build output (`bin/<Configuration>/<tfm>/`, or an `obj/` directory), or the `.dll` files themselves.
- **Framework assemblies.** In a directory, `System.*`, `Microsoft.*`, `mscorlib` and `netstandard` assemblies are read for value-type definitions but not checked.
- **Webcil.** The WebAssembly SDK ships assemblies Webcil-wrapped under `_framework/*.wasm`. System.Reflection.Metadata cannot read them, so `wasm-check` reports them (`LIMEN033`) instead of guessing. The `.dll` build output holds the same IL.

## Measured: estimate against the real interpreter

### Setup

- **Runtime.** `Microsoft.NETCore.App.Runtime.Mono.browser-wasm` 10.0.13 (SDK 10.0.402), the Mono interpreter under Node 22.
- **Interpreter options.** The jiterpreter is off (`--no-jiterpreter-traces-enabled`, `--no-jiterpreter-interp-entry-enabled`, `--no-jiterpreter-jit-call-enabled`). Each example ran twice: with Causa's `MONO_INTERPRETER_OPTIONS=-ssa,-bblocks`, and with the defaults. Both runs gave the same result for every example.
- **How each example ran.** A probe executable called each method once.
- **What "boundary" means.** The interpreter's own `MONO_VERBOSE_METHOD` output gives the offset of the first execution-stack variable. That offset is where its tier-0 locals area ends.

### Controlled examples

The examples are generated by `cli/tests/InterpreterFrame.Examples/generate.fsx` and built in Release with SDK 10 (F# 10).

| # | Example (method) | Arguments + IL locals | `wasm-check` estimate | Interpreter | Agreement |
| --- | --- | --- | --- | --- | --- |
| 1 | Small projection (`Small.project`) | 1 + 297 | 2,400, no finding | ran; boundary 2,400 | exact |
| 2 | Large projection (`Large.project`) | 1 + 12,852 | 102,832, error | locals size too big | yes |
| 2b | Same shape, just under (`LargeNear.project`) | 1 + 7,956 | 63,664, warning | ran; boundary 63,664 | exact |
| 2c | Same shape, just over (`LargeEdge.project`) | 1 + 8,505 | 68,064, error | locals size too big | yes |
| 3 | Large split per area, NoInlining helper (`Split.area00`..`area05`, `Split.project`) | 1 + 0 each | 16, no finding | ran | yes |
| 4 | Deeply nested projection (`Nested.project$cont@206`, a compiler-generated continuation) | 2 + 15,300 | 122,416, error | locals size too big (same method) | yes |
| 5 | Many captured values (`Closures.project`; its closure holds 160 fields) | 1 + 10,081 | 80,672, error | locals size too big | yes |
| 6 | Large generated match (`GeneratedMatch.project`) | 2 + 10,080 | 80,656, error | locals size too big | yes |
| 6b | Same shape, under (`GeneratedMatchNear.project`) | 2 + 6,300 | 50,416, warning | ran; boundary 50,416 | exact |
| 6c | Same shape, just over (`GeneratedMatchEdge.project`) | 2 + 8,316 | 66,544, error | locals size too big | yes |
| 7 | Value-type locals, 64-byte structs (`StructLocals.project`) | 1 + 1,143 (1,134 64-byte tuples, 6 decimals) | 72,720, error | locals size too big | yes |
| 7b | Same shape, just under (`StructLocalsNear.project`) | 1 + 984 (975 64-byte tuples, 6 decimals) | 62,544, warning | ran; boundary 62,544 | exact |

The results:

- **False positives: 0 of 7** methods flagged as errors.
- **False negatives: 0 of 6** methods that passed, including both "just under" cases.
- Where the boundary was read, the estimate equalled it to the byte.
- The interpreter's optimized retry rescued none of the over-limit methods, including those only 1.5% and 3.9% over (6c and 2c).
- Every method the interpreter refused was a method `wasm-check` named.

### The real case: indy-init-rehearsal-005

The commits were copied from the rehearsal's read-only clone with `git archive` into scratch and built in Release (`dotnet build src/app/Causa.App.fsproj -c Release`, SDK 10.0.402). Then `limen wasm-check src/app/bin/Release/net10.0/` ran on each. The rehearsal itself was not modified. The "Interpreter" column is from a probe that calls `View.project Shell.initial` on the same build.

| Commit | Largest method | Arguments + IL locals | `wasm-check` | Exit code | Interpreter (both option sets) |
| --- | --- | --- | --- | --- | --- |
| e02d000 (21:20Z) | `View.project` | 1 + 7,246 | 57,984, warning `LIMEN031` | 0 | starts; boundary 57,984 |
| ec6407b (21:30Z) | `View.project` | 1 + 8,838 | 70,720, error `LIMEN030` | 3 | locals size too big, `View.project` |
| bb89d44 (22:52Z, parent of the fix) | `View/keys2@463::Invoke` | 1 + 650 | 5,216, no finding | 0 | starts |
| a0e7d4a (23:00Z, the fix) | `View::invKeys` | 1 + 519 | 4,176, no finding | 0 | starts |

`wasm-check` flags ec6407b's `View.project`, the method the interpreter refused, and passes e02d000, bb89d44 and a0e7d4a. bb89d44 did not fail: its NoInlining helpers and per-area closures had already split the projection.

e02d000 is the useful case. It started, but it was at 88% of the limit, so `LIMEN031` would have warned one commit before the page stopped starting.

### Time to signal

- **The check:** 341 ms on e02d000, 409 ms on ec6407b, 449 ms on bb89d44 and 457 ms on a0e7d4a. Each run reads the three Causa assemblies, the four package assemblies named by `Causa.App.deps.json`, and the runtime pack (which is how `System.Private.CoreLib` is read). It runs after a Release build of `src/app` that took 28 to 47 seconds on this machine.
- **The CI browser run:** unavailable. The duration of the rehearsal's CI browser job is recorded only in GitHub Actions. It is not in the repository, and the rehearsal's remote was not queried while the experiment is active.
- **How long the page did not start:** about 90 minutes, from ec6407b (21:30Z) to the fix a0e7d4a (23:00Z), going by the commit timestamps. Nothing failed in CI during that window, because no start smoke ran on the WebAssembly build.

## False positives and false negatives

- **Possible false positive: the optimized retry.** A method over the limit at tier 0 is compiled once more with optimization on and inlining off. That retry reuses slots only for variables confined to one basic block, so it could fit a method whose extra locals are all block-local. It fitted none of the methods measured, including two just over the limit, so `LIMEN030` says the method "will not run unless the retry happens to fit". A startup smoke is the confirmation.
- **Possible false positive: never-called methods.** A method that is never called never compiles, so it never fails. `wasm-check` reports it anyway. Code that is dead in the browser is better split or removed than left as a trap.
- **Possible false positive: build output that is not the shipped code.** A test-only method, or another configuration's build, can be flagged even though it never ships. Check the configuration and assemblies you ship.
- **Possible false negative: unresolved value types.** These are counted at 8 bytes and reported as a lower bound (`LIMEN032`). Pass `--reference` to resolve them.
- **Possible false negative: open generic parameters.** A method compiled per value-type instantiation can be larger than its shared definition. The estimate counts an open generic parameter as 8 bytes and lists it under `unresolved` on that method.
- **Possible false negative: interpreter temporaries.** At tier 0 the interpreter can add a few temporaries of its own after the IL locals (`alloc_unopt_global_local`). None appeared in the measured methods.
- **Possible false negative: other 16-bit interpreter limits.** These include the per-method data-item index and `g_assert(size < G_MAXUINT16)` on one value type's size. They are different limits and are not checked.
- **Possible false negative: SIMD types.** A SIMD value type such as `Vector128<T>` is aligned to 16, not 8. The estimate uses 8 for it.
- **Not affected: AOT and the jiterpreter.** Neither is part of this check. A fully AOT-compiled method is a WebAssembly function with far larger limits. The jiterpreter compiles traces only after the interpreter's transform has succeeded.

## Running it

- **Locally, or as an agent.** After a Release build, run `npx @echelon-foundry/limen wasm-check <output-dir>`. Read the JSON with `--json`, and treat exit code `3` as "do not ship this build".
- **In CI.** Run it after the guest's `dotnet build -c Release`, pinned to the Limen version the repository records, like `verify`. It needs no browser and no WebAssembly workload.
- **Adopting it in a rehearsal or consumer.** A repository adopts the check by moving its pinned Limen version to a release that includes `wasm-check`. Nothing changes for repositories that do not run it. An active rehearsal keeps the Limen version it pinned; the next rehearsal adopts the check through its own pin.

## Why there is no runtime probe in Limen

The only way to make the interpreter compile a method is to call it. `RuntimeHelpers.PrepareMethod` does not trigger the interpreter's transform: on the failing Causa build, all 1,237 methods prepared without error, and then the first call failed.

The measurements above used a small probe:
- a `Microsoft.NET.Sdk.WebAssembly` executable whose `main` calls each method once inside `try`/`with`;
- a dozen-line Node host that loads `_framework/dotnet.js`, sets the interpreter options and calls `runMain`.

Limen ships no such probe:

- **Limen has no Node-based .NET WebAssembly path.** Its WebAssembly smoke tests (`smoke:site:wasm`, `smoke:guests`) drive real Chromium against Limen's own sample site and minimal guests.
- **A probe has to call an application's methods with real inputs.** That is the application's startup smoke, not a Limen-generic check.

The static check is cheap, deterministic, and exact on every case measured. Behavioural confirmation belongs in the application's startup smoke on the real WebAssembly build. For example, Causa's `tests/browser/start-smoke.spec.js` checks every primary route for "locals size too big".

## Where it lives

- **Core.** `cli/Limen.Core/InterpreterFrame.fs` is the pure core: metadata facts in, findings out. It reads nothing.
- **Shell.** `cli/Limen.Core/GuestAssemblies.fs` is the shell. It reads assemblies with System.Reflection.Metadata, which is part of the shared framework, so the check adds no dependency.
- **CLI.** `cli/Limen.Cli/` holds the argument parsing and rendering.
- **Tests.** `cli/tests/Limen.Core.Tests/InterpreterFrameTests.fs` records the measured figures above as tests.
- **Examples.** `cli/tests/InterpreterFrame.Examples/` holds the controlled examples. They are not built by `npm run test:cli`, because their shape depends on the F# compiler version.

The check is a separate command rather than a `verify` or `doctor` finding:

- `verify` and `doctor` inspect a repository's installation and engine source, and run before anything is built.
- `wasm-check` needs build output, which only the guest's build produces. A separate read-only command lets a CI job run it right after `dotnet build` without changing what `verify` means.
- An MSBuild target in the guest package was not chosen. It would need the CLI, or a second copy of the analysis, inside every guest build.
