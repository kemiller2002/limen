// The restricted handwritten-TypeScript subset (kemiller2002/limen#54): each
// forbidden escape hatch has a fixture the checker must reject, legitimate
// mechanics must stay expressible, and the repository itself must pass.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { checkProgram, REMEDIES, type BoundaryConfig, type Rule } from "../tools/guardrails/typescript.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIXTURES = "test/fixtures/negative/typescript";

const contractNames = (JSON.parse(await readFile(join(ROOT, "contract/core.contract.json"), "utf8")) as { types: { name: string }[] }).types.map((type) => type.name);

const config: BoundaryConfig = {
  files: [`${FIXTURES}/**`],
  expectErrorAllowed: [`${FIXTURES}/allowed/**`],
  sanctioned: [],
  knownDebt: [],
  protocolTypeNames: contractNames,
  generatedPaths: [],
};

const programFor = (files: readonly string[]): ts.Program => ts.createProgram(files.map((file) => join(ROOT, FIXTURES, file)), {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  strict: true,
  noEmit: true,
});

const rulesFor = (file: string, overrides: Partial<BoundaryConfig> = {}): readonly Rule[] =>
  checkProgram(programFor([file]), ROOT, { ...config, ...overrides }).findings.filter((finding) => finding.path === `${FIXTURES}/${file}`).map((finding) => finding.rule);

test("`any` fails", () => assert.deepEqual(rulesFor("any.ts"), ["any-type"]));

test("@ts-ignore fails", () => assert.deepEqual(rulesFor("suppression.ts"), ["suppression-directive"]));

test("@ts-expect-error fails outside the designated negative-fixture directory and is allowed inside it", () => {
  assert.deepEqual(rulesFor("expect-error-outside.ts"), ["suppression-directive"]);
  assert.deepEqual(rulesFor("allowed/expect-error-inside.ts"), []);
});

test("a double assertion fails", () => assert.deepEqual(rulesFor("double-assertion.ts"), ["double-assertion"]));

test("asserting JSON.parse output instead of decoding it fails", () => assert.deepEqual(rulesFor("json-parse.ts"), ["assertion-bypasses-decoder"]));

test("a hand-written copy of a generated protocol type fails", () => assert.deepEqual(rulesFor("duplicate-protocol.ts"), ["duplicate-protocol-type"]));

test("a raw Element or File in a capability message fails", () => {
  const findings = checkProgram(programFor(["browser-object.ts"]), ROOT, config).findings.filter((finding) => finding.path === `${FIXTURES}/browser-object.ts`);
  assert.deepEqual(findings.map((finding) => finding.rule).sort(), ["browser-object-in-message", "browser-object-in-message"]);
  assert.match(findings.map((finding) => finding.detail).join(" "), /Element/);
  assert.match(findings.map((finding) => finding.detail).join(" "), /File/);
});

test("string-operation/untyped-payload capability dispatch and computed calls fail", () => {
  assert.deepEqual(rulesFor("dynamic-dispatch.ts").slice().sort(), ["dynamic-dispatch", "untyped-capability-dispatch", "untyped-capability-dispatch"]);
});

test("non-exhaustive handling of a closed union fails, including a default that swallows new variants", () => {
  assert.deepEqual(rulesFor("non-exhaustive.ts"), ["non-exhaustive-union", "non-exhaustive-union"]);
});

test("eval, Function and string timers fail", () => assert.deepEqual(rulesFor("script-execution.ts"), ["script-execution", "script-execution", "script-execution"]));

test("HTML injection sinks fail", () => assert.deepEqual(rulesFor("html-sink.ts"), ["html-injection-sink", "html-injection-sink", "html-injection-sink"]));

test("pasting the generated marker into a hand-written file exempts nothing", () => assert.deepEqual(rulesFor("pasted-marker.ts"), ["double-assertion"]));

test("legitimate browser mechanics remain expressible", () => assert.deepEqual(rulesFor("clean.ts"), []));

test("a sanctioned exception applies only to its file and rule", () => {
  assert.deepEqual(rulesFor("any.ts", { sanctioned: [{ path: `${FIXTURES}/any.ts`, rule: "any-type", reason: "fixture" }] }), []);
  assert.deepEqual(rulesFor("double-assertion.ts", { sanctioned: [{ path: `${FIXTURES}/any.ts`, rule: "double-assertion", reason: "fixture" }] }), ["double-assertion"]);
});

test("known debt is a ratchet: exact counts pass, new findings fail, paid-down debt must be recorded", () => {
  const program = programFor(["script-execution.ts"]);
  const debt = (count: number) => ({ knownDebt: [{ path: `${FIXTURES}/script-execution.ts`, rule: "script-execution" as const, count, workItem: "WI-0000", reason: "fixture" }] });
  assert.deepEqual(checkProgram(program, ROOT, { ...config, ...debt(3) }), { findings: [], staleDebt: [] });
  assert.equal(checkProgram(program, ROOT, { ...config, ...debt(2) }).findings.length, 3, "one more than declared: nothing is excused");
  assert.deepEqual(checkProgram(program, ROOT, { ...config, ...debt(4) }).staleDebt, [{ path: `${FIXTURES}/script-execution.ts`, rule: "script-execution", declared: 4, actual: 3 }]);
});

test("every rule tells the agent the approved alternative", () => {
  for (const [rule, remedy] of Object.entries(REMEDIES)) assert.ok(remedy.length > 30, `${rule} has no useful remedy`);
});

test("the repository's handwritten boundary TypeScript passes", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/check-typescript.ts"], { cwd: ROOT, encoding: "utf8" });
  assert.match(output, /Restricted TypeScript checks passed/);
});

test("coverage is default-deny: every handwritten TypeScript file under src/ and site/app/ is in the restricted subset", async () => {
  const { matches } = await import("../tools/guardrails/layers.ts");
  const boundary = JSON.parse(await readFile(join(ROOT, "architecture/typescript-boundary.json"), "utf8")) as { files: readonly string[] };
  const generated = new Set((JSON.parse(await readFile(join(ROOT, "contract/targets.json"), "utf8")) as { outputs: readonly { path: string }[] }).outputs.map((output) => output.path));
  const handwritten = [...ts.sys.readDirectory(join(ROOT, "src"), [".ts"]), ...ts.sys.readDirectory(join(ROOT, "site/app"), [".ts"])]
    .map((file) => file.slice(ROOT.length + 1))
    .filter((path) => !path.endsWith(".d.ts") && !generated.has(path));
  const uncovered = handwritten.filter((path) => !boundary.files.some((glob) => matches(glob, path)));
  assert.deepEqual(uncovered, [], "add these to architecture/typescript-boundary.json `files` (or fix them until they pass)");
  assert.ok(handwritten.includes("src/main.ts") && handwritten.includes("site/app/federation-proof.ts"));
});
