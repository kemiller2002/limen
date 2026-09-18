// Installs the packed tarball into an empty project and builds the documented
// minimal example from it.
//
// Everything else in this repository tests the source tree. This tests what a
// consumer actually receives: if an entry point is missing from "exports", a
// type declaration does not ship, or the minimal example imports something the
// package does not expose, nothing else here would notice — the repository
// resolves those from src/ and dist/ regardless.
//
// Deliberately not a substitute for a browser: it proves the package installs,
// resolves, type-checks and runs its engine. What it cannot prove is that the
// DOM bindings work — test/kernel.test.ts and test/examples.test.ts own that,
// against jsdom.
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGE = "@echelon-foundry/typescript-wasm-kernel";
const run = promisify(execFile);

const step = (message: string): void => console.log(`  ${message}`);

// Documents the packaged files a consumer is promised by name, so a rename
// that silently drops one fails here rather than in someone's project.
const MUST_RESOLVE = [
  "dist/index.js",
  "dist/protocol.d.ts",
  "docs/quick-start.md",
  "docs/mental-model.md",
  "examples/minimal/engine.js",
] as const;

const SMOKE = `
import assert from "node:assert/strict";
import { BrowserKernel, PROTOCOL_VERSION } from "${PACKAGE}";
import { createCounterTransport, transition, project } from "./engine.js";

// 1. The published entry points resolve, by package name, from a real install.
assert.equal(typeof BrowserKernel, "function", "BrowserKernel must be constructible");
assert.equal(PROTOCOL_VERSION, 1);

// 2. The subpath export resolves too — the quick start tells consumers to
//    import their types from it.
const protocol = await import("${PACKAGE}/protocol");
assert.equal(protocol.PROTOCOL_VERSION, 1);

// 3. The documented minimal engine actually runs, through the same messages the
//    kernel would send it.
const transport = createCounterTransport();
await transport.start();

const initial = await transport.dispatch({
  kind: "Initialize",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: ["Http", "Storage", "Clipboard", "Navigation"],
  location: { path: "/", query: "", hash: "" },
});
assert.deepEqual(initial.view, { count: 0, resetDisabled: true });
assert.deepEqual(initial.effects, []);

const after = await transport.dispatch({ kind: "Event", event: { kind: "Event", name: "increment" } });
assert.deepEqual(after.view, { count: 1, resetDisabled: false });

// 4. And the pure functions behave as the documentation claims.
assert.deepEqual(transition({ count: 1 }, "reset"), { count: 0 });
assert.equal(project({ count: 0 }).resetDisabled, true);
assert.throws(() => transition({ count: 0 }, "nonsense"), /Unrecognized event/);

console.log("  smoke test passed: entry points resolve and the minimal engine runs");
`;

const TYPES_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ES2022",
    moduleResolution: "bundler",
    lib: ["ES2022", "DOM", "DOM.Iterable"],
    strict: true,
    noEmit: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
  },
  include: ["types.check.ts"],
};

// `--tarball <path>` tests an archive that already exists — the release
// workflow points this at the real `npm pack` output, so the thing being
// published is the thing being proven, not a second tarball built beside it.
const tarballArgument = ((): string | null => {
  const index = process.argv.indexOf("--tarball");
  return index === -1 ? null : process.argv[index + 1] ?? null;
})();

const workspace = await mkdtemp(join(tmpdir(), "limen-clean-room-"));
let failed = false;

try {
  step(`workspace: ${workspace}`);

  // 1. Pack, unless we were handed an archive. --ignore-scripts because prepack
  //    runs `npm run check`, which runs this script; without it, packing would
  //    recurse.
  let tarball: string;
  if (tarballArgument === null) {
    step("packing the tarball…");
    const { stdout: packed } = await run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", workspace], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
    const name = (JSON.parse(packed) as readonly { readonly filename: string }[])[0]?.filename;
    if (!name) throw new Error("npm pack produced no tarball");
    tarball = join(workspace, name);
    step(`packed ${name}`);
  } else {
    tarball = resolve(ROOT, tarballArgument);
    step(`using the archive at ${tarball}`);
  }

  // 2. An empty consumer project. Nothing from this repository is on its path.
  const consumer = join(workspace, "consumer");
  await cp(join(ROOT, "examples", "minimal"), consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), `${JSON.stringify({
    name: "limen-clean-room-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
  }, null, 2)}\n`);
  await writeFile(join(consumer, "smoke.mjs"), SMOKE);
  await writeFile(join(consumer, "tsconfig.json"), `${JSON.stringify(TYPES_TSCONFIG, null, 2)}\n`);

  // 3. Install the tarball exactly as a consumer would install the package.
  step("installing the tarball into the empty project…");
  await run("npm", ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: consumer, maxBuffer: 16 * 1024 * 1024 });

  // 4. The promised files are really there, under the installed package.
  const installed = join(consumer, "node_modules", PACKAGE);
  const present = new Set<string>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const next = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), `${next}/`);
      else present.add(next);
    }
  };
  await walk(installed, "");
  const missing = MUST_RESOLVE.filter((file) => !present.has(file));
  if (missing.length > 0) throw new Error(`installed package is missing: ${missing.join(", ")}`);
  step(`installed package contains ${present.size} files, including every documented one`);

  // 5. The engine runs, imported by package name.
  step("running the smoke test…");
  const { stdout: smoke } = await run(process.execPath, ["smoke.mjs"], { cwd: consumer });
  process.stdout.write(smoke);

  // 6. The type declarations resolve for a TypeScript consumer. tsc comes from
  //    this repository (a consumer would install their own); module resolution
  //    still runs against the consumer's node_modules, which is the part under
  //    test.
  step("type-checking a TypeScript consumer against the installed package…");
  await run(process.execPath, [join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"], { cwd: consumer });

  console.log("Clean-room check passed: the packed tarball installs, resolves, type-checks and runs.");
} catch (error) {
  failed = true;
  const detail = error as { stdout?: string; stderr?: string; message?: string };
  console.error("Clean-room check FAILED.");
  if (detail.stdout) console.error(detail.stdout);
  if (detail.stderr) console.error(detail.stderr);
  if (!detail.stdout && !detail.stderr) console.error(detail.message ?? String(error));
} finally {
  await rm(workspace, { recursive: true, force: true });
}

if (failed) process.exitCode = 1;
