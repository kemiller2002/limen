# The lifecycle CLI

> **Optional — not Limen Core.** This is the lifecycle CLI, a tooling. It composes with the Core concept `engine-owns-meaning`: it installs and verifies the boundary that keeps meaning in the engine. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Limen ships a command-line tool that installs the Limen boundary into a
repository, verifies it, explains it when it breaks, and upgrades it. It is the
same npm package as the library — installing one gives you both.

```sh
npx @echelon-foundry/typescript-wasm-kernel init
npx @echelon-foundry/typescript-wasm-kernel status
npx @echelon-foundry/typescript-wasm-kernel verify
npx @echelon-foundry/typescript-wasm-kernel upgrade
npx @echelon-foundry/typescript-wasm-kernel doctor
```

Every command in this document was executed against the packed npm archive, not
against a developer checkout. See [§ How this is verified](#how-this-is-verified).

## Executable names

The package installs one program under two names:

| Name | Use |
| --- | --- |
| `limen` | the product name — what you type once the package is installed |
| `typescript-wasm-kernel` | matches the package name, so bare `npx @echelon-foundry/typescript-wasm-kernel` resolves |

They are the same binary. There is no difference in behavior.

## Commands

### `init`

Brings the repository into a valid installed state. It is **idempotent**: running
it twice makes no second round of changes.

> **`init` does not scaffold an application.** It installs the *boundary* — a
> config file, a CI workflow and a manifest — into a repository that already
> exists. It writes no HTML, no engine, and no entry point. To create an
> application, follow [quick-start.md](quick-start.md) or copy
> [`examples/minimal/`](../examples/minimal/README.md); `init` is what you run
> afterwards to keep the boundary enforced.
>
> **Its default config expects directories, not files.** `limen.config.json`
> defaults to `{"engine": ["src/engine"], "kernel": ["src/kernel"]}`. An
> application built exactly as the quick start describes has an `engine.ts` and a
> `main.ts` directly under `src/` — no such directories, and no kernel of its own, because the
> kernel comes from `node_modules`. Edit the config to match your layout
> (`{"engine": ["src"], "kernel": []}` is a reasonable start for a
> single-file engine) rather than reshaping your application to match the
> default. `verify` reports a configured directory that does not exist as
> `LIMEN010`.

```sh
limen init [--dry-run] [--check] [--json] [--verbose] [--root PATH]
```

What it creates:

| Path | Ownership | Notes |
| --- | --- | --- |
| `limen.config.json` | user-owned | your boundary. Created once, then yours. |
| `.github/workflows/limen-verify.yml` | tool-owned | runs `verify --strict` in CI |
| `.echelon/limen.json` | tool-owned | the installation manifest |

What it will **not** do:

- overwrite a file you have edited since Limen wrote it;
- overwrite a file that was already there before Limen arrived;
- touch anything outside those three paths.

Full semantics, including what happens to a file you customize, are in
[installation and upgrade](21-installation-and-upgrade.md).

### `status`

Reports what is installed and whether it is valid. **Read-only** — `status`
never writes to the repository.

```sh
limen status [--json] [--verbose] [--root PATH]
```

```text
Limen (@echelon-foundry/typescript-wasm-kernel)

  CLI version:           0.6.1
  Installed version:     0.6.1
  Configuration:         version 1
  Installation:          installed (0.6.1)
  Managed artifacts:     2
  Verification:          passed
  Upgrade:               up to date
```

Exits `0` when an installation is present, `4` when it is not.

### `verify`

Checks that the installation and the boundary are both intact. **Read-only.**

```sh
limen verify [--strict] [--json] [--verbose] [--root PATH]
```

Always checked:

- the manifest and configuration exist, parse, and are versions this CLI understands;
- every file the manifest records still exists;
- engine code does not acquire browser, JavaScript-interop, network,
  filesystem or process authority, per language — for example `document`,
  `window`, `globalThis`, `navigator`, `fetch(`, `import(` and `node:` imports in
  TypeScript; `System.Runtime.InteropServices.JavaScript`, `JSImport`,
  `Browser.Dom`, `HttpClient`, `System.IO` and `System.Diagnostics.Process` in
  F# and C#; `web_sys`, `wasm_bindgen`, `std::fs` and `std::net` in Rust — and
  uses no dynamic type escape (`any` in TypeScript, `dynamic` in C#);
- no code on either side uses an escape hatch (`eval`, `SetInnerHtml`, `ExecuteScript`);
- the boundary checks *something*: at least one engine path is declared and
  holds source (see [Verdicts](#verdicts)).

The token lists are not written in the CLI. They are
[`architecture/boundary-rules.json`](../architecture/boundary-rules.json) — the
same rule set Limen's own repository guardrails apply to Limen — embedded into
the binary at build time. `verify --json` reports its SHA-256 as
`ruleSet.sha256`. Which of Limen's repository checks consumers do *not* get, and
why, is recorded in
[`architecture/verify-parity.json`](../architecture/verify-parity.json) and
enforced by a test.

`--strict` additionally requires:

- tool-owned files to be byte-identical to what Limen wrote;
- every configured boundary path to exist;
- the installed version to match the CLI.

#### Verdicts

`verify` reaches exactly one verdict, reported as `verdict` in JSON:

| Verdict | Meaning | Exit |
| --- | --- | --- |
| `passed` | engine code was checked and nothing was wrong | `0` |
| `not-applicable` | the configuration declares that this repository has no Limen boundary, with a rationale | `0` |
| `not-configured` | no engine path is declared, or the engine paths hold no source file — **nothing was checked**, which is not a pass (`LIMEN012`) | `8` |
| `failed` | anything else; every reason is listed | `3` |

Before 0.7, an empty boundary (`"engine": [], "kernel": []`) reported
"passed (strict)" while checking nothing. A repository with no browser
application says so explicitly instead:

```json
{
  "configurationVersion": 1,
  "boundary": { "notApplicable": { "rationale": "Documentation site; no browser application." } }
}
```

The rationale must be non-empty, and `notApplicable` cannot be combined with
`engine` or `kernel` paths.

> **What this check can and cannot do.** It is lexical, not type-aware. It
> reads source text with comments and string literals removed, so it catches the
> ways browser access is actually written — not every way it could be smuggled
> in (through a computed property, say, or a helper in another package). It is a
> guard rail, not a proof.

### `upgrade`

Moves an existing installation to the version of the CLI you are running.

```sh
limen upgrade [--dry-run] [--check] [--json] [--verbose] [--root PATH]
```

- Runs each configuration migration in order, stopping at the first whose
  precondition fails.
- Updates tool-owned files whose content changed — but only those you have not
  edited.
- Rewrites the manifest.

If a file has been edited **and** the tool's copy of it has changed, `upgrade`
stops, writes nothing, and tells you which file and what to do. Exits `5`.

Exits `4` if nothing is installed: `upgrade` will not silently perform a first
installation you did not ask for.

### `doctor`

Explains what is wrong and how to fix it. **Read-only.**

```sh
limen doctor [--json] [--verbose] [--root PATH]
```

```text
error       LIMEN002  The installation manifest cannot be read
      .echelon/limen.json could not be parsed: ...
      fix: Restore it from version control, or delete it and run `init`.
```

Findings are classified:

| Severity | Meaning |
| --- | --- |
| `error` | the capability is broken, or the boundary is violated |
| `warning` | allowed, but it will affect a later upgrade |
| `information` | worth knowing; nothing is wrong |

Exits `3` if there is at least one error, `0` otherwise — warnings and
information alone do not fail it.

## Options

| Option | Applies to | Meaning |
| --- | --- | --- |
| `--json` | all | emit JSON on stdout and nothing else |
| `--verbose` | all | include the remedy for each problem — `doctor` always shows them, so it changes nothing there |
| `--root PATH` | all | operate on the repository at `PATH` |
| `--dry-run` | `init`, `upgrade` | calculate and report the plan; change nothing |
| `--check` | `init`, `upgrade` | as `--dry-run`, but exit `3` if anything would change |
| `--strict` | `verify` | see above |
| `--help` | all | per-command help |
| `--version` | — | the version of the tool |

An unknown option is an error, not something ignored. A silently ignored
`--dry-run` would be the most expensive bug this tool could have.

Without `--root`, the repository root is found by walking up from the current
directory to the nearest `.git`. If there is none, the current directory is used
and `doctor` says so.

## Exit codes

These are a stable contract. A value may be added; an existing one will not be
reused for a different meaning.

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | internal failure — a bug; details on stderr |
| `2` | invalid arguments |
| `3` | verification failed, or `--check` found outstanding work |
| `4` | not installed, or an installation this CLI cannot work with |
| `5` | upgrade blocked by a local change — **nothing was written** |
| `6` | prerequisite failure (for example, the repository is not writable) |
| `7` | unsupported platform — no binary ships for this OS and architecture |
| `8` | `verify` checked nothing: the boundary is not configured (`LIMEN012`) |

## JSON output

`--json` puts a single JSON document on stdout and nothing else. Messages
intended for people go to stderr, so `limen status --json | jq` works even when
the command fails.

Every document carries `schemaVersion` (currently `1`) and `command`.

`status --json`:

```json
{
  "schemaVersion": 1,
  "command": "status",
  "tool": "limen",
  "package": "@echelon-foundry/typescript-wasm-kernel",
  "cliVersion": "0.6.1",
  "state": "installed",
  "installedVersion": "0.6.1",
  "availableVersion": null,
  "configurationVersion": 1,
  "managedArtifacts": 2,
  "verification": {
    "ok": true,
    "strict": false,
    "verdict": "passed",
    "rationale": null,
    "checked": { "engineFiles": 12, "kernelFiles": 4 },
    "ruleSet": { "schemaVersion": 1, "sha256": "…" },
    "problems": []
  }
}
```

`state` is one of `not-installed`, `installed`, `upgrade-required`, `invalid`.

`verify --json` and the `problems` array everywhere use one problem shape:

```json
{
  "code": "LIMEN009",
  "severity": "error",
  "title": "The Limen boundary is broken",
  "detail": "src/engine/leak.ts: engine code references the browser capability 'document'",
  "path": "src/engine/leak.ts",
  "remedy": "Application meaning belongs in the engine..."
}
```

`init --json` and `upgrade --json`:

```json
{
  "schemaVersion": 1,
  "command": "init",
  "dryRun": true,
  "applied": false,
  "changed": false,
  "state": "not-installed",
  "changes": [{ "kind": "create-file", "path": "limen.config.json", "description": "..." }],
  "conflicts": [],
  "failure": null,
  "verification": null
}
```

`kind` is one of `create-file`, `update-managed-file`, `update-configuration`,
`register-integration`, `run-migration`, `write-manifest`.

### Problem codes

| Code | Severity | Meaning |
| --- | --- | --- |
| `LIMEN001` | error | not installed |
| `LIMEN002` | error | manifest unreadable |
| `LIMEN003` | error | manifest schema newer than this CLI |
| `LIMEN004` | error | configuration missing |
| `LIMEN005` | error | configuration unreadable |
| `LIMEN006` | error | configuration newer than this CLI |
| `LIMEN007` | error | a managed file is missing |
| `LIMEN008` | warning | a tool-owned file was edited locally |
| `LIMEN009` | error | boundary violation |
| `LIMEN010` | information | a configured directory does not exist yet |
| `LIMEN011` | warning | the installation is older than the CLI |
| `LIMEN012` | error | the boundary checks nothing (no engine path, or no engine source) |
| `LIMEN020` | information | not a git repository |
| `LIMEN021` | error | the repository is not writable |

## Using it in CI

Run the CLI **pinned to the version the repository records** in
`.echelon/limen.json`:

```yaml
- name: Read the Limen version this repository records
  id: limen
  run: echo "version=$(node -p "require('./.echelon/limen.json').installedVersion")" >> "$GITHUB_OUTPUT"

- name: Verify the Limen boundary with that version
  run: npx --yes "@echelon-foundry/typescript-wasm-kernel@${{ steps.limen.outputs.version }}" verify --strict
```

`init` registers exactly this as `.github/workflows/limen-verify.yml`, and
`upgrade` replaces an unedited older copy with it. The same pinned invocation
works locally:

```sh
npx --yes @echelon-foundry/typescript-wasm-kernel@"$(node -p "require('./.echelon/limen.json').installedVersion")" verify --strict
```

Why pinned: an unpinned `npx … verify --strict` runs whatever was published
last, and `--strict` treats an installation older than the CLI as a failure
(`LIMEN011`). Every release would then turn every lagging repository red with
no change of its own. Pinned, the gate is deterministic, and moving to a new
version is an explicit `upgrade` commit (by a person, Conditor or a
dependency bot) that CI verifies at the new version.

Before 0.7 the installed workflow ran unpinned. Its file is tool-owned, so
`npx --yes @echelon-foundry/typescript-wasm-kernel@<new> upgrade` rewrites it in
place unless it was edited; an edited copy is reported and left for you to
change by hand.

To check
that a repository is fully initialized rather than only valid:

```sh
npx @echelon-foundry/typescript-wasm-kernel init --check
```

which writes nothing and exits `3` if any work is outstanding.

## Using it from an agent

- Every command is non-interactive. Nothing prompts, so nothing hangs. This is
  asserted by a test that runs each command with empty stdin under a timeout.
- Prefer `--json`: stdout is a single document, and problems come back as codes
  rather than prose to parse.
- Prefer `--dry-run --json` before acting; the plan lists exactly what would
  change.
- Branch on exit codes, not on message text. Messages may be reworded; codes
  will not be repurposed.
- `upgrade` is the only command that can refuse to act. `5` means nothing was
  written and a human decision is needed.

## Configuration

`limen.config.json` is yours. Limen creates it once and then only ever rewrites
it through an explicit migration.

```json
{
  "configurationVersion": 1,
  "boundary": {
    "engine": ["src/engine"],
    "kernel": ["src/kernel"]
  }
}
```

`engine` lists the directories that own application meaning; `kernel` lists the
only directories permitted to touch the browser. Both accept any number of paths,
so a monorepo can name several, and a path may name a single source file. Build
output and dependency directories (`bin`, `obj`, `node_modules`, `target`,
`publish`, …; the list is `neverWalked` in the rule set) are never read.

Name only code that holds application authority as `engine`: a project that
talks to the network or the filesystem on purpose — a host, an adapter, a CLI —
is not engine code, and listing it there fails `verify`. Test projects that read
fixtures from disk belong outside the engine paths too (Limen lists its Rust
crates' `src/` directories, not the crates).

A repository with no browser application declares
`"boundary": { "notApplicable": { "rationale": "…" } }` instead (see
[Verdicts](#verdicts)).

### Migrating to 0.7

| If your repository… | `verify` now says | Do this |
| --- | --- | --- |
| has `"engine": []` (Limen does not apply) | `not-configured`, exit `8` | replace `boundary` with `{ "notApplicable": { "rationale": "…" } }`, or remove the Limen installation |
| names engine paths with no source yet | `not-configured`, exit `8` | add the engine code, or narrow the paths |
| names engine paths that contain hosts, adapters or tests using `HttpClient`, `System.IO`, `node:` imports and so on | `failed`, `LIMEN009` | move those projects out of `engine` (they are kernel/host side) or move the authority behind an effect |
| runs the old unpinned workflow | unchanged until upgraded | run `upgrade` at the new version and commit; CI is then pinned |

`System.IO` is matched as a namespace, so an engine that opens it only for
`MemoryStream` (typically to feed a `Utf8JsonWriter`) is reported too. Write
JSON through `System.Buffers.ArrayBufferWriter<byte>` (or serialize to a
string) instead; nothing in an engine needs a stream.

## How this is verified

- `cli/tests/Limen.Core.Tests/` tests the lifecycle rules themselves — planning,
  ownership, migrations, the boundary check — with no CLI or package involved.
- `test/cli.test.ts` runs the real binary through the npm bootstrap: exit codes,
  JSON validity, idempotency, dry-run writing nothing.
- The publish workflow packs the archive, asserts every platform binary is
  inside it, installs it into a throwaway repository, and runs the quick start
  before anything is published.

## Supported platforms

| Platform | Binary | Exercised in CI |
| --- | --- | --- |
| Linux x64 | `runtimes/linux-x64/limen` | yes |
| Linux arm64 | `runtimes/linux-arm64/limen` | no — built and packaged, never run |
| Windows x64 | `runtimes/win-x64/limen.exe` | yes |
| macOS x64 | `runtimes/osx-x64/limen` | no — built and packaged, never run |
| macOS arm64 | `runtimes/osx-arm64/limen` | yes |

The two unexercised rows are honest rather than cautious: GitHub's hosted
runners cover neither Linux arm64 nor Intel macOS, so those binaries compile and
ship but have not been executed.

The launcher selects by `process.platform` and `process.arch`. Anything else
exits `7` naming the platform and listing what is supported. No .NET runtime is
required — each binary is self-contained.

Node ≥ 22 is required to run the launcher, matching the package's `engines`
field and what CI tests.
