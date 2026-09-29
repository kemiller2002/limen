// The Core complexity budget (kemiller2002/limen#62). The report is measured
// from the real repository; every gate has a fixture that must fail; and the
// baseline cannot be moved by the feature work it constrains.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { measureProfile } from "../bench/size.ts";
import { coreReport, judge, sizeOf, type CoreReport, type ReportInputs } from "../tools/guardrails/core-metrics.ts";
import { emittedPath, parseCoreManifest } from "../tools/guardrails/core.ts";
import { parseLayerMap, type SourceFile } from "../tools/guardrails/layers.ts";
import { evaluateScope, parseGuardrails, parseManifest } from "../tools/guardrails/scope.ts";

const ROOT = join(import.meta.dirname, "..");
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(ROOT, path), "utf8")) as unknown;
const walk = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)]))))).flat();
};

const manifest = parseCoreManifest(await json("architecture/core.json"));
const map = parseLayerMap(await json("architecture/layers.json"));
const baseline = await json("architecture/core-baseline.json") as { reference: { commit: string; report: CoreReport }; approved: { authority: { workItem: string; kind: string; admission: string }; report: CoreReport } };
const sources: readonly SourceFile[] = await Promise.all((await walk(join(ROOT, "src"))).map(async (path) => ({ path: relative(ROOT, path), source: await readFile(path, "utf8") })));
const emitted = new Map(await Promise.all(manifest.files.map(async (file) => [emittedPath(file.path), await readFile(join(ROOT, emittedPath(file.path)), "utf8")] as const)));
const minimal = await measureProfile(ROOT, { name: "minimal-consumer", doc: "", entries: ["dist/index.js"], forbidden: [] });
const inputs: ReportInputs = {
  manifest,
  map,
  sources,
  coreFiles: manifest.files,
  emitted,
  packageJson: await json("package.json"),
  contract: await json(manifest.capabilityContract),
  minimalConsumer: { modules: minimal.modules.length, rawBytes: minimal.rawBytes, gzipBytesBundled: minimal.gzipBytesBundled },
};
const current = coreReport(inputs);
const approved = baseline.approved.report;
const dimensions = (report: CoreReport, against: CoreReport = approved): readonly string[] => judge(against, report, manifest.limits).map((finding) => `${finding.kind}: ${finding.dimension}`);

test("the report is deterministic: two measurements, and two runs of the command, are identical", () => {
  assert.deepEqual(coreReport(inputs), current);
  const run = (): string => execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/check-core-budget.ts", "--report"], { cwd: ROOT, encoding: "utf8" });
  const first = run();
  assert.equal(run(), first);
  assert.deepEqual(JSON.parse(first), current);
});

test("the repository is within its approved Core budget", () => {
  assert.deepEqual(dimensions(current), []);
  const command = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/check-core-budget.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /handwritten Core lines\s+435\s+\d+\s+\d+/);
});

test("the report covers every required dimension, generated code apart", () => {
  assert.equal(current.architectureVersion, "1.0.0");
  assert.deepEqual(current.core.perFile.filter((file) => file.generated).map((file) => file.path), ["src/generated/core.codec.ts", "src/generated/core.ts"]);
  assert.equal(current.core.handwritten.files + current.core.generated.files, manifest.files.length);
  assert.ok(current.core.emitted !== null && current.core.emitted.gzipBytes > 0);
  assert.equal(current.rootExports.unassigned.length, 0);
  assert.equal(current.bindingPrimitives.count, 6);
  assert.equal(current.capabilityFamilies.count, 4);
  assert.equal(current.runtimeDependencies.count, 0);
  assert.equal(current.concepts.count, 7);
  assert.ok(current.protocol.totalVariants > 0 && current.protocol.browserToEngineMessages === 5 && current.protocol.effectRequests === 5);
  assert.deepEqual(current.coreImportsOptional, []);
  assert.ok(current.optionalModules.every((module) => !module.inMinimalGraph));
  assert.ok(current.optionalModules.find((module) => module.group === "federation")?.present);
  // #19's payload measure is the same one bench/budgets.json's minimal-consumer uses.
  assert.equal(current.minimalConsumer?.gzipBytesBundled, minimal.gzipBytesBundled);
});

