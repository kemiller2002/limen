// Architecture checks. Three manifests, no token lists of its own:
//   * the engine-authority boundary — rules from architecture/boundary-rules.json
//     (shared with the consumer `limen verify`), paths from limen.config.json;
//   * .NET WebAssembly host shims — architecture/wasm-hosts.json;
//   * the Core boundary (kemiller2002/limen#60) — architecture/core.json,
//     checked by tools/guardrails/core.ts.

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { checkBoundaryFile, checkHostShim, coveredBy, describeBoundaryFinding, languageOf, parseBoundaryDeclaration, parseBoundaryRules, parseHostShims } from "../tools/guardrails/boundary.ts";
import { checkCore, parseCoreManifest } from "../tools/guardrails/core.ts";
import { describeViolation, parseLayerMap } from "../tools/guardrails/layers.ts";

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8")) as unknown;
const violations: string[] = [];

// The engine-authority boundary. The rules are architecture/boundary-rules.json
// — the same file `limen verify` embeds — and the paths are this repository's
// own limen.config.json, read exactly as a consumer's is. No token list lives
// in this script.
const rules = parseBoundaryRules(await json("architecture/boundary-rules.json"));
const declaration = parseBoundaryDeclaration(await json("limen.config.json"));
if (declaration.kind !== "declared" || declaration.engine.length === 0) {
  violations.push("limen.config.json: Limen must declare its own engine paths; a boundary that checks nothing proves nothing");
}
const engineRoots = declaration.kind === "declared" ? declaration.engine : [];
const kernelRoots = declaration.kind === "declared" ? declaration.kernel : [];

const walk = async (path: string): Promise<readonly string[]> => {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) return [];
  if (info.isFile()) return [path];
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries
    .filter((entry) => !(entry.isDirectory() && rules.neverWalked.includes(entry.name)))
    .map((entry) => walk(join(path, entry.name))));
  return nested.flat();
};
const sourcesUnder = async (roots: readonly string[]): Promise<readonly { readonly path: string; readonly source: string }[]> => {
  const missing = (await Promise.all(roots.map(async (root) => (await stat(root).catch(() => undefined)) === undefined ? [root] : []))).flat();
  violations.push(...missing.map((root) => `limen.config.json: configured boundary path ${root} does not exist`));
  const paths = (await Promise.all(roots.map(walk))).flat().map((path) => relative(".", path).replace(/\\/g, "/")).filter((path) => languageOf(rules, path) !== undefined);
  return Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
};
const engineFiles = await sourcesUnder(engineRoots);
const kernelFiles = await sourcesUnder(kernelRoots);
violations.push(...[
  ...engineFiles.flatMap((file) => checkBoundaryFile(rules, "engine", file.path, file.source)),
  ...kernelFiles.flatMap((file) => checkBoundaryFile(rules, "kernel", file.path, file.source)),
].map((finding) => `${finding.path}: [${finding.rule}] ${describeBoundaryFinding(finding)}`));

// Default deny: every runtime source under src/ and site/app/ is on one side of
// the declared boundary, and every engine project or guest library is engine.
const unclassified = (await files("src")).concat(await files("site/app"))
  .map((path) => relative(".", path).replace(/\\/g, "/"))
  .filter((path) => languageOf(rules, path) !== undefined && !coveredBy([...engineRoots, ...kernelRoots], path));
violations.push(...unclassified.map((path) => `${path}: not on either side of the boundary declared in limen.config.json; add its directory to boundary.engine or boundary.kernel`));
const engineProjects = (await Promise.all(["site", "guests", "libraries"].map((root) => files(root))))
  .flat()
  .map((path) => relative(".", path).replace(/\\/g, "/"))
  .filter((path) => /(^|\/)[^/]*\.(Engine|Guest)\/[^/]+\.(fs|cs)proj$/.test(path) || /^libraries\/.+\.(fs|cs)proj$/.test(path))
  .map((path) => path.slice(0, path.lastIndexOf("/")));
violations.push(...engineProjects.filter((project) => !coveredBy(engineRoots, project))
  .map((project) => `${project}: an engine project outside boundary.engine in limen.config.json; engine authority must be checked`));

// .NET WebAssembly host shims: marshalling only. architecture/wasm-hosts.json
// lists every one; an unlisted shim is a violation.
const hostShims = parseHostShims(await json("architecture/wasm-hosts.json"));
const shimFiles = (await Promise.all(["site", "guests"].map((root) => files(root))))
  .flat()
  .map((path) => relative(".", path).replace(/\\/g, "/"))
  .filter((path) => /\.Wasm\/Program\.cs$/.test(path) && !rules.neverWalked.some((name) => path.split("/").includes(name)));
violations.push(...shimFiles.filter((path) => !hostShims.hosts.some((host) => host.path === path))
  .map((path) => `${path}: a .NET WebAssembly host shim not listed in architecture/wasm-hosts.json`));
for (const host of hostShims.hosts) {
  const source = await readFile(host.path, "utf8").catch(() => undefined);
  if (source === undefined) violations.push(`architecture/wasm-hosts.json: ${host.path} does not exist`);
  else violations.push(...checkHostShim(hostShims, host, source));
}

// The Core boundary, from the manifest.
const manifest = parseCoreManifest(await json("architecture/core.json"));
const layerMap = parseLayerMap(await json("architecture/layers.json"));
const runtimeFiles = await Promise.all((await Promise.all(manifest.runtimeRoots.map((root) => files(root)))).flat()
  .map(async (path) => ({ path: relative(".", path).replace(/\\/g, "/"), source: await readFile(path, "utf8") })));
const coreViolations = checkCore(manifest, layerMap, { files: runtimeFiles, packageJson: await json("package.json"), contract: await json(manifest.capabilityContract) });
violations.push(...coreViolations.map(describeViolation));

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Architecture checks passed (boundary: ${engineFiles.length} engine and ${kernelFiles.length} kernel source files; ${hostShims.hosts.length} WASM host shims; Core ${manifest.architectureVersion}: ${manifest.files.length} Core files, ${runtimeFiles.length} runtime files classified).`);
}
