// The Core boundary (kemiller2002/limen#60). architecture/core.json is the
// Core manifest; tools/guardrails/core.ts checks the repository against it.
// Every rule has a fixture that must fail with a diagnostic naming the source
// path, the destination path or layer, and the rule; the real repository must
// pass. Fixtures are the real repository's files with one change applied in
// memory, so the rules are tested against the actual layout, not a toy one.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { checkCore, contractFamilies, dataAttributesOf, exportedNames, parseCoreManifest, runtimeDependencies, type CoreInputs, type CoreManifest } from "../tools/guardrails/core.ts";
import { checkLayers, parseLayerMap, type SourceFile } from "../tools/guardrails/layers.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(ROOT, path), "utf8")) as unknown;

const walk = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => (entry.isDirectory() ? walk(join(directory, entry.name)) : Promise.resolve([join(directory, entry.name)]))))).flat();
};

const rawManifest = await json("architecture/core.json");
const manifest = parseCoreManifest(rawManifest);
const map = parseLayerMap(await json("architecture/layers.json"));
const repository: CoreInputs = {
  files: await Promise.all((await walk(join(ROOT, "src"))).map(async (path) => ({ path: relative(ROOT, path), source: await readFile(path, "utf8") }))),
  packageJson: await json("package.json"),
  contract: await json(manifest.capabilityContract),
};

// The repository with files added or replaced.
const withFiles = (...changed: readonly SourceFile[]): CoreInputs => ({
  ...repository,
  files: [...repository.files.filter((file) => !changed.some((change) => change.path === file.path)), ...changed],
});
const sourceOf = (path: string): string => repository.files.find((file) => file.path === path)?.source ?? assert.fail(`${path} is not in the repository`);
const appended = (path: string, code: string): SourceFile => ({ path, source: `${sourceOf(path)}\n${code}\n` });
const check = (inputs: CoreInputs, using: CoreManifest = manifest) => checkCore(using, map, inputs);
const rules = (inputs: CoreInputs, using: CoreManifest = manifest): readonly string[] => check(inputs, using).map((violation) => violation.rule);
// Distinct rules, in first-seen order: a Core file that imports an optional
// layer also puts that layer in every Core entrypoint's graph that reaches it.
const distinct = (violations: readonly { readonly rule: string }[]): readonly string[] => [...new Set(violations.map((violation) => violation.rule))];
const IMPORTS_OPTIONAL = ["core-imports-optional", "optional-in-minimal-graph"];

test("the repository satisfies its Core manifest", () => {
  assert.deepEqual(check(repository), []);
});

test("the manifest records the frozen v1 boundary", () => {
  assert.equal(manifest.architectureVersion, "1.0.0");
  assert.deepEqual(manifest.concepts, ["engine-owns-meaning", "html-owns-structure", "css-owns-presentation", "semantic-input", "projection-output", "typed-capabilities", "correlation-compatibility"]);
  assert.deepEqual(manifest.bindingPrimitives, ["data-event", "data-on", "data-text", "data-bind-*", "data-if", "data-each"]);
  assert.deepEqual(manifest.capabilityFamilies, ["Http", "Storage", "Clipboard", "Navigation"]);
  assert.deepEqual(manifest.limits, { runtimeDependencies: 0, bindingPrimitives: 6, capabilityFamilies: 4, concepts: 7 });
  // The facts the limits guard, read from the sources rather than the manifest.
  assert.deepEqual(runtimeDependencies(repository.packageJson), []);
  const families = contractFamilies(repository.contract, manifest.capabilitySeam);
  assert.deepEqual([families.variants, families.announced], [manifest.capabilityFamilies, manifest.capabilityFamilies]);
  assert.deepEqual(dataAttributesOf(sourceOf("src/kernel/browser-kernel.ts")).filter((name) => !manifest.bindingModifiers.includes(name)).sort(), [...manifest.bindingPrimitives].sort());
});

test("every layer is Core or exactly one optional group", () => {
  const optional = Object.values(manifest.optionalGroups).flat();
  assert.deepEqual([...manifest.coreLayers, ...optional].sort(), map.layers.map((layer) => layer.name).sort());
});

// --- Negative fixtures ----------------------------------------------------------------

test("a new runtime file outside every declared layer fails", () => {
  const violations = check(withFiles({ path: "src/widgets/carousel.ts", source: "export const carousel = 1;" }));
  assert.deepEqual(violations.map((violation) => violation.rule), ["unclassified-path"]);
  assert.equal(violations[0]?.path, "src/widgets/carousel.ts");
  assert.match(violations[0]?.detail ?? "", /belongs to no layer/);
});

test("a new file in a Core layer fails: Core does not grow by adding a path", () => {
  const violations = check(withFiles({ path: "src/kernel/timers.ts", source: "export const every = (ms: number): number => ms;" }));
  assert.deepEqual(violations.map((violation) => violation.rule), ["core-file-undeclared"]);
  assert.match(violations[0]?.detail ?? "", /Core layer core-kernel/);
  assert.match(violations[0]?.remedy ?? "", /Core Admission/);
});

