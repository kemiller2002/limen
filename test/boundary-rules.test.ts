// One boundary, shipped as checked (kemiller2002/limen#51).
//
// Limen's own guardrails and the consumer `limen verify` read one rule set,
// architecture/boundary-rules.json. These tests hold that in place:
//   * the shared fixtures pass through the repository implementation
//     (tools/guardrails/boundary.ts); cli/tests/Limen.Core.Tests/
//     BoundaryRulesTests.fs runs the same fixtures through the CLI;
//   * no second token list survives anywhere a check or the CLI reads;
//   * architecture/verify-parity.json classifies every repository check and
//     rule as consumer-enforced or repository-only (with a reason), so a new
//     repository rule that consumers do not get fails here until someone says
//     why;
//   * Limen's self-verify runs at the in-repository version;
//   * the workflow Limen installs into consumers is pinned.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  checkBoundaryFile,
  checkHostShim,
  parseBoundaryDeclaration,
  parseBoundaryRules,
  parseHostShims,
  type BoundaryRuleId,
  type Side,
} from "../tools/guardrails/boundary.ts";

const read = (path: string): Promise<string> => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const json = async (path: string): Promise<unknown> => JSON.parse(await read(path)) as unknown;

const rules = parseBoundaryRules(await json("architecture/boundary-rules.json"));

type Case = { readonly name: string; readonly side: Side; readonly path: string; readonly source: string; readonly expect: readonly (readonly [string, string])[] };
const fixtures = (await json("test/fixtures/boundary-rules/cases.json")) as { readonly cases: readonly Case[] };

test("the repository matcher agrees with every shared fixture", () => {
  assert.ok(fixtures.cases.length >= 30, "the shared fixture set shrank");
  for (const fixture of fixtures.cases) {
    const actual = checkBoundaryFile(rules, fixture.side, fixture.path, fixture.source).map((finding) => [finding.rule, finding.token]);
    assert.deepEqual(actual, fixture.expect, fixture.name);
  }
});

test("every language has authority tokens, and the fixtures exercise every language and rule", () => {
  for (const language of ["typescript", "fsharp", "csharp", "rust"] as const) {
    assert.ok((rules.authority[language] ?? []).length > 0, `no authority tokens for ${language}`);
  }
  const exercised = new Set(fixtures.cases.flatMap((fixture) => fixture.expect.map(([rule]) => rule)));
  for (const rule of ["engine-authority", "engine-module", "engine-dynamic-type", "escape-hatch"] satisfies BoundaryRuleId[]) {
    assert.ok(exercised.has(rule), `no fixture expects ${rule}`);
  }
});

test("no second token list: the checks and the CLI read architecture/boundary-rules.json", async () => {
  const tokens = [...Object.values(rules.authority).flat(), ...rules.escapeHatches].filter((token) => token.length > 4);
  const readers = ["scripts/check-architecture.ts", "scripts/check-layers.ts", "tools/guardrails/layers.ts", "tools/guardrails/boundary.ts"];
  const cliCore = (await readdir(new URL("../cli/Limen.Core/", import.meta.url))).filter((name) => name.endsWith(".fs")).map((name) => `cli/Limen.Core/${name}`);
  for (const path of [...readers, ...cliCore]) {
    const source = await read(path);
    const literals = tokens.filter((token) => source.includes(`"${token}"`));
    assert.deepEqual(literals, [], `${path} holds its own boundary token literal(s); they belong in architecture/boundary-rules.json`);
  }
  assert.equal("engineLibraries" in ((await json("architecture/layers.json")) as Record<string, unknown>), false);
  const project = await read("cli/Limen.Core/Limen.Core.fsproj");
  assert.match(project, /<EmbeddedResource Include="\.\.\/\.\.\/architecture\/boundary-rules\.json" LogicalName="Limen\.Core\.boundary-rules\.json" \/>/);
});

type Parity = {
  readonly boundaryRules: { readonly consumer: readonly string[] };
  readonly verdicts: { readonly consumer: readonly string[] };
  readonly checkScripts: Readonly<Record<string, { readonly consumer: string; readonly reason?: string }>>;
  readonly repositoryOnlyRules: Readonly<Record<string, { readonly rules: readonly string[]; readonly reason: string } | string>>;
};
const parity = (await json("architecture/verify-parity.json")) as Parity;
const sorted = (values: Iterable<string>): readonly string[] => [...values].sort();

test("parity: every repository check script is classified, consumer or repository-only with a reason", async () => {
  const scripts = (await readdir(new URL("../scripts/", import.meta.url))).filter((name) => /^check-.+\.ts$/.test(name));
  assert.deepEqual(sorted(Object.keys(parity.checkScripts)), sorted(scripts));
  for (const [script, entry] of Object.entries(parity.checkScripts)) {
    assert.ok(["yes", "partly", "no"].includes(entry.consumer), `${script}: consumer must be yes, partly or no`);
    if (entry.consumer !== "yes") assert.ok((entry.reason ?? "").length > 20, `${script}: a repository-only check needs its reason`);
  }
  const gates = ((await json("architecture/guardrails.json")) as { requiredGates: { testScript: readonly string[] } }).requiredGates.testScript;
  for (const gate of gates.filter((name) => name.startsWith("check:"))) {
    assert.ok(`check-${gate.slice("check:".length)}.ts` in parity.checkScripts, `${gate} is a required gate missing from architecture/verify-parity.json`);
  }
});

