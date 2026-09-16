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
  const verbose = process.env.LIMEN_WASM_VERBOSE === "1";
  try {
    execFileSync("dotnet", ["publish", PROJECT, "-c", "Release", "--nologo"], {
      cwd: ROOT,
      // Captured rather than discarded, because `dotnet` writes build errors to
      // STDOUT. An earlier version ignored stdout to keep the log quiet, and a
      // CI failure then reported nothing at all beyond a non-zero exit — the
      // one moment the output was worth having.
      stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    if (output.length > 0) console.error(output);
    // The failure this has actually produced, named rather than left to be
    // rediscovered: workloads install into the band of the resolved SDK.
    console.error("\n`dotnet publish` failed. If the error mentions a missing workload or an"
      + "\nunknown `browser-wasm` runtime identifier, check that the SDK resolved here is"
      + "\nthe one `wasm-tools` was installed into — `dotnet --version` and `dotnet workload"
      + "\nlist` must agree on the feature band. global.json pins it; a machine with several"
      + "\nSDKs installed will otherwise use the newest.");
    // Exit rather than rethrow: the thrown error carries the captured output as
    // properties, and Node would print the compiler's diagnostics a second and
    // third time underneath a stack trace that points at this script rather
    // than at the F# that failed to compile.
    process.exit(1);
  }

  if (!existsSync(BUNDLE)) throw new Error(`dotnet publish produced no bundle at ${BUNDLE}`);

  await rm(STAGED, { recursive: true, force: true });
  await mkdir(STAGED, { recursive: true });
  await cp(BUNDLE, STAGED, { recursive: true });

  const bytes = await totalBytes(STAGED);
  console.log(`Wasm engine staged at site/wasm/ — ${(bytes / 1_048_576).toFixed(1)} MB on disk.`);
}

await main();
