// The minimal-agent learning contract (kemiller2002/limen#63). The real
// documents satisfy it; each way of breaking it is a fixture that fails; and a
// legitimate optional capability ships without touching the Core model.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseCoreManifest, type CoreManifest } from "../tools/guardrails/core.ts";
import { checkLearning, conceptsIn, linksIn, parseLearning, type Document } from "../tools/guardrails/learning.ts";

const ROOT = join(import.meta.dirname, "..");
const rawManifest = JSON.parse(await readFile(join(ROOT, "architecture/core.json"), "utf8")) as unknown;
const manifest = parseCoreManifest(rawManifest);
const learning = parseLearning(rawManifest);
const read = async (path: string): Promise<Document> => ({ path, text: await readFile(join(ROOT, path), "utf8") });
const documents: readonly Document[] = await Promise.all([
  ...new Set([learning.canonical, learning.requiredReading.file, ...learning.path, ...learning.quickStarts, ...learning.optionalDocs, "docs/18-naming-and-compatibility.md", "docs/13-anti-patterns.md", "docs/USAGE.md", "README.md"]),
].map(read));

const replaced = (path: string, change: (text: string) => string): readonly Document[] =>
  documents.map((document) => (document.path === path ? { path, text: change(document.text) } : document));
const rules = (docs: readonly Document[], using: CoreManifest = manifest): readonly string[] => checkLearning(using, learning, docs).map((found) => found.rule);

test("the repository's documents satisfy the learning contract", () => {
  assert.deepEqual(checkLearning(manifest, learning, documents), []);
});

test("the canonical document teaches exactly the seven manifest concepts, and the learning path is four documents", () => {
  const canonical = documents.find((document) => document.path === learning.canonical)?.text ?? "";
  assert.deepEqual(conceptsIn(canonical), manifest.concepts);
  assert.equal(conceptsIn(canonical).length, 7);
  assert.deepEqual(learning.path, ["docs/core-mental-model.md", "docs/where-code-goes.md", "src/protocol.ts", "examples/minimal/README.md"]);
});

test("an eighth mandatory concept in the canonical document fails", () => {
  const eight = replaced(learning.canonical, (text) => text.replace("## The minimal learning path", "8. **Components own their state.** `components`\n   A component tree.\n\n## The minimal learning path"));
  assert.deepEqual(rules(eight), ["canonical-concepts"]);
  // Admitting it into the manifest alone is not enough: the manifest caps concepts at seven.
  assert.deepEqual(rules(eight, { ...manifest, concepts: [...manifest.concepts, "components"] }), []);
});

test("an optional document inserted into required reading fails", () => {
  const inserted = replaced("AGENTS.md", (text) => text.replace("<!-- core-learning-path:end -->", "5. [docs/23-wasm-federation.md](docs/23-wasm-federation.md) — federation\n<!-- core-learning-path:end -->"));
  const found = checkLearning(manifest, learning, inserted);
  assert.deepEqual(found.map((violation) => violation.rule), ["optional-in-required-reading"]);
  assert.match(found[0]?.detail ?? "", /docs\/23-wasm-federation\.md/);
});

test("required reading that drops a Core document fails", () => {
  assert.deepEqual(rules(replaced("AGENTS.md", (text) => text.replace(/^3\. \[`src\/protocol\.ts`\].*$/m, ""))), ["learning-path-incomplete"]);
});

test("a quick start importing an optional surface fails", () => {
  const federated = replaced("docs/quick-start.md", (text) => `${text}\n\`\`\`ts\nimport { ModuleFederation } from "@echelon-foundry/typescript-wasm-kernel/federation";\n\`\`\`\n`);
  assert.deepEqual(rules(federated), ["quick-start-optional-import"]);
});

test("importing an optional name from the package root fails anywhere", () => {
  const fromRoot = replaced("README.md", (text) => `${text}\n\`\`\`ts\nimport { BrowserKernel, ReferenceEngine } from "@echelon-foundry/typescript-wasm-kernel";\n\`\`\`\n`);
  const found = checkLearning(manifest, learning, fromRoot);
  assert.deepEqual(found.map((violation) => violation.rule), ["optional-import-from-root"]);
  assert.match(found[0]?.detail ?? "", /ReferenceEngine/);
});

test("an optional document that does not name the Core concept it composes with fails", () => {
  const unbannered = replaced("docs/34-scheduling.md", (text) => text.split("\n").filter((line) => !line.startsWith("> **Optional")).join("\n"));
  assert.deepEqual(rules(unbannered), ["optional-doc-banner"]);
  const unknownConcept = replaced("docs/34-scheduling.md", (text) => text.replace("`typed-capabilities`", "`timers`"));
  assert.deepEqual(rules(unknownConcept), ["optional-doc-banner"]);
});

test("a legitimate optional capability ships without changing the Core model or its reading", () => {
  const packDoc: Document = {
    path: "docs/54-vibration.md",
    text: "# Vibration\n\n> **Optional — not Limen Core.** This is the vibration pack, a capability pack. It composes with the Core concept `typed-capabilities`: it is requested through the generic Capability seam.\n\nimport { vibrationCapability } from \"@echelon-foundry/typescript-wasm-kernel/capabilities/vibration\";\n",
  };
  const withPack = { ...learning, optionalDocs: [...learning.optionalDocs, packDoc.path] };
  assert.deepEqual(checkLearning(manifest, withPack, [...documents, packDoc]), []);
});

test("links are read as repository paths, relative or absolute", () => {
  assert.deepEqual(linksIn("[a](docs/x.md) [b](https://github.com/kemiller2002/limen/blob/main/src/protocol.ts#L1) [c](../y.md)", "docs/z.md"), ["docs/docs/x.md", "src/protocol.ts", "y.md"]);
});