test("parity: the boundary rule identifiers are the same in the repository guardrail, the CLI and the registry", async () => {
  const repository = /export type BoundaryRuleId = ([^;]+);/.exec(await read("tools/guardrails/boundary.ts"))?.[1] ?? "";
  const repositoryIds = [...repository.matchAll(/"([a-z-]+)"/g)].map((match) => match[1] ?? "");
  const cli = /module Rule =([\s\S]*?)\n\n/.exec(await read("cli/Limen.Core/Boundary.fs"))?.[1] ?? "";
  const cliIds = [...cli.matchAll(/-> "([a-z-]+)"/g)].map((match) => match[1] ?? "");
  assert.deepEqual(sorted(repositoryIds), sorted(parity.boundaryRules.consumer));
  assert.deepEqual(sorted(cliIds), sorted(parity.boundaryRules.consumer));
});

test("parity: every TypeScript-subset and layer rule is classified repository-only, with a reason", async () => {
  const union = /export type Rule =([\s\S]*?);/.exec(await read("tools/guardrails/typescript.ts"))?.[1] ?? "";
  const typescriptRules = [...union.matchAll(/"([a-z-]+)"/g)].map((match) => match[1] ?? "");
  const layerSource = await read("tools/guardrails/layers.ts");
  const layerRules = layerSource.split("\n").filter((line) => /\brule:\s/.test(line)).flatMap((line) => [...line.matchAll(/"([a-z][a-z0-9-]*)"/g)].map((match) => match[1] ?? ""));
  const registry = parity.repositoryOnlyRules;
  const entry = (key: string): { readonly rules: readonly string[]; readonly reason: string } => {
    const value = registry[key];
    assert.ok(value !== undefined && typeof value !== "string", `verify-parity.json: repositoryOnlyRules.${key} missing`);
    return value;
  };
  assert.deepEqual(sorted(entry("typescript").rules), sorted(typescriptRules));
  assert.deepEqual(sorted(entry("layers").rules), sorted(new Set(layerRules)));
  assert.ok(entry("typescript").reason.length > 20 && entry("layers").reason.length > 20);
});

test("parity: the CLI verdicts the registry promises exist", async () => {
  const types = await read("cli/Limen.Core/Types.fs");
  for (const verdict of parity.verdicts.consumer) assert.ok(types.includes(`-> "${verdict}"`), `Types.fs has no ${verdict} verdict`);
  assert.match(await read("cli/Limen.Core/ExitCodes.fs"), /let boundaryNotConfigured = 8/);
});

test("Limen declares its own boundary: engine paths are listed and exist", async () => {
  const declaration = parseBoundaryDeclaration(await json("limen.config.json"));
  assert.equal(declaration.kind, "declared");
  if (declaration.kind === "declared") {
    assert.ok(declaration.engine.includes("src/engine") && declaration.engine.includes("libraries"));
    assert.ok(declaration.engine.some((path) => path.includes("federation")), "the federation engines are engine code");
  }
});

test("a limen.config.json without a boundary reason, or with both, is refused", () => {
  assert.throws(() => parseBoundaryDeclaration({ boundary: { notApplicable: { rationale: " " } } }), /rationale/);
  assert.throws(() => parseBoundaryDeclaration({ boundary: { engine: ["src/engine"], notApplicable: { rationale: "x" } } }), /cannot be combined/);
  assert.deepEqual(parseBoundaryDeclaration({ boundary: { notApplicable: { rationale: "Docs only." } } }), { kind: "not-applicable", rationale: "Docs only." });
});

test("host shims: control flow, browser concepts and a missing engine call are refused", async () => {
  const manifest = parseHostShims(await json("architecture/wasm-hosts.json"));
  const host = { path: "x/Limen.X.Wasm/Program.cs", engine: "Limen.X.Engine.Dispatch.handle", applicationConcepts: ["ApproveRelease"] };
  assert.deepEqual(checkHostShim(manifest, host, "// if window\nclass A { static string D(string m) => Limen.X.Engine.Dispatch.handle(m); }"), []);
  assert.equal(checkHostShim(manifest, host, "class A { static string D(string m) { if (m == \"\") return m; return Limen.X.Engine.Dispatch.handle(m); } }").length, 1);
  assert.equal(checkHostShim(manifest, host, "class A { static string D(string m) => ApproveRelease(m); }").length, 2);
});

test("self-verify runs at the in-repository version, never a hard-coded one", async () => {
  const packageVersion = ((await json("package.json")) as { version: string }).version;
  const installed = ((await json(".echelon/limen.json")) as { installedVersion: string }).installedVersion;
  assert.equal(installed, packageVersion, "a release must move .echelon/limen.json with package.json (strict self-verify fails otherwise)");
  const workflow = await read(".github/workflows/limen-verify.yml");
  assert.doesNotMatch(workflow, /-p:Version=\d/, "the self-verify version must come from package.json");
  assert.match(workflow, /require\('\.\/package\.json'\)\.version/);
});

test("the workflow Limen installs into consumers runs the CLI pinned to the recorded version", async () => {
  const assets = await read("cli/Limen.Core/Assets.fs");
  assert.match(assets, /require\('\.\/\.echelon\/limen\.json'\)\.installedVersion/);
  assert.match(assets, /@echelon-foundry\/limen@\$\{\{ steps\.limen\.outputs\.version \}\}" verify --strict/);
  assert.doesNotMatch(assets, /npx --yes @echelon-foundry\/limen verify/, "an unpinned verify floats to the latest release");
  assert.doesNotMatch(assets, /typescript-wasm-kernel/, "the workflow installs the package under its 0.7.0 name, @echelon-foundry/limen");
});
