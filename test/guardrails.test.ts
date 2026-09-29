// The guardrail suite cannot be silently switched off (kemiller2002/limen#51
// §11). The required gates are listed in architecture/guardrails.json, which is
// itself guardrail-owned; this test fails if any of them disappears from the
// place that runs it, or if a strictness setting is weakened.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (path: string): Promise<string> => readFile(join(ROOT, path), "utf8");

type Gates = {
  readonly testScript: readonly string[];
  readonly ciSteps: readonly string[];
  readonly tsconfigCompilerOptions: Readonly<Record<string, unknown>>;
  readonly fsprojProperties: Readonly<Record<string, string>>;
  readonly csprojProperties: Readonly<Record<string, string>>;
  readonly rustLibAttributes: readonly string[];
};

const gates = (JSON.parse(await read("architecture/guardrails.json")) as { requiredGates: Gates }).requiredGates;

const findFiles = async (directory: string, suffix: string): Promise<readonly string[]> => {
  const entries = await readdir(join(ROOT, directory), { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return ["bin", "obj", "target"].includes(entry.name) ? Promise.resolve([]) : findFiles(path, suffix);
    return Promise.resolve(entry.name.endsWith(suffix) ? [path] : []);
  }));
  return nested.flat();
};

test("npm test runs every required check", async () => {
  const scripts = (JSON.parse(await read("package.json")) as { scripts: Record<string, string> }).scripts;
  const testScript = scripts.test ?? "";
  for (const gate of gates.testScript) {
    assert.ok(testScript.includes(`npm run ${gate}`), `npm test no longer runs ${gate}`);
    assert.ok(scripts[gate] !== undefined && scripts[gate].trim().length > 0, `script ${gate} is missing or empty`);
  }
  assert.ok(testScript.includes("--test test/*.test.ts"), "npm test no longer runs the whole test suite");
});

test("CI still runs every required step", async () => {
  const ci = await read(".github/workflows/ci.yml");
  for (const step of gates.ciSteps) assert.ok(ci.includes(`run: ${step}`), `ci.yml no longer runs "${step}"`);
  assert.match(ci, /fetch-depth: 0/, "the scope check needs full history");
});

test("TypeScript strictness has not been relaxed", async () => {
  for (const file of ["tsconfig.json", "tsconfig.examples.json", "tsconfig.site.json"]) {
    // tsconfig files are JSONC: drop line and block comments before parsing.
    const jsonc = (await read(file)).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const options = (JSON.parse(jsonc) as { compilerOptions?: Record<string, unknown>; extends?: string }).compilerOptions ?? {};
    for (const [option, value] of Object.entries(gates.tsconfigCompilerOptions)) {
      if (file !== "tsconfig.json" && options[option] === undefined) continue; // inherited or not set by a narrower config
      assert.equal(options[option], value, `${file}: compilerOptions.${option} must be ${String(value)}`);
    }
  }
});

test("every F# and C# guest project keeps its strict settings", async () => {
  const projects = [...await findFiles("guests", ".fsproj"), ...await findFiles("guests", ".csproj")];
  assert.ok(projects.length >= 4, "guest projects not found");
  for (const project of projects) {
    const source = await read(project);
    const required = project.endsWith(".fsproj") ? gates.fsprojProperties : gates.csprojProperties;
    for (const [property, value] of Object.entries(required)) {
      assert.ok(source.includes(`<${property}>${value}</${property}>`), `${project}: <${property}>${value}</${property}> is required`);
    }
    assert.doesNotMatch(source, /<NoWarn>|--nowarn|WarningsNotAsErrors/, `${project}: suppressing warnings is a guardrail change`);
  }
});

test("every Rust guest crate forbids unsafe code and denies warnings", async () => {
  const libraries = (await findFiles("guests/rust", "lib.rs"));
  assert.ok(libraries.length >= 1);
  for (const library of libraries) {
    const source = await read(library);
    for (const attribute of gates.rustLibAttributes) assert.ok(source.includes(attribute), `${library}: ${attribute} is required`);
    assert.doesNotMatch(source, /#!\[allow\(/, `${library}: crate-wide allow() is a guardrail change`);
  }
});

test("guardrail-owned paths are reviewed by the code owner", async () => {
  const owners = await read(".github/CODEOWNERS");
  for (const path of ["/architecture/", "/tools/guardrails/", "/tools/contract-gen/", "/scripts/check-*.ts", "/.github/workflows/", "/.github/CODEOWNERS"]) {
    assert.ok(owners.includes(path), `CODEOWNERS no longer covers ${path}`);
  }
});
