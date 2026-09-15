/// Help text.
///
/// This is public documentation that happens to live in the binary. It is kept
/// here as data so a test can assert that every command the parser accepts has
/// help, and that the README and this text describe the same flags.
module Limen.Cli.Help

open Limen.Core

let general =
    """limen — Limen repository lifecycle

Limen is an explicit boundary that keeps browser capabilities separate from
application authority. This tool installs that boundary into a repository,
verifies it, diagnoses it, and upgrades it.

USAGE
  npx @echelon-foundry/typescript-wasm-kernel <command> [options]

COMMANDS
  init       Bring the repository into a valid installed state. Idempotent.
  status     Report installation and verification state. Read-only.
  verify     Check that the boundary and installation are valid. Read-only.
  upgrade    Move an existing installation to this version of the tool.
  doctor     Explain what is wrong and how to fix it. Read-only.

OPTIONS
  --json     Emit machine-readable JSON on stdout and nothing else.
  --verbose  Include the remedy for each problem (doctor always shows them).
  --root P   Operate on the repository at P instead of the current directory.
  --help     Show help. Works per command: `limen init --help`.
  --version  Print the version of this tool.

EXIT CODES
  0  success                      4  not installed / incompatible installation
  1  internal failure             5  upgrade blocked by a local change
  2  invalid arguments            6  prerequisite failure
  3  verification failed          7  unsupported platform

Documentation: https://github.com/kemiller2002/typescript-wasm-kernel
"""

let init =
    """limen init — bring the repository into a valid installed state

USAGE
  limen init [--dry-run] [--check] [--json] [--verbose] [--root PATH]

WHAT IT DOES
  Creates limen.config.json (yours to edit) if it is absent, installs the
  Limen verification workflow, and writes the installation manifest at
  .echelon/limen.json.

WHAT IT WILL NOT DO
  It never overwrites a file you have edited, and never overwrites a file that
  was present before Limen arrived. Those are recorded as preserved and are
  left alone for the life of the installation.

IDEMPOTENCY
  Running init twice makes no second round of changes. The second run reports
  that nothing was needed and exits 0.

OPTIONS
  --dry-run  Calculate and report the full plan; change nothing.
  --check    As --dry-run, but exit 3 if anything would change. For CI.

EXAMPLES
  npx @echelon-foundry/typescript-wasm-kernel init
  npx @echelon-foundry/typescript-wasm-kernel init --dry-run --json
"""

let status =
    """limen status — report installation and verification state

USAGE
  limen status [--json] [--verbose] [--root PATH]

WHAT IT DOES
  Reports the tool and package name, the CLI version, the installed version,
  the configuration version, how many artifacts are managed, and whether
  verification currently passes.

SIDE EFFECTS
  None. status never writes to the repository.

EXIT CODES
  0  a valid installation was found
  4  not installed, or the installation is not valid

EXAMPLES
  npx @echelon-foundry/typescript-wasm-kernel status
  npx @echelon-foundry/typescript-wasm-kernel status --json
"""

let verify =
    """limen verify — check that the boundary and installation are valid

USAGE
  limen verify [--strict] [--json] [--verbose] [--root PATH]

WHAT IT CHECKS
  That the manifest and configuration are present, readable and a version this
  CLI understands; that every file the manifest records still exists; and that
  engine code does not reach for the browser while kernel code is the only
  place that does.

STRICT
  --strict additionally requires that tool-owned files have not been edited
  locally, that every configured boundary directory exists, and that the
  installed version matches the CLI.

SIDE EFFECTS
  None. verify never writes to the repository.

EXIT CODES
  0  valid
  3  invalid — every reason is listed

EXAMPLES
  npx @echelon-foundry/typescript-wasm-kernel verify --strict
  npx @echelon-foundry/typescript-wasm-kernel verify --json
"""

let upgrade =
    """limen upgrade — move an installation to this version of the tool

USAGE
  limen upgrade [--dry-run] [--check] [--json] [--verbose] [--root PATH]

WHAT IT DOES
  Runs each configuration migration in order, updates tool-owned files whose
  content has changed, and rewrites the manifest.

WHAT IT WILL NOT DO
  If a tool-owned file has been edited since Limen wrote it, upgrade stops and
  changes nothing. It names the file and what to do. Nothing is half-applied.

OPTIONS
  --dry-run  Calculate and report the full plan; change nothing.
  --check    As --dry-run, but exit 3 if anything would change.

EXIT CODES
  0  upgraded, or already current
  4  nothing is installed to upgrade
  5  blocked by a local change — nothing was written

EXAMPLES
  npx @echelon-foundry/typescript-wasm-kernel upgrade --dry-run
  npx @echelon-foundry/typescript-wasm-kernel upgrade
"""

let doctor =
    """limen doctor — explain what is wrong and how to fix it

USAGE
  limen doctor [--json] [--verbose] [--root PATH]

WHAT IT DOES
  Runs every check, including the strict ones, and explains each finding with
  a remedy. Findings are classified:

    error        the capability is broken or the boundary is violated
    warning      allowed, but it will affect a later upgrade
    information  worth knowing; nothing is wrong

SIDE EFFECTS
  None. doctor never writes to the repository.

EXIT CODES
  0  no errors — warnings and information may still be reported
  3  at least one error

EXAMPLES
  npx @echelon-foundry/typescript-wasm-kernel doctor
  npx @echelon-foundry/typescript-wasm-kernel doctor --json
"""

/// Help for one topic, or the general help when the topic is unknown.
let forTopic (topic: string option) =
    match topic with
    | Some "init" -> init
    | Some "status" -> status
    | Some "verify" -> verify
    | Some "upgrade" -> upgrade
    | Some "doctor" -> doctor
    | _ -> general

/// Every command name that has its own help page. Used by the tests to prove
/// the parser and the documentation cover the same set.
let topics = [ "init"; "status"; "verify"; "upgrade"; "doctor" ]

let versionLine (version: string) = sprintf "%s %s" Paths.toolName version
