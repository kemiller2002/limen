# Conversion report: the Echelon lifecycle interface

A point-in-time record of adding the standard Echelon Foundry lifecycle CLI
(`init`, `status`, `verify`, `upgrade`, `doctor`) to this repository. Work item
**WI-0006**.

For how to *use* the tool, read [the lifecycle CLI](20-lifecycle-cli.md) and
[installation and upgrade](21-installation-and-upgrade.md) instead — this
document is about what changed and what was proven.

## 1 · Repository audited

`kemiller2002/typescript-wasm-kernel` — the Limen browser kernel, published as
`@echelon-foundry/typescript-wasm-kernel`. It also hosts a ROS research
framework and an SDE methodology install.

## 2 · Previous installation mechanism

**There was none.** Before this change the package was a library only: consumers
ran `npm install` and imported from four entry points. There was no `bin`, no
CLI, no installer, and no installation state of any kind. Nothing existed that a
lifecycle command could break.

Two sibling Echelon tools *had* installed themselves into this repository, and
their conventions were followed rather than reinvented:

| Tool | Manifest | Notable convention |
| --- | --- | --- |
| ROS | `.ros/installation.json` | per-file `sha256`, `managed`, and `disposition` (`installed` / `preserved-existing`) |
| SDE | `.sde/MANIFEST.json` | `schemaVersion`, package name, per-file `sha256` |

The `disposition` idea is taken directly from ROS.

## 3 · Compatibility constraints identified

| Constraint | How it was honored |
| --- | --- |
| Four published entry points (`.`, `/protocol`, `/kernel`, `/reference-engine`) | untouched; verified from the installed tarball |
| Public API symbols (`BrowserKernel`, `EngineTransport`, …) | untouched |
| `npm run check` must work without new prerequisites | it does; .NET is needed only for CLI work |
| `scripts/check-architecture.ts` is the repository's own gate | unchanged; the F# check is additive |
| `dist/main.*` must not ship (finding D-9) | still absent; asserted in the publish workflow |
| ROS `validate` requires work-item attribution | WI-0006 opened before editing, completed after |

## 4 · New architecture

```text
npm / npx
   │
   ▼
bin/limen.js            ← selects a platform binary, forwards argv, returns exit code
   │
   ▼
cli/Limen.Cli           ← argument parsing and rendering only
   │
   ▼
cli/Limen.Core          ← the entire lifecycle domain
   │
   ├── Paths / ExitCodes / Types      the contract
   ├── Json / Hashing                 primitives
   ├── Manifest / Configuration       serialization
   ├── Assets                         what gets installed
   ├── Boundary                       the invariant
   ├── Inspect                        the only module that reads to decide
   ├── State / Migrations / Planning  the only modules that decide
   ├── Execute                        the only module that writes
   ├── Diagnose                       explanation
   └── Operations                     the public API
```

The pipeline is `inspect → plan → validate → execute → verify`. Planning is a
pure function of a `RepositorySnapshot`, which is why `--dry-run` is the same
plan rather than a second code path that could disagree with the real one.

## 5 · F# project structure

| Project | Purpose |
| --- | --- |
| `cli/Limen.Core/Limen.Core.fsproj` | domain; trim- and AOT-clean, no reflection |
| `cli/Limen.Cli/Limen.Cli.fsproj` | the executable, `AssemblyName=limen` |
| `cli/tests/Limen.Core.Tests/Limen.Core.Tests.fsproj` | 95 tests (xunit) |

Placed under `cli/` rather than `src/` deliberately: `src/` is the published
TypeScript library governed by the engine/kernel rule, and mixing a second
language into it would muddy that rule. This is the documented deviation from
the mission's suggested `src/<Tool>.Core` layout.

Warnings are errors in every project, so a non-exhaustive match on a lifecycle
union cannot compile.

## 6 · Node bootstrap structure

`bin/limen.js`, 78 lines including comments. It maps `process.platform` +
`process.arch` to a runtime identifier, resolves the binary, restores the
executable bit if the extraction lost it, spawns with `stdio: "inherit"`, and
exits with the child's status. It contains **no** lifecycle logic: it does not
know what `init` does, what a valid installation is, or what any exit code
means beyond the two it can produce itself (`7` unsupported platform, `1` spawn
failure).

