// The Core complexity budget (kemiller2002/limen#62).
//
//   npm run check:core-budget                  measure, compare with the approved
//                                              baseline, fail on a hard gate or a
//                                              >10% review trigger (part of npm test)
//   npm run check:core-budget -- --report      print the current report as JSON
//   npm run check:core-budget -- --reference   print the report for the #59
//                                              reference commit, measured from Git
//   npm run check:core-budget -- --verify-reference
//                                              fail unless the recorded reference
//                                              reproduces exactly from Git (CI)
//
// The measuring is tools/guardrails/core-metrics.ts; this file only reads.
// The baseline, architecture/core-baseline.json, is guardrail-owned: feature
// work cannot raise it to make itself pass.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { measureProfile } from "../bench/size.ts";
import { comparisonTable, coreReport, judge, type CoreReport } from "../tools/guardrails/core-metrics.ts";
import { emittedPath, isCoreLayer, parseCoreManifest, type CoreFile } from "../tools/guardrails/core.ts";
import { matches, parseLayerMap, placementOf } from "../tools/guardrails/layers.ts";

const run = promisify(execFile);
const ROOT = process.cwd();
const mode = process.argv[2] ?? "--check";

const exists = (path: string): Promise<boolean> => stat(path).then(() => true, () => false);
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8")) as unknown;
const walk = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)]))))).flat();
};

const manifest = parseCoreManifest(await readJson(join(ROOT, "architecture/core.json")));
const map = parseLayerMap(await readJson(join(ROOT, "architecture/layers.json")));

// A tree to measure: the working copy, or a revision extracted from Git.
type Tree = { readonly root: string; readonly coreFiles: (sources: readonly string[]) => readonly CoreFile[] };

const measure = async (tree: Tree): Promise<CoreReport> => {
  const paths = (await walk(join(tree.root, "src"))).map((path) => relative(tree.root, path).replace(/\\/g, "/")).sort();
  const sources = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(join(tree.root, path), "utf8") })));
  const coreFiles = tree.coreFiles(paths);
  const emitted = new Map((await Promise.all(coreFiles.map(async (file) => {
    const path = emittedPath(file.path);
    return (await exists(join(tree.root, path))) ? [[path, await readFile(join(tree.root, path), "utf8")] as const] : [];
  }))).flat());
  const contractPath = join(tree.root, manifest.capabilityContract);
  const minimal = (await exists(join(tree.root, "dist/index.js")))
    ? await measureProfile(tree.root, { name: "minimal-consumer", doc: "", entries: ["dist/index.js"], forbidden: [] })
    : undefined;
  return coreReport({
    manifest,
    map,
    sources,
    coreFiles,
    emitted: emitted.size === coreFiles.length ? emitted : new Map(),
    packageJson: await readJson(join(tree.root, "package.json")),
    contract: (await exists(contractPath)) ? await readJson(contractPath) : undefined,
    minimalConsumer: minimal === undefined ? null : { modules: minimal.modules.length, rawBytes: minimal.rawBytes, gzipBytesBundled: minimal.gzipBytesBundled },
  });
};

// The working copy: Core is exactly the manifest's list.
const workingCopy: Tree = { root: ROOT, coreFiles: () => manifest.files };

// The reference commit predates the manifest: Core is every file then in a
// Core layer's paths (none of it generated — there was no generator).
const atReference = async (): Promise<{ readonly report: CoreReport; readonly cleanup: () => Promise<void> }> => {
  const directory = await mkdtemp(join(tmpdir(), "limen-core-reference-"));
  const archive = join(directory, "tree.tar");
  await run("git", ["archive", "--format=tar", "-o", archive, manifest.referenceCommit], { cwd: ROOT });
  await run("tar", ["-xf", archive, "-C", directory]);
  // Emit with this repository's TypeScript, into the extracted tree's dist/.
  await run(process.execPath, [join(ROOT, "node_modules/typescript/bin/tsc"), "-p", join(directory, "tsconfig.json")], { cwd: directory }).catch((error: unknown) => {
    throw new Error(`could not build the reference commit: ${String(error)}`);
  });
  const coreLayerPaths = map.layers.filter((layer) => isCoreLayer(manifest, layer.name)).flatMap((layer) => layer.paths);
  const tree: Tree = {
    root: directory,
    coreFiles: (paths) => paths.filter((path) => coreLayerPaths.some((glob) => matches(glob, path)) && placementOf(map, path) !== undefined).map((path) => ({ path, visibility: "public", generated: false })),
  };
  return { report: await measure(tree), cleanup: () => rm(directory, { recursive: true, force: true }) };
};

type Baseline = { readonly reference: { readonly commit: string; readonly report: CoreReport }; readonly approved: { readonly report: CoreReport } };
const readBaseline = async (): Promise<Baseline> => (await readJson(join(ROOT, "architecture/core-baseline.json"))) as Baseline;

switch (mode) {
  case "--report": {
    console.log(JSON.stringify(await measure(workingCopy), null, 2));
    break;
  }
  case "--reference": {
    const reference = await atReference();
    try {
      console.log(JSON.stringify(reference.report, null, 2));
    } finally {
      await reference.cleanup();
    }
    break;
  }
  case "--verify-reference": {
    const baseline = await readBaseline();
    const reference = await atReference();
    try {
      const recorded = JSON.stringify(baseline.reference.report);
      const measured = JSON.stringify(reference.report);
      if (baseline.reference.commit !== manifest.referenceCommit || recorded !== measured) {
        console.error(`The recorded Core reference does not reproduce from ${manifest.referenceCommit}.\nrecorded: ${recorded}\nmeasured: ${measured}`);
        process.exitCode = 1;
      } else {
        console.log(`Core reference reproduces from ${manifest.referenceCommit}: ${reference.report.core.handwritten.rawLines} raw lines of handwritten Core in ${reference.report.core.handwritten.files} files.`);
      }
    } finally {
      await reference.cleanup();
    }
    break;
  }
  default: {
    const baseline = await readBaseline();
    const current = await measure(workingCopy);
    const findings = judge(baseline.approved.report, current, manifest.limits);
    console.log(`Core complexity (architecture ${current.architectureVersion}; reference ${baseline.reference.commit.slice(0, 7)}):\n${comparisonTable(baseline.reference.report, baseline.approved.report, current)}`);
    if (current.core.emitted === null) {
      console.error("dist/ is missing or incomplete: build first (npm run build). Emitted Core size cannot be judged without it.");
      process.exitCode = 1;
    }
    if (findings.length > 0) {
      console.error(`\nCore budget failed (${findings.length}):\n${findings.map((finding) => `[${finding.kind}] ${finding.dimension}: approved ${finding.approved}, now ${finding.current}\n    → ${finding.detail}`).join("\n")}`);
      process.exitCode = 1;
    } else if (current.core.emitted !== null) {
      console.log("Core budget passed: no hard gate breached, no dimension more than 10% over the approved baseline.");
    }
  }
}
