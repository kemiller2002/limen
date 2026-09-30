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
  readonly unsafeAbiCrates: { readonly paths: readonly string[] };
  readonly warningsNotAsErrors: { readonly entries: readonly Sanctioned[] };
};

type Sanctioned = { readonly project: string; readonly warnings: readonly string[]; readonly decision: string; readonly reason: string };

// A guest project may keep a warning from failing its build only exactly as
// architecture/guardrails.json declares, and may never hide one.
const warningViolations = (project: string, source: string, sanctioned: readonly Sanctioned[]): readonly string[] => {
  const declared = sanctioned.find((entry) => entry.project === project);
  const kept = [...source.matchAll(/<WarningsNotAsErrors>([^<]*)<\/WarningsNotAsErrors>/g)].flatMap((match) => (match[1] ?? "").split(";").map((id) => id.trim()).filter((id) => id !== ""));
  const expected = [...(declared?.warnings ?? [])].sort();
  return [
    ...(/<NoWarn>|--nowarn/.test(source) ? [`${project}: hiding warnings (NoWarn, --nowarn) is not allowed`] : []),
    ...(JSON.stringify([...kept].sort()) === JSON.stringify(expected) ? [] : [`${project}: WarningsNotAsErrors is [${kept.join(", ")}], but architecture/guardrails.json declares [${expected.join(", ")}]`]),
  ];
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
    assert.deepEqual(warningViolations(project, source, gates.warningsNotAsErrors.entries), [], `${project}: suppressing warnings is a guardrail change`);
  }
});

test("a warning kept from failing the build is declared exactly, with the owner's decision and a reason", async () => {
  const entries = gates.warningsNotAsErrors.entries;
  const projects = [...await findFiles("guests", ".fsproj"), ...await findFiles("guests", ".csproj")];
  for (const entry of entries) {
    assert.ok(projects.includes(entry.project), `${entry.project}: a declared exception names a project that does not exist`);
    assert.ok(entry.warnings.length > 0 && entry.warnings.every((id) => /^[A-Z]+[0-9]+$/.test(id)), `${entry.project}: exceptions are exact warning ids`);
    assert.match(entry.decision, /^https:\/\/github\.com\//, `${entry.project}: an exception links the owner's decision`);
    assert.ok(entry.reason.length >= 40, `${entry.project}: an exception says why`);
  }
  const project = "guests/example/Example.csproj";
  const only = [{ project, warnings: ["IL2040"], decision: "https://github.com/x", reason: "r" }];
  assert.deepEqual(warningViolations(project, "<WarningsNotAsErrors>IL2040</WarningsNotAsErrors>", only), []);
  assert.equal(warningViolations(project, "<WarningsNotAsErrors>IL2040;IL2026</WarningsNotAsErrors>", only).length, 1, "a broader list is refused");
  assert.equal(warningViolations("guests/other/Other.csproj", "<WarningsNotAsErrors>IL2040</WarningsNotAsErrors>", only).length, 1, "an undeclared project is refused");
  assert.equal(warningViolations(project, "<NoWarn>IL2040</NoWarn><WarningsNotAsErrors>IL2040</WarningsNotAsErrors>", only).length, 1, "hiding is refused even when declared");
  assert.equal(warningViolations(project, "", only).length, 1, "a declared exception that is no longer used must be removed");
});

test("every Rust guest crate forbids unsafe code and denies warnings, except the sanctioned ABI shims", async () => {
  const libraries = await findFiles("guests", "lib.rs");
  assert.ok(libraries.length >= 3);
  const shims = gates.unsafeAbiCrates.paths;
  for (const library of libraries) {
    const source = await read(library);
    if (shims.includes(library)) {
      assert.match(source, /JUSTIFIED UNSAFE BOUNDARY/, `${library}: an unsafe ABI shim must state its justification`);
      assert.ok(source.includes("#![deny(warnings)]"), `${library}: #![deny(warnings)] is required`);
      assert.doesNotMatch(source, /#!\[allow\((?!unsafe_code\))/, `${library}: only unsafe_code may be allowed, and only here`);
      continue;
    }
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