## 7 · Files added

```text
bin/limen.js
cli/Limen.Core/{Paths,ExitCodes,Types,Json,Hashing,Manifest,Configuration,
                Assets,Boundary,Inspect,State,Migrations,Planning,Execute,
                Diagnose,Operations}.fs + Limen.Core.fsproj
cli/Limen.Cli/{Args,Help,Render,Program}.fs + Limen.Cli.fsproj
cli/tests/Limen.Core.Tests/{BoundaryTests,ManifestTests,PlanningTests,
                            LifecycleTests,CliTests}.fs + .fsproj
scripts/build-cli.ts
test/cli.test.ts
docs/20-lifecycle-cli.md
docs/21-installation-and-upgrade.md
docs/22-lifecycle-conversion-report.md
```

## 8 · Files changed

| File | Change |
| --- | --- |
| `package.json` | added `bin`, `runtimes`/`bin` to `files`, CLI scripts, keywords; rewrote `description`; `prepack` now builds the binaries |
| `.github/workflows/ci.yml` | .NET setup, F# tests, CLI build, and a 3-OS `packaged-cli` matrix |
| `.github/workflows/publish.yml` | .NET setup; packs, asserts every platform binary is present, installs the archive into a throwaway repository and runs the quick start before publishing |
| `.gitignore` | `runtimes/`, `cli/**/bin/`, `cli/**/obj/` |
| `scripts/check-docs.ts` | prose path checking extended to `cli/` and `bin/` |
| `README.md` | lifecycle CLI section, docs table, requirements, development commands |
| `CLAUDE.md` | where the CLI lives, its layering rule, and the .NET note |
| `docs/README.md` | index entries for 20 and 21 |
| `docs/DOCUMENTATION-AUDIT.md` | corrected the ".NET unavailable" entry |

## 9 · Files intentionally not changed

- `src/**` — the entire published library. Not one line.
- `scripts/check-architecture.ts` — the repository's own gate, deliberately left
  as it is so that adding the CLI could not change what this repository enforces
  about itself.
- `.ros/`, `.sde/`, `framework/`, `schemas/`, `templates/` — owned by other
  tools.
- `index.html`, `examples/**`, `site/**`, `test/*.test.ts` except the new file.

## 10 · Compatibility measures