test("Core importing federation fails, naming the destination and its optional group", () => {
  const violations = check(withFiles(appended("src/kernel/browser-kernel.ts", `import { ModuleFederation } from "../federation.js";`)));
  assert.deepEqual(distinct(violations), IMPORTS_OPTIONAL);
  assert.match(violations[0]?.path ?? "", /^src\/kernel\/browser-kernel\.ts:\d+$/);
  assert.match(violations[0]?.detail ?? "", /imports src\/federation\.ts, in federation-host \[optional group: federation\]/);
});

test("Core importing an optional capability pack fails", () => {
  const violations = check(withFiles(appended("src/kernel/capabilities.ts", `import { focusCapability } from "../capabilities/focus/index.js";`)));
  assert.deepEqual(distinct(violations), IMPORTS_OPTIONAL);
  assert.match(violations[0]?.detail ?? "", /capability-pack \[optional group: capability-packs\]/);
});

test("Core importing the reference engine fails", () => {
  const violations = check(withFiles(appended("src/protocol.ts", `export type { State } from "./engine/domain.js";`)));
  assert.deepEqual(distinct(violations), IMPORTS_OPTIONAL);
  assert.match(violations[0]?.detail ?? "", /reference-engine \[optional group: reference-demo\]/);
});

test("Core importing a host, renderer or tooling fails", () => {
  const imports = [
    ["src/kernel/diagnostics.ts", `import { WorkerTransport } from "../hosts/worker-transport.js";`, "hosts-renderers"],
    ["src/kernel/handshake.ts", `import { renderRoute } from "../renderer/server.js";`, "hosts-renderers"],
    ["src/guest/handshake.ts", `import { trace } from "../tooling/trace.js";`, "tooling-conformance"],
  ] as const;
  imports.forEach(([path, code, group]) => {
    const violations = check(withFiles(appended(path, code)));
    assert.deepEqual(distinct(violations), IMPORTS_OPTIONAL, path);
    assert.match(violations[0]?.detail ?? "", new RegExp(`optional group: ${group}`));
  });
});

test("a capability pack importing application code fails", () => {
  const pack = appended("src/capabilities/focus/index.ts", `import { transition } from "../../engine/domain.js";`);
  const violations = checkLayers(map, [pack]);
  assert.deepEqual(violations.map((violation) => violation.rule), ["layer-direction"]);
  assert.match(violations[0]?.detail ?? "", /capability-pack must not import reference-engine/);
});

test("an optional host reaching into a private Core file fails", () => {
  const privateFile = { path: "src/kernel/scheduler.ts", visibility: "private" as const, generated: false };
  const withPrivate: CoreManifest = { ...manifest, files: [...manifest.files, privateFile] };
  const inputs = withFiles(
    { path: privateFile.path, source: "export const queue: readonly string[] = [];" },
    appended("src/hosts/worker-transport.ts", `import { queue } from "../kernel/scheduler.js";`),
  );
  const violations = check(inputs, withPrivate);
  assert.deepEqual(violations.map((violation) => violation.rule), ["private-core-import"]);
  assert.match(violations[0]?.detail ?? "", /host-adapter imports src\/kernel\/scheduler\.ts, a private Core file/);
  // The same import of a public extension point is allowed.
  assert.deepEqual(rules(withFiles(appended("src/hosts/worker-transport.ts", `import { verifyHandshake } from "../kernel/handshake.js";`))), []);
});

test("a seventh binding primitive fails, in the kernel or in the manifest", () => {
  const read = check(withFiles(appended("src/kernel/browser-kernel.ts", `export const model = (el: { getAttribute(name: string): string | null }): string | null => el.getAttribute("data-model");`)));
  assert.deepEqual(read.map((violation) => violation.rule), ["binding-primitive-undeclared"]);
  assert.match(read[0]?.detail ?? "", /data-model/);
  const declared: CoreManifest = { ...manifest, bindingPrimitives: [...manifest.bindingPrimitives, "data-model"] };
  assert.deepEqual(rules(repository, declared), ["binding-primitive-limit"]);
});

test("a fifth built-in capability family fails, in the contract or in the manifest", () => {
  const contract = structuredClone(repository.contract) as { types: { name: string; variants?: { name: string; flatten: string }[]; values?: string[] }[] };
  contract.types.find((type) => type.name === "EffectRequest")?.variants?.push({ name: "Timer", flatten: "TimerEffectRequest" });
  contract.types.find((type) => type.name === "Capability")?.values?.push("Timer");
  const violations = check({ ...repository, contract });
  assert.deepEqual(violations.map((violation) => violation.rule), ["capability-family-added", "capability-family-added"]);
  assert.match(violations[0]?.detail ?? "", /EffectRequest adds built-in capability family Timer/);
  assert.match(violations[0]?.remedy ?? "", /optional capability pack/);
  const declared: CoreManifest = { ...manifest, capabilityFamilies: [...manifest.capabilityFamilies, "Timer"] };
  assert.ok(rules(repository, declared).includes("capability-family-limit"));
});

