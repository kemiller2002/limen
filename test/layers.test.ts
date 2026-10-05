// Dependency-direction guardrail (kemiller2002/limen#53). Each rule has a
// fixture that must fail, and the real repository must pass.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkLayers, importsOf, parseLayerMap, type SourceFile } from "../tools/guardrails/layers.ts";
import { parseUnit } from "../tools/contract-gen/model.ts";

const rawMap = JSON.parse(await readFile(new URL("../architecture/layers.json", import.meta.url), "utf8")) as { protocolForbiddenTypes: { names: string[] } };
const map = parseLayerMap(rawMap);

const rules = (files: readonly SourceFile[]): readonly string[] => checkLayers(map, files).map((violation) => violation.rule);

test("Core importing a capability pack fails, naming the approved alternative", () => {
  const violations = checkLayers(map, [
    { path: "src/kernel/browser-kernel.ts", source: `import { focusCapability } from "../capabilities/focus/provider.js";` },
    { path: "src/capabilities/focus/provider.ts", source: `export const focusCapability = () => 1;` },
  ]);
  assert.deepEqual(violations.map((violation) => violation.rule), ["layer-direction"]);
  assert.match(violations[0]!.detail, /core-kernel must not import capability-pack/);
  assert.match(violations[0]!.remedy, /composition root/);
  assert.match(violations[0]!.path, /^src\/kernel\/browser-kernel\.ts:1$/);
});

test("Core importing application code fails", () => {
  assert.deepEqual(rules([{ path: "src/protocol.ts", source: `import type { State } from "./engine/domain.js";` }]), ["layer-direction"]);
  assert.deepEqual(rules([{ path: "src/kernel/handshake.ts", source: `export { ReferenceEngine } from "../engine/engine.js";` }]), ["layer-direction"]);
});

test("a capability pack importing application code fails", () => {
  assert.deepEqual(rules([{ path: "src/capabilities/focus/provider.ts", source: `import { project } from "../../engine/engine.js";` }]), ["layer-direction"]);
});

test("a capability pack importing another pack fails; importing Core and itself is allowed", () => {
  assert.deepEqual(rules([{ path: "src/capabilities/focus/provider.ts", source: `import { x } from "../scroll/generated.js";` }]), ["capability-pack-cross-import"]);
  assert.deepEqual(rules([{ path: "src/capabilities/focus/provider.ts", source: `import { defineCapability } from "../../kernel/capabilities.js";\nimport { decode } from "./generated/focus.codec.js";\nimport type { CorrelationId } from "../../protocol.js";` }]), []);
});

test("the reference engine touching browser mechanism fails", () => {
  assert.deepEqual(rules([{ path: "src/engine/domain.ts", source: `import { BrowserKernel } from "../kernel/browser-kernel.js";` }]), ["layer-direction"]);
});

test("an external package in the published package fails (zero runtime dependencies)", () => {
  assert.deepEqual(rules([{ path: "src/kernel/browser-kernel.ts", source: `import lodash from "lodash";` }]), ["external-dependency"]);
  assert.deepEqual(rules([{ path: "src/protocol.ts", source: `import { readFile } from "node:fs";` }]), ["external-dependency"]);
});

test("a dynamic import with a computed target in Core fails as unresolvable", () => {
  assert.deepEqual(rules([{ path: "src/kernel/browser-kernel.ts", source: "const pack = await import(`../capabilities/${name}/provider.js`);" }]), ["unresolvable-import"]);
});

test("imports quoted in comments or strings are not imports", () => {
  assert.deepEqual(importsOf(`// import x from "../capabilities/focus/provider.js";\n/* export * from "lodash"; */\nconst s = "import y from 'z'";`), []);
});

test("engine authority is not a layer rule: one rule set lives in architecture/boundary-rules.json", () => {
  // Engine libraries are checked by scripts/check-architecture.ts through
  // tools/guardrails/boundary.ts (test/boundary-rules.test.ts). A second token
  // list in the layer map is refused so the two cannot drift apart again.
  assert.equal("engineLibraries" in (rawMap as Record<string, unknown>), false);
  assert.throws(() => parseLayerMap({ ...rawMap, engineLibraries: { paths: ["libraries/**"], forbidden: {} } }), /boundary-rules\.json/);
});

test("a browser runtime type in core-contract code fails", () => {
  assert.deepEqual(rules([{ path: "src/protocol.ts", source: `export type Upload = { readonly file: File };` }]), ["browser-object-in-protocol"]);
  assert.deepEqual(rules([{ path: "src/generated/core.ts", source: `export type Target = { readonly element: Element };` }]), ["browser-object-in-protocol"]);
  // A string literal or a longer identifier is not a reference to the type.
  assert.deepEqual(rules([{ path: "src/protocol.ts", source: `export type SemanticEvent = { readonly kind: "Event"; readonly name: string }; type FileName = string;` }]), []);
});

test("a contract type named after a browser runtime object is rejected by the generator", () => {
  const parsed = parseUnit({ unit: "limen.test", role: "capability", version: 1, types: [{ name: "File", kind: "record", fields: [{ name: "name", type: "string" }] }] }, "fixture", rawMap.protocolForbiddenTypes.names);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.match(parsed.errors.join("\n"), /File: names a browser runtime object/);
});

test("the repository itself satisfies every layer rule", async () => {
  const { execFileSync } = await import("node:child_process");
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/check-layers.ts"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  assert.match(output, /Layer checks passed/);
});
