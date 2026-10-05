// The minimal-agent learning contract (kemiller2002/limen#63). The real
// documents satisfy it; each way of breaking it is a fixture that fails; and a
// legitimate optional capability ships without touching the Core model.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseCoreManifest, type CoreManifest } from "../tools/guardrails/core.ts";
import { checkLearning, conceptsIn, isOptionalDoc, linksIn, parseLearning, type Document } from "../tools/guardrails/learning.ts";

const ROOT = join(import.meta.dirname, "..");
const rawManifest = JSON.parse(await readFile(join(ROOT, "architecture/core.json"), "utf8")) as unknown;
const manifest = parseCoreManifest(rawManifest);
const learning = parseLearning(rawManifest);
const read = async (path: string): Promise<Document> => ({ path, text: await readFile(join(ROOT, path), "utf8") });
const documents: readonly Document[] = await Promise.all([
  ...new Set([learning.canonical, learning.requiredReading.file, ...learning.path, ...learning.quickStarts, ...(await readdir(join(ROOT, "docs"))).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`), "README.md"]),
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
  const federated = replaced("docs/quick-start.md", (text) => `${text}\n\`\`\`ts\nimport { ModuleFederation } from "@echelon-foundry/limen/federation";\n\`\`\`\n`);
  assert.deepEqual(rules(federated), ["quick-start-optional-import"]);
});

test("importing an optional name from the package root fails anywhere", () => {
  const fromRoot = replaced("README.md", (text) => `${text}\n\`\`\`ts\nimport { BrowserKernel, ReferenceEngine } from "@echelon-foundry/limen";\n\`\`\`\n`);
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

test("which documents are optional is a pattern: every subsystem document from 20 up, except Core's own", () => {
  const optional = documents.map((document) => document.path).filter((path) => isOptionalDoc(learning, path));
  assert.ok(optional.length >= 32, optional.join(", "));
  for (const path of ["docs/23-wasm-federation.md", "docs/53-cross-context-coordination.md", "docs/54-server-rendering.md"]) assert.ok(optional.includes(path), path);
  for (const path of ["docs/24-contract-and-capabilities.md", "docs/25-guardrails.md", "docs/29-binding-security.md", "docs/core-mental-model.md", "docs/11-api-reference.md"]) assert.ok(!optional.includes(path), path);
});

test("a legitimate optional capability ships without changing the Core model, its reading, or the manifest", () => {
  const packDoc: Document = {
    path: "docs/99-vibration.md",
    text: "# Vibration\n\n> **Optional — not Limen Core.** This is the vibration pack, a capability pack. It composes with the Core concept `typed-capabilities`: it is requested through the generic Capability seam.\n\nimport { vibrationCapability } from \"@echelon-foundry/limen/capabilities/vibration\";\n",
  };
  assert.deepEqual(checkLearning(manifest, learning, [...documents, packDoc]), []);
  // The same document without its banner is caught, with no manifest edit either way.
  const unbannered = { ...packDoc, text: packDoc.text.replace(/^> .*$/m, "") };
  assert.deepEqual(checkLearning(manifest, learning, [...documents, unbannered]).map((found) => found.rule), ["optional-doc-banner"]);
});

test("links are read as repository paths, relative or absolute", () => {
  assert.deepEqual(linksIn("[a](docs/x.md) [b](https://github.com/kemiller2002/limen/blob/main/src/protocol.ts#L1) [c](../y.md)", "docs/z.md"), ["docs/docs/x.md", "src/protocol.ts", "y.md"]);
});
