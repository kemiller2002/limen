// The .NET toolchain pin.
//
// This file exists because of a failure it would have caught. `dotnet workload
// install wasm-tools` installs into the feature band of the *resolved* SDK. A
// GitHub runner carries .NET 8, 9 and 10; with nothing pinning the band,
// `dotnet` resolved to 10, the workload installed there, and the net8.0
// browser-wasm publish then failed in a band that had no wasm-tools. The error
// said nothing about SDK bands.
//
// It could not be reproduced locally, because a machine with one SDK installed
// cannot have this bug. That is exactly the kind of divergence a check in the
// ordinary suite is for: these assertions hold identically on one SDK or five,
// and they fail if the pin is deleted or drifts away from what the projects
// target.
//
// Nothing here runs `dotnet`. It reads the files that decide which SDK is
// chosen, so it costs nothing and works on a machine with no .NET at all.
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Every .NET project file in the repository, found rather than listed. */
async function projectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const full = join(directory, entry.name);
    // Build output carries copies of project files; they are not sources.
    if (entry.isDirectory()) {
      return ["bin", "obj", "node_modules", ".git"].includes(entry.name) ? [] : projectFiles(full);
    }
    return /\.(fs|cs)proj$/.test(entry.name) ? [full] : [];
  }));
  return found.flat();
}

const globalJson = JSON.parse(await readFile(join(ROOT, "global.json"), "utf8")) as {
  sdk?: { version?: string; rollForward?: string };
};

describe("the .NET SDK band is pinned", () => {
  test("global.json pins an SDK version", () => {
    // Without this file, `dotnet` uses the newest SDK present. That is
    // machine-dependent, which is the whole problem.
    assert.ok(globalJson.sdk?.version, "global.json must have sdk.version");
    assert.match(globalJson.sdk.version, /^\d+\.\d+\.\d+$/);
  });

  test("the pin rolls forward within its band, so it need not name a patch", () => {
    // An exact pin would fail on any machine lacking that precise SDK, which
    // is a worse failure than the one this file is about. `latestFeature`
    // accepts 8.0.1xx through 8.0.4xx and refuses 9.x.
    assert.equal(globalJson.sdk?.rollForward, "latestFeature");
  });

  test("the pinned band matches what every .NET project targets", async () => {
    const pinned = globalJson.sdk!.version!.split(".").slice(0, 2).join(".");
    const projects = await projectFiles(ROOT);

    // A guard on the guard: if this found nothing, the assertions below would
    // all pass vacuously and the file would be worthless.
    assert.ok(projects.length >= 4, `expected to find .NET projects, found ${projects.length}`);

    for (const project of projects) {
      const contents = await readFile(project, "utf8");
      const target = /<TargetFramework>net([\d.]+)<\/TargetFramework>/.exec(contents);
      assert.ok(target, `${relative(ROOT, project)} has no <TargetFramework>`);
      assert.equal(
        target[1],
        pinned,
        `${relative(ROOT, project)} targets net${target[1]} but global.json pins ${pinned}. `
        + "Upgrading one without the other means the workload installs into a band the build does not use.",
      );
    }
  });
});

describe("the workflows resolve the SDK from the pin", () => {
  test("every setup-dotnet that precedes a workload install reads global.json", async () => {
    // Naming a version in the workflow instead would reintroduce the bug in a
    // second place: `dotnet-version: 8.0.x` installs an 8.0 SDK but does not
    // stop `dotnet` resolving a newer one that is already on the runner.
    const workflows = join(ROOT, ".github", "workflows");
    for (const name of await readdir(workflows)) {
      const contents = await readFile(join(workflows, name), "utf8");
      if (!contents.includes("dotnet workload install")) continue;
      assert.match(
        contents,
        /global-json-file:\s*global\.json/,
        `${name} installs a .NET workload, so its setup-dotnet must resolve the SDK from global.json`,
      );
    }
  });
});