Adding the CLI is additive in every respect. The one measurable cost is package
size — see [§31](#31-known-limitations).

Verified against the packed archive, not the source tree:

```text
@echelon-foundry/typescript-wasm-kernel            -> [BrowserKernel, DirectTypeScriptTransport,
                                                       PROTOCOL_VERSION, ReferenceEngine, project]
@echelon-foundry/typescript-wasm-kernel/protocol   -> [PROTOCOL_VERSION]
@echelon-foundry/typescript-wasm-kernel/kernel     -> [BrowserKernel]
@echelon-foundry/typescript-wasm-kernel/reference-engine -> [DirectTypeScriptTransport]
```

Identical to before. Type declarations present. `dist/main.*` still absent.

## 11 · Supported commands

`init`, `status`, `verify`, `upgrade`, `doctor`, plus `--help` (general and
per-command) and `--version`. Flags: `--json`, `--verbose`, `--root`,
`--dry-run`, `--check`, `--strict`. Unknown flags are rejected, not ignored.

## 12 · Installation-state model

```fsharp
type InstallationState =
    | NotInstalled
    | Installed of InstalledVersion
    | UpgradeRequired of InstalledVersion * AvailableVersion
    | Invalid of InstallationProblem list
```

Four mutually exclusive cases, so "installed but also broken" cannot be written
down. An installation that is both out of date and broken reports as broken,
because that is what needs attention first.

Installation validity and boundary compliance are tracked separately: a
`document` in an engine file is a repository problem, not a broken install, and
conflating them would make `status` misreport.

## 13 · File ownership model

`ToolOwned` · `Generated` · `UserOwned` · `Shared`, crossed with a disposition of
`InstalledByTool` or `PreservedExisting`. Full semantics in
[installation and upgrade](21-installation-and-upgrade.md#file-ownership).

The rule that makes it work: **the manifest hash records what the tool last
wrote or adopted, never what is on disk now.**

## 14 · Manifest schema

`.echelon/limen.json`, `schemaVersion: 1`. Fields: `tool`, `package`,
`installedVersion`, `configurationVersion`, `managedArtifacts[]` of
`{path, ownership, disposition, sha256}`, sorted by path. No secrets, no
machine-specific data, no timestamps. A newer `schemaVersion` is refused rather
than guessed at.

## 15 · Upgrade / migration model

Ordered single-step chains (`1 → 2`, `2 → 3`), applied in order, stopping at the
first failed precondition. Migrations run against the configuration value in
memory, so a refusal leaves nothing half-written.

**The shipped registry is empty**, and a test asserts that. Version 1 is the only
configuration version that has existed. The chain engine is exercised against
invented chains in the tests rather than shipping a fabricated migration.

## 16 · JSON / machine interface

`--json` emits one document on stdout and nothing else; human messages go to
stderr. Every document carries `schemaVersion` (1) and `command`. One problem
shape is shared by every command. Schemas and problem codes are tabulated in
[the CLI reference](20-lifecycle-cli.md#json-output).

## 17 · Exit-code contract

`0` success · `1` internal failure · `2` invalid arguments · `3` verification
failed · `4` not installed / incompatible · `5` migration blocked · `6`
prerequisite failure · `7` unsupported platform. Documented in `--help`, in the
CLI reference, and asserted by tests.

## 18–20 · npm identity and metadata

| Field | Value |
| --- | --- |
| Package | `@echelon-foundry/typescript-wasm-kernel` (unchanged) |
| Executables | `limen`, and `typescript-wasm-kernel` so bare `npx <package>` resolves |
| Description | rewritten to describe the capability, covering both library and CLI |
| Keywords | added `limen`, `echelon-foundry`, `cli`, `repository-tooling`, `verification` |
| `engines` | `node >= 22`, matching what CI tests |
| `files` | allow-list only; there is no `.npmignore`, so publish behavior is unambiguous |
| `os` / `cpu` | deliberately **not** set — one package must install everywhere and let the launcher choose |

## 21 · Exact package contents

38 files, 27.8 MB packed, 64.7 MB unpacked:

```text
package/LICENSE, README.md, architecture.yaml, package.json
package/bin/limen.js
package/dist/**                       (library, 32 files; dist/main.* absent)
package/runtimes/{linux-x64,linux-arm64,win-x64,osx-x64,osx-arm64}/limen[.exe]
```

Scanned for `.env`, secrets, tokens, credentials, keys, `.npmrc`, `node_modules`,
`.ros/`, `.sde/` — none present.

## 22 · Supported platforms

Linux x64, Linux arm64, Windows x64, macOS x64, macOS arm64. Self-contained: no
.NET runtime needed. Anything else exits `7` naming the platform and listing what
is supported.

## 23–24 · Build and test process

```sh
npm ci                     # dependencies
npm run build              # library → dist/
npm run build:cli          # CLI binary for this platform    (needs .NET SDK 8)
npm run build:cli:all      # all five platform binaries      (needs .NET SDK 8)
npm run test:cli           # dotnet test — the F# lifecycle core
npm run check              # library + examples + site + docs + all node tests
```

## 25 · Package artifact test results

All executed, all passing:

| Check | Result |
| --- | --- |
| `npm run check` | exit 0 — **108 tests, 108 pass, 0 fail, 0 skipped** |
| `dotnet test` (F# core) | exit 0 — **95 tests** |
| `test/cli.test.ts` against the real binary | exit 0 — **20 tests** |
| `npm pack` | exit 0 — 38 files, 27.8 MB |
| tarball installed into a clean git repository | `init`, second `init`, `status`, `verify --strict`, `doctor`, `upgrade` all behaved as documented |
| library entry points from that install | unchanged |
| `--version` vs `package.json` | `limen 0.4.1` = `0.4.1` |
| `--help` flags and commands vs `docs/20-lifecycle-cli.md` | agree |
| idempotency | repository fingerprint byte-identical across two `init` runs |
| `--dry-run` | fingerprint unchanged; no manifest created |
| skip visibility | with no binary: 1 test, 0 pass, **1 skipped** — not silently absent |
| `./ros validate` | validation passed |

The `packaged-cli` matrix has since run on branch head `4351cfe`, green on all
three runners, with the real binary exercised through the npm bootstrap:

| Runner | Binary exercised | Result |
| --- | --- | --- |
| `ubuntu-latest` | `linux-x64/limen` | 20 tests, 20 pass, 0 skipped |
| `windows-latest` | `win-x64/limen.exe` | 20 tests, 20 pass, 0 skipped |
| `macos-latest` (arm64) | `osx-arm64/limen` | 20 tests, 20 pass, 0 skipped |

`0 skipped` is the number that matters: the suite is written to skip itself when
no binary is present, so a green job with tests skipped would have proven
nothing. The counts were read from the job logs, not inferred from the tick.

Two shipped binaries are **cross-published but never executed**: `linux-arm64`
and `osx-x64`. GitHub's hosted runners cover neither (`macos-latest` is arm64).
They compile and are packaged; they have not been run.

## 26 · Publishing process

Unchanged in shape: tag `vX.Y.Z` → `publish.yml` → npm Trusted Publishing over
GitHub OIDC, no stored token. Now additionally installs .NET, runs the F# tests,
packs the archive, asserts every platform binary is inside it, installs that
archive into a throwaway repository, runs the documented quick start, and only
then publishes — the tested artifact itself, not a re-pack.

## 27–28 · Documentation

Added `docs/20-lifecycle-cli.md`, `docs/21-installation-and-upgrade.md`, and this
report; updated `README.md`, `CLAUDE.md`, `docs/README.md`, and the corrected
entry in `docs/DOCUMENTATION-AUDIT.md`.

**No documentation was removed or marked legacy, because none contradicted the
new interface** — there was no previous installation mechanism to deprecate. The
one stale statement found anywhere in the repository was the ".NET toolchain
unavailable" entry, which was corrected in place with the evidence.

## 29 · README as an npm page

Reviewed as a newcomer would see it on npm: the CLI section leads with the five
commands, states what `init` creates and what it refuses to touch, and links to
the reference. No internal references, no "see the other repo", no unlinked
context.

## 30 · Public examples tested

Every command shown in the README and in `docs/20-lifecycle-cli.md` was run
against the packed archive in a clean repository, not a developer checkout.

## 31 · Known limitations

1. **Package size.** 27.8 MB compressed, up from roughly 100 KB. A consumer who
   only imports the library downloads five platform binaries. Mitigation is
   known — per-platform `optionalDependencies`, the `esbuild` model — but it
   means publishing five more package names, so it is recorded as an open
   question rather than decided unilaterally.
2. **The boundary check is lexical.** It strips comments and string literals and
   matches whole words. It cannot see indirection, computed property access, or
   browser access reached through another package. A guard rail, not a proof.
3. **No `uninstall` command.** Removal is three `rm`s, documented.
4. **Two of the five shipped binaries have never been run.** `linux-arm64` and
   `osx-x64` are cross-published and packaged but unexercised, because GitHub's
   hosted runners cover neither. Linux x64, Windows x64 and macOS arm64 are
   proven (§25).
5. **The F# check and the legacy TypeScript check differ by design** on comments
   and string literals. Both are documented; the legacy one still gates this
   repository.

## 32 · Future work

- Decide the package-size question above.
- Expose `Limen.Core` as a typed integration assembly so ROS can call the
  lifecycle without a process boundary. The API in `Operations.fs` was shaped
  for this and needs no CLI to be useful.
- Port `scripts/build-site.ts`, `check-site.ts` and `check-docs.ts` to F# now
  that the toolchain is known to work here.
- Retire `scripts/check-architecture.ts` in favour of `limen verify` once the
  two have run side by side long enough to trust the difference.

## 33 · Remaining inconsistencies

- The package is named for WebAssembly and contains none; the product is Limen
  and the manifest says `"tool": "limen"` while `"package"` says
  `typescript-wasm-kernel`. Pre-existing, recorded as findings A-2 and N-1 in
  [the audit](DOCUMENTATION-AUDIT.md), and deliberately not resolved here.
- `.echelon/` is the convention this tool follows, but `.ros/` and `.sde/` in
  this same repository predate it and keep their own locations. Aligning them is
  those packages' decision, not this one's.
