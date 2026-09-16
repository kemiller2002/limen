#!/usr/bin/env node
// The npm bootstrap for the Limen CLI.
//
// This file exists to launch a program, not to be one. It picks the binary
// matching the host platform, hands over the arguments unchanged, and returns
// whatever exit code that binary returned.
//
// It deliberately contains no lifecycle logic. It does not know what `init`
// does, what a valid installation looks like, what files are managed, or what
// any exit code means. All of that lives in the F# core, so that there is
// exactly one implementation of it rather than one per distribution channel.

import { spawnSync } from "node:child_process";
import { accessSync, constants, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Exit codes are the F# tool's contract; these two are the only ones the
// launcher can produce on its own. They match ExitCodes.fs.
const UNSUPPORTED_PLATFORM = 7;
const INTERNAL_FAILURE = 1;

const RUNTIME_IDENTIFIERS = {
  "win32:x64": "win-x64",
  "linux:x64": "linux-x64",
  "linux:arm64": "linux-arm64",
  "darwin:x64": "osx-x64",
  "darwin:arm64": "osx-arm64",
};

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeIdentifier = RUNTIME_IDENTIFIERS[`${process.platform}:${process.arch}`];

if (!runtimeIdentifier) {
  process.stderr.write(
    `limen: no build is available for ${process.platform}-${process.arch}.\n` +
      `Supported platforms: ${Object.values(RUNTIME_IDENTIFIERS).join(", ")}.\n`,
  );
  process.exit(UNSUPPORTED_PLATFORM);
}

const executable = join(
  packageRoot,
  "runtimes",
  runtimeIdentifier,
  process.platform === "win32" ? "limen.exe" : "limen",
);

if (!existsSync(executable)) {
  process.stderr.write(
    `limen: the ${runtimeIdentifier} binary is missing from this package (expected ${executable}).\n` +
      `This is a packaging fault rather than something you can fix locally; please report it.\n`,
  );
  process.exit(UNSUPPORTED_PLATFORM);
}

// npm preserves the executable bit, but a package extracted by other means may
// not. Restoring it is launch mechanics, not a decision about the repository.
try {
  accessSync(executable, constants.X_OK);
} catch {
  try {
    chmodSync(executable, 0o755);
  } catch {
    // Fall through: the spawn below reports the real problem more precisely
    // than a guess made here would.
  }
}

const result = spawnSync(executable, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  process.stderr.write(`limen: could not start ${executable}: ${result.error.message}\n`);
  process.exit(INTERNAL_FAILURE);
}

// A process killed by a signal has no exit code. Reporting the conventional
// 128+signal keeps "why did it stop?" answerable from the exit status alone.
process.exit(result.status ?? (result.signal ? 128 : INTERNAL_FAILURE));
