// Publish the F# lifecycle CLI into runtimes/<rid>/ for packaging.
//
// This is packaging, not lifecycle logic: it compiles and copies, and makes no
// decision about what a repository needs. The version is read from package.json
// and stamped into the assembly, so there is one authoritative version rather
// than a constant in the F# source that someone has to remember to bump.

import { spawnSync } from "node:child_process";
import { readFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Every platform the npm package ships a binary for. */
const RUNTIME_IDENTIFIERS = ["linux-x64", "linux-arm64", "win-x64", "osx-x64", "osx-arm64"] as const;

type RuntimeIdentifier = (typeof RUNTIME_IDENTIFIERS)[number];

const PROJECT = "cli/Limen.Cli/Limen.Cli.fsproj";

/** The runtime identifier for the machine running this script. */
const currentRuntimeIdentifier = (): RuntimeIdentifier | undefined => {
  const key = `${process.platform}:${process.arch}`;
  const map: Record<string, RuntimeIdentifier> = {
    "linux:x64": "linux-x64",
    "linux:arm64": "linux-arm64",
    "win32:x64": "win-x64",
    "darwin:x64": "osx-x64",
    "darwin:arm64": "osx-arm64",
  };
  return map[key];
};

const version = async (): Promise<string> =>
  JSON.parse(await readFile("package.json", "utf8")).version;

const publish = (runtime: RuntimeIdentifier, packageVersion: string): void => {
  const output = join("runtimes", runtime);

  const result = spawnSync(
    "dotnet",
    [
      "publish",
      PROJECT,
      "-c",
      "Release",
      "-r",
      runtime,
      `-p:Version=${packageVersion}`,
      "-o",
      output,
      "--nologo",
      "-v",
      "quiet",
    ],
    { stdio: "inherit", env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_NOLOGO: "1" } },
  );

  if (result.status !== 0) {
    throw new Error(`dotnet publish failed for ${runtime} (exit ${result.status})`);
  }
};

/** Symbols and host artifacts are not needed at runtime and should not ship. */
const prune = async (runtime: RuntimeIdentifier): Promise<void> => {
  const directory = join("runtimes", runtime);
  const entries = await readdir(directory);
  const keep = runtime.startsWith("win") ? "limen.exe" : "limen";

  await Promise.all(
    entries.filter((entry) => entry !== keep).map((entry) => rm(join(directory, entry), { recursive: true, force: true })),
  );
};

const main = async (): Promise<void> => {
  const packageVersion = await version();
  const onlyCurrent = process.argv.includes("--current");

  const targets = onlyCurrent
    ? [currentRuntimeIdentifier()].filter((value): value is RuntimeIdentifier => value !== undefined)
    : [...RUNTIME_IDENTIFIERS];

  if (targets.length === 0) {
    throw new Error(`no runtime identifier is defined for ${process.platform}-${process.arch}`);
  }

  for (const runtime of targets) {
    publish(runtime, packageVersion);
    await prune(runtime);

    const expected = join("runtimes", runtime, runtime.startsWith("win") ? "limen.exe" : "limen");
    if (!existsSync(expected)) throw new Error(`expected ${expected} to exist after publish`);
  }

  console.log(`Built the Limen CLI ${packageVersion} for: ${targets.join(", ")}`);
};

await main();