test("the recorded #59 reference is what 9a835cc actually contained", async () => {
  const reference = baseline.reference.report;
  assert.equal(baseline.reference.commit, manifest.referenceCommit);
  assert.deepEqual(reference.core.perFile.map((file) => [file.path, file.rawLines]), [["src/kernel/browser-kernel.ts", 486], ["src/kernel/diagnostics.ts", 14], ["src/protocol.ts", 175]]);
  assert.equal(reference.core.handwritten.rawLines, 675);
  assert.equal(reference.contractPresent, false);
  // Its minimal graph loaded federation and the reference engine: the debt #61 removed.
  assert.deepEqual(reference.optionalModules.filter((module) => module.inMinimalGraph).map((module) => module.group), ["federation", "reference-demo"]);
  // Line counts are recomputed from Git here when the object is available;
  // CI's full-history job re-measures the whole report (--verify-reference).
  const available = spawnSync("git", ["cat-file", "-e", `${manifest.referenceCommit}^{commit}`], { cwd: ROOT }).status === 0;
  if (!available) return;
  for (const file of reference.core.perFile) {
    const source = execFileSync("git", ["show", `${manifest.referenceCommit}:${file.path}`], { cwd: ROOT, encoding: "utf8" });
    const measured = sizeOf(source);
    assert.deepEqual([measured.rawLines, measured.lines, measured.bytes, measured.normalizedBytes], [file.rawLines, file.lines, file.bytes, file.normalizedBytes], file.path);
  }
});

test("the approved baseline names its authority, and records the growth since the reference", () => {
  assert.deepEqual(baseline.approved.authority.workItem, "WI-0122");
  assert.equal(baseline.approved.authority.admission, "CA-0001");
  assert.ok(approved.core.handwritten.lines > baseline.reference.report.core.handwritten.lines * 1.1, "the pre-freeze growth is recorded, not hidden");
});

// --- Hard gates: each fails on its own ----------------------------------------------

const alter = (changes: (report: CoreReport) => CoreReport): CoreReport => changes(structuredClone(current));

test("a runtime dependency fails", () => {
  assert.deepEqual(dimensions(alter((report) => ({ ...report, runtimeDependencies: { count: 1, names: ["left-pad"] } }))), ["hard-gate: runtime dependencies"]);
});

test("a seventh binding primitive fails", () => {
  assert.deepEqual(dimensions(alter((report) => ({ ...report, bindingPrimitives: { count: 7, names: [...report.bindingPrimitives.names, "data-model"] } }))), ["hard-gate: binding primitives"]);
});

test("a fifth built-in capability family fails", () => {
  assert.deepEqual(dimensions(alter((report) => ({ ...report, capabilityFamilies: { count: 5, names: [...report.capabilityFamilies.names, "Timer"] } }))), ["hard-gate: built-in capability families"]);
});

test("an optional module in the minimal graph fails", () => {
  const leaked = alter((report) => ({ ...report, optionalModules: report.optionalModules.map((module) => (module.group === "federation" ? { ...module, inMinimalGraph: true } : module)) }));
  assert.deepEqual(dimensions(leaked), ["hard-gate: optional modules in the minimal graph"]);
});

test("Core importing an optional layer fails", () => {
  assert.deepEqual(dimensions(alter((report) => ({ ...report, coreImportsOptional: ["src/kernel/browser-kernel.ts -> src/federation.ts"] }))), ["hard-gate: Core imports of optional layers"]);
});

test("a new root export family fails", () => {
  const added = alter((report) => ({ ...report, rootExports: { ...report.rootExports, families: [...report.rootExports.families, { id: "components", names: 1 }] } }));
  assert.deepEqual(dimensions(added), ["hard-gate: root export families"]);
});

