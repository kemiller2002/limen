// Dependency directions (kemiller2002/limen#53): Core never imports optional
// capability packs or application code, packs never import each other, the
// reference engine never touches browser mechanism, nothing in the published
// package imports an external module, engine libraries acquire no host
// authority, and no browser runtime type appears in core-contract code.
// The rules are architecture/layers.json; the logic is tools/guardrails/layers.ts.

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { checkLayers, describeViolation, parseLayerMap } from "../tools/guardrails/layers.ts";

const ROOT = process.cwd();

const walk = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? (["bin", "obj", "target", "node_modules"].includes(entry.name) ? Promise.resolve([]) : walk(path)) : Promise.resolve([path]);
  }));
  return nested.flat();
};

const map = parseLayerMap(JSON.parse(await readFile(join(ROOT, "architecture/layers.json"), "utf8")) as unknown);
const paths = (await Promise.all(["src", "libraries"].map((directory) => walk(join(ROOT, directory))))).flat();
const files = await Promise.all(paths.map(async (path) => ({ path: relative(ROOT, path).replace(/\\/g, "/"), source: await readFile(path, "utf8") })));
const violations = checkLayers(map, files);

if (violations.length > 0) {
  console.error(`Layer checks failed (${violations.length} violation(s)):\n${violations.map(describeViolation).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Layer checks passed (${files.length} files, ${map.layers.length} layers).`);
}
