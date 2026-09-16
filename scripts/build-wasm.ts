// Publishes the F# engine as a WebAssembly app bundle and stages it for the
// site build.
//
// Deliberately thin: `dotnet publish` does the work, and this script only
// decides where the result lands so the site build and the tests can find it
// at one known path. No lifecycle logic belongs here, for the same reason none
// belongs in bin/limen.js.
import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PROJECT = join(ROOT, "wasm", "Limen.Host", "Limen.Host.csproj");
const BUNDLE = join(ROOT, "wasm", "Limen.Host", "bin", "Release", "net8.0", "browser-wasm", "AppBundle");
/** Staged in the site tree so the dev server and the built site share one path. */
const STAGED = join(ROOT, "site", "wasm");

async function totalBytes(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sizes = await Promise.all(entries.map(async (entry) => {
    const full = join(directory, entry.name);
    return entry.isDirectory() ? totalBytes(full) : (await stat(full)).size;
  }));
  return sizes.reduce((total, size) => total + size, 0);
}

async function main(): Promise<void> {
  console.log("Publishing the F# engine to WebAssembly (this takes a minute)…");
  execFileSync("dotnet", ["publish", PROJECT, "-c", "Release", "--nologo"], {
    cwd: ROOT,
    stdio: process.env.LIMEN_WASM_VERBOSE === "1" ? "inherit" : ["ignore", "ignore", "inherit"],
  });

  if (!existsSync(BUNDLE)) throw new Error(`dotnet publish produced no bundle at ${BUNDLE}`);

  await rm(STAGED, { recursive: true, force: true });
  await mkdir(STAGED, { recursive: true });
  await cp(BUNDLE, STAGED, { recursive: true });

  const bytes = await totalBytes(STAGED);
  console.log(`Wasm engine staged at site/wasm/ — ${(bytes / 1_048_576).toFixed(1)} MB on disk.`);
}

await main();