test("a runtime dependency fails", () => {
  const packageJson = { ...(repository.packageJson as Record<string, unknown>), dependencies: { "left-pad": "^1.3.0" } };
  const violations = check({ ...repository, packageJson });
  assert.deepEqual(violations.map((violation) => violation.rule), ["runtime-dependency"]);
  assert.match(violations[0]?.detail ?? "", /left-pad/);
  assert.deepEqual(rules({ ...repository, packageJson: { ...packageJson, dependencies: {}, peerDependencies: { react: "*" } } }), ["runtime-dependency"]);
});

test("a root export outside every approved family fails", () => {
  const violations = check(withFiles(appended("src/index.ts", `export { renderRoute } from "./renderer/server.js";`)));
  assert.ok(violations.some((violation) => violation.rule === "root-export-unapproved" && /exports renderRoute/.test(violation.detail)));
});

test("the root exporting federation or the reference engine fails (kemiller2002/limen#61)", () => {
  const federation = check(withFiles(appended("src/index.ts", `export { ModuleFederation } from "./federation.js";`)));
  assert.deepEqual(distinct(federation), ["root-export-unapproved", "optional-in-minimal-graph"]);
  assert.match(federation.find((violation) => violation.rule === "optional-in-minimal-graph")?.detail ?? "", /entrypoint "\." transitively loads src\/federation\.ts \(federation-host, optional group federation\)/);
  const reference = check(withFiles(appended("src/index.ts", `export { ReferenceEngine } from "./engine/engine.js";`)));
  assert.deepEqual(distinct(reference), ["root-export-unapproved", "optional-in-minimal-graph"]);
  // The layer map forbids the same import independently.
  assert.deepEqual(checkLayers(map, [appended("src/index.ts", `export { ModuleFederation } from "./federation.js";`)]).map((violation) => violation.rule), ["layer-direction"]);
});

test("a hidden transitive import of an optional layer from Core fails", () => {
  // Through a type-free re-export in a file the root reaches only indirectly.
  const violations = check(withFiles(appended("src/kernel/diagnostics.ts", `export { createLazyFederation } from "../federation.js";`)));
  assert.deepEqual(distinct(violations), IMPORTS_OPTIONAL);
  assert.ok(violations.some((violation) => violation.rule === "optional-in-minimal-graph" && violation.path === "src/index.ts"));
});

test("an optional surface losing its explicit subpath fails", () => {
  const exports = { ...((repository.packageJson as { exports: Record<string, unknown> }).exports) };
  delete exports["./federation"];
  const violations = check({ ...repository, packageJson: { ...(repository.packageJson as Record<string, unknown>), exports } });
  assert.deepEqual(violations.map((violation) => violation.rule), ["entrypoint-mismatch"]);
  assert.match(violations[0]?.detail ?? "", /exports\["\.\/federation"\] is missing/);
});

test("an eighth canonical concept fails", () => {
  const eight: CoreManifest = { ...manifest, concepts: [...manifest.concepts, "components"] };
  assert.deepEqual(rules(repository, eight), ["concept-limit"]);
});

test("an unclassified layer, or one in two groups, fails", () => {
  const withoutReference = Object.fromEntries(Object.entries(manifest.optionalGroups).filter(([group]) => group !== "reference-demo"));
  assert.ok(rules(repository, { ...manifest, optionalGroups: withoutReference }).includes("layer-unclassified"));
  assert.ok(rules(repository, { ...manifest, optionalGroups: { ...manifest.optionalGroups, extra: ["tooling"] } }).includes("layer-ambiguous"));
});

test("export names are read from lists, renames and declarations", () => {
  assert.deepEqual(exportedNames(`export { a, b as c } from "./x.js";\nexport type { D } from "./y.js";\nexport const e = 1;\nexport class F {}\n// export { g }`), ["D", "F", "a", "c", "e"]);
});

// --- The checker itself, end to end ---------------------------------------------------

test("npm run check:architecture fails on a Core violation in an isolated copy of the repository", async () => {
  const copy = await mkdtemp(join(tmpdir(), "limen-core-"));
  try {
    await Promise.all(["src", "architecture", "contract", "scripts", "tools", "site/fsharp/Limen.Site.Engine", "site/fsharp/Limen.Site.Wasm/Program.cs", "package.json"]
      .map((path) => cp(join(ROOT, path), join(copy, path), { recursive: true })));
    const run = () => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/check-architecture.ts"], { cwd: copy, encoding: "utf8" });
    assert.equal(run().status, 0, run().stderr);
    await writeFile(join(copy, "src/kernel/timers.ts"), `import { ModuleFederation } from "../federation.js";\nexport const federation = ModuleFederation;\n`);
    const failed = run();
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /\[core-file-undeclared\] src\/kernel\/timers\.ts/);
    assert.match(failed.stderr, /\[core-imports-optional\] src\/kernel\/timers\.ts:1: Core \(core-kernel\) imports src\/federation\.ts/);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});
