# Installation, ownership, and upgrade

What `init` does to your repository, which files are yours, and what an upgrade
is allowed to change. If you want to know whether running `init` is safe without
reading the source, this is the page.

The commands themselves are documented in [the lifecycle CLI](20-lifecycle-cli.md).

## What `init` means

> **`init` means: bring this repository into a valid installed state.**
> It does not mean "copy some files in".

The tool inspects what is there, works out what a valid installation looks like,
calculates the difference, checks that difference for conflicts, and only then
writes anything. That sequence is the same on the first run and the hundredth.

```text
inspect  →  determine desired state  →  calculate transition
         →  validate transition  →  execute  →  verify result
```

`--dry-run` stops after "validate transition". It is not a second code path that
might disagree with the real one — it is the same plan, not executed.

## Idempotency

Running `init` twice produces no second round of changes. The second run reports
that nothing was needed and exits `0`.

This is enforced by tests at two levels: the planner returns an empty plan for an
already-installed repository, and an end-to-end test fingerprints every file in
the repository, runs `init` again, and requires the fingerprint to be identical.

This is why the manifest records no timestamp. A timestamp would make two
identical installations differ, which would quietly make the guarantee false.

## File ownership

Every managed file has an ownership classification. It decides what an upgrade
may do to that file.

| Ownership | Meaning | May the tool rewrite it? |
| --- | --- | --- |
| **tool-owned** | Limen controls the content | Yes — if you have not edited it |
| **generated** | derived from authoritative inputs | Yes — regenerated at any time |
| **user-owned** | the repository controls it | Never, except through a migration |
| **shared** | written by the tool, expected to be edited | Only through a migration |

As installed today:

| Path | Ownership |
| --- | --- |
| `limen.config.json` | user-owned |
| `.github/workflows/limen-verify.yml` | tool-owned |
| `.echelon/limen.json` | tool-owned |

Ownership is recorded in the manifest **at install time**, so a later version of
the CLI cannot silently reinterpret what you agreed to.

## Disposition: who put the file there

Ownership alone is not enough. A tool-owned file that differs from the tool's
copy might be your customization or a stale copy from an older release, and
guessing wrong either destroys your work or freezes your repository.

So each managed file also records a **disposition**:

| Disposition | Meaning |
| --- | --- |
| `installed` | Limen created the file. It may be updated if you have not edited it. |
| `preserved-existing` | the file was already there. Limen adopted it and will never overwrite it. |

If you already have a `.github/workflows/limen-verify.yml` when you run `init`,
Limen keeps yours and records it as `preserved-existing` — permanently.

## The installation manifest

`.echelon/limen.json`. The presence of files is never the source of truth; this
is.

```json
{
  "schemaVersion": 1,
  "tool": "limen",
  "package": "@echelon-foundry/typescript-wasm-kernel",
  "installedVersion": "0.4.1",
  "configurationVersion": 1,
  "managedArtifacts": [
    {
      "path": ".github/workflows/limen-verify.yml",
      "ownership": "tool-owned",
      "disposition": "installed",
      "sha256": "…"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | the manifest format. A newer one is refused, not guessed at. |
| `tool` | which Echelon tool owns this file |
| `package` | the npm package it came from |
| `installedVersion` | the CLI version that last wrote this installation |
| `configurationVersion` | the schema version of `limen.config.json` |
| `managedArtifacts` | every file Limen manages, sorted by path |

`sha256` records **what the tool last wrote or adopted** — not what is on disk
now. It changes only when the tool writes the file. That single rule is what
lets a later run tell "the user edited this" from "the tool's copy moved on".
Hashes are taken after normalizing line endings, so a Windows checkout does not
report every file as modified.

The manifest deliberately contains **no secrets, no machine-specific paths, and
no timestamps**.

### The `.echelon/` convention

`.echelon/` is a shared root for Echelon Foundry tooling. Each tool owns one file
in it and must not touch another's. This repository also carries `.ros/` and
`.sde/` from the sibling ROS and SDE installers, which predate the convention and
keep their own locations.

## What an upgrade is allowed to do

`upgrade` considers each managed file and takes exactly one of four actions:

| Situation | Action |
| --- | --- |
| File is missing | recreate it |
| File matches the tool's current copy | nothing |
| File is unedited since Limen wrote it, tool's copy changed | update it |
| File was adopted (`preserved-existing`) | nothing, ever |
| File edited by you, tool's copy unchanged | nothing — your edit stands |
| File edited by you **and** tool's copy changed | **stop, write nothing** |

That second-to-last row matters: customizing a tool-owned file does not freeze
your repository. Upgrades that touch other files continue to work; Limen simply
stops updating the one you took over.

The last row is a conflict. `upgrade` exits `5`, writes nothing at all, and tells
you the file and your options: keep your version (Limen leaves it alone from then
on), or delete it and run `upgrade` again to take the tool's version.

### Migrations

Configuration changes are expressed as an ordered chain of single-step
transitions — `1 → 2`, then `2 → 3` — not one function that tries to understand
every historical shape. Going from 1 to 3 runs both steps in order and stops at
the first whose precondition fails.

Migrations run against the configuration **value**, in memory, before anything
reaches disk. A failed precondition therefore leaves nothing half-written.

**There are no migrations today.** Configuration version 1 is the only version
that has ever existed, so there is no transition to describe. The chain engine is
implemented and tested against invented version chains in the test suite; the
shipped registry is empty, and a test asserts that it is. Inventing a migration
to make the list look populated would put something into the public contract that
no repository will ever need.

## Failure behavior

- A plan carrying conflicts is never executed. Not partially, not at all.
- Each file is written to a temporary file beside its destination and then moved
  into place, so an interrupted write cannot leave a half-written file where a
  complete one used to be.
- Across several files the operation is **not** transactional. Instead a failure
  stops immediately and reports exactly which changes were applied before it, so
  the resulting state is always knowable. Re-running `init` repairs it.
- Every path in a plan is checked before execution; a plan that would write
  outside the repository is refused. That check exists because a manifest is
  repository content, and repository content is not trusted.

## Compatibility

| Guarantee | Scope |
| --- | --- |
| Exit codes | values will not be repurposed; new ones may be added |
| JSON shapes | additive within a `schemaVersion`; a breaking change bumps it |
| Manifest schema | a newer `schemaVersion` is refused rather than guessed at |
| Command names | `init`, `status`, `verify`, `upgrade`, `doctor` are stable |
| File ownership | recorded at install time and honored by later versions |

The package is `0.x`, so the **library** protocol may still change in a minor
release — see [the API reference](11-api-reference.md#stability-and-compatibility).
The lifecycle contract above is treated as stable regardless, because CI jobs and
agents branch on it.

### Adding the CLI broke nothing

The CLI arrived in the same npm package as the library. Adding it changed no
export, no entry point, and no type. This was verified against the packed
archive: all four entry points (`.`, `/protocol`, `/kernel`, `/reference-engine`)
resolve and export exactly the same symbols as before.

The one visible cost is size. The package now carries a self-contained binary for
each of five platforms, which takes it from roughly 100 KB to about 28 MB
compressed. A consumer who only imports the library downloads those binaries too.
The alternative — publishing each platform as its own optional dependency, the
way `esbuild` does — would avoid that, at the cost of five more package names to
publish and keep in step. That trade is recorded in
[the documentation audit](DOCUMENTATION-AUDIT.md) as an open question rather than
decided unilaterally.

## Uninstalling

There is no `uninstall` command. Delete `.echelon/limen.json`,
`limen.config.json`, and `.github/workflows/limen-verify.yml`. Nothing else is
touched, and nothing outside those paths is ever written.
