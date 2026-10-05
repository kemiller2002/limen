// Payload regression fixture (kemiller2002/limen#19, LCP-033): every consumer
// profile in bench/budgets.json stays within its budget and never loads a
// module it must not. Deterministic — sizes, not timings — so it runs in
// `npm test` on every change. Timings are recorded by `npm run bench`.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { importsOf, measureProfile, readBudgets } from "../bench/size.ts";

const ROOT = process.cwd();
const budgets = await readBudgets(ROOT);

for (const profile of budgets.profiles) {
  test(`${profile.name}: within its payload budget and free of forbidden modules`, async () => {
    const closure = await measureProfile(ROOT, profile);
    assert.deepEqual(closure.forbiddenPresent, [], `${profile.name} loads modules it must not`);
    assert.ok(closure.rawBytes <= profile.budget.rawBytes, `${profile.name}: ${closure.rawBytes} raw bytes exceeds the budget of ${profile.budget.rawBytes}`);
    assert.ok(closure.gzipBytesBundled <= profile.budget.gzipBytesBundled, `${profile.name}: ${closure.gzipBytesBundled} gzip bytes exceeds the budget of ${profile.budget.gzipBytesBundled}`);
  });
}

test("optional capability support is absent unless imported: no Core module imports it", async () => {
  const minimal = await measureProfile(ROOT, { name: "probe", doc: "", entries: ["dist/index.js"], forbidden: [] });
  const optional = minimal.modules.filter((module) => /dist\/(capability-support|capabilities|tooling|hosts)\//.test(module));
  assert.deepEqual(optional, []);
  const withHandles = await measureProfile(ROOT, { name: "probe", doc: "", entries: ["dist/kernel/browser-kernel.js", "dist/capability-support/handles.js"], forbidden: [] });
  assert.ok(withHandles.modules.includes("dist/capability-support/handles.js"), "the probe itself must see an explicitly imported module");
});

test("the shipped minimal consumer imports only the package root", async () => {
  const main = await readFile("examples/minimal/main.js", "utf8");
  assert.deepEqual([...main.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]), ["@echelon-foundry/limen", "./engine.js"]);
});

test("the import scanner sees static, re-exported, side-effect and dynamic imports, and skips packages", () => {
  const source = [
    `import { a } from "./a.js";`,
    `import * as b from './b.js';`,
    `export { c } from "./c.js";`,
    `export * from "./d.js";`,
    `import "./e.js";`,
    `const f = await import("./f.js");`,
    `import g from "node:fs";`,
    `import {\n  h,\n  i,\n} from "../h.js";`,
  ].join("\n");
  assert.deepEqual(importsOf(source), ["./a.js", "./b.js", "./c.js", "./d.js", "./e.js", "./f.js", "../h.js"]);
});