test("an eighth canonical concept fails", () => {
  assert.deepEqual(dimensions(alter((report) => ({ ...report, concepts: { count: 8, ids: [...report.concepts.ids, "components"] } }))), ["hard-gate: canonical concepts"]);
});

// --- Review triggers: more than 10% -------------------------------------------------

const scaled = (factor: number) => (report: CoreReport): CoreReport => ({
  ...report,
  core: { ...report.core, handwritten: { ...report.core.handwritten, lines: Math.ceil(report.core.handwritten.lines * factor) } },
});

test("more than 10% growth in handwritten lines fails; 10% exactly does not", () => {
  assert.deepEqual(dimensions(alter(scaled(1.11))), ["review-trigger: handwritten Core lines"]);
  assert.deepEqual(dimensions(alter((report) => ({ ...report, core: { ...report.core, handwritten: { ...report.core.handwritten, lines: Math.floor(approved.core.handwritten.lines * 1.1) } } }))), []);
});

test("more than 10% growth in emitted bytes or root exports fails", () => {
  const emittedGrowth = alter((report) => ({ ...report, core: { ...report.core, emitted: report.core.emitted === null ? null : { ...report.core.emitted, gzipBytes: Math.ceil(report.core.emitted.gzipBytes * 1.11) } } }));
  assert.deepEqual(dimensions(emittedGrowth), ["review-trigger: emitted Core gzip bytes"]);
  assert.deepEqual(dimensions(alter((report) => ({ ...report, rootExports: { ...report.rootExports, total: Math.ceil(report.rootExports.total * 1.11) } }))), ["review-trigger: root exports"]);
});

test("code golf does not pass: fewer lines never offset a new concept, and joining lines does not shrink normalized bytes", () => {
  const golfed = alter((report) => ({
    ...scaled(0.5)(report),
    rootExports: { ...report.rootExports, families: [...report.rootExports.families, { id: "signals", names: 3 }] },
  }));
  assert.deepEqual(dimensions(golfed), ["hard-gate: root export families"]);
  const readable = "const a = 1;\n// why\nconst b = 2;\n\nexport const c = a + b;\n";
  const dense = "const a=1; const b=2;   export const c = a + b;";
  assert.ok(sizeOf(dense).lines < sizeOf(readable).lines);
  assert.equal(sizeOf("const a = 1;\nconst b = 2;").normalizedBytes, sizeOf("const a = 1; const b = 2;").normalizedBytes);
});

test("growth in an optional layer is not Core growth", () => {
  const pack = { path: "src/capabilities/focus/huge.ts", source: "export const x = 1;\n".repeat(20_000) };
  const withPack = coreReport({ ...inputs, sources: [...sources, pack] });
  assert.deepEqual(withPack.core, current.core);
  assert.deepEqual(dimensions(withPack), []);
});

test("a feature work item cannot move the baseline, the manifest or this gate", async () => {
  const guardrails = parseGuardrails(await json("architecture/guardrails.json"));
  const feature = parseManifest({ workItem: "WI-0900", reference: "#15", placement: "Capability Pack", guardrail: false, paths: ["src/capabilities/timers/**", "architecture/core-baseline.json", "architecture/core.json", "scripts/check-core-budget.ts", "tools/guardrails/core-metrics.ts"] }, "fixture");
  for (const path of ["architecture/core-baseline.json", "architecture/core.json", "scripts/check-core-budget.ts", "tools/guardrails/core-metrics.ts", "test/core-budget.test.ts"]) {
    const violations = evaluateScope(
      [{ sha: "d", message: "chore(scope): declare (WI-0900)", files: ["architecture/work-scopes/WI-0900.json"] }, { sha: "f", message: "feat(timers): raise the budget (WI-0900)", files: [path] }],
      new Map([[feature.workItem, feature]]),
      guardrails,
    ).map((violation) => violation.rule);
    assert.ok(violations.includes("guardrail-modification"), `${path}: ${violations.join(", ")}`);
  }
});
