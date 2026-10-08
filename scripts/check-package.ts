// Verifies what an npm consumer actually receives.
//
// "It works in the repository" is not the same claim as "it works when
// installed", and the gap between them is invisible until someone installs the
// package. Three things are checked here:
//
//   1. The tarball contains everything the documentation promises, and nothing
//      that should never be published.
//   2. Every link in packaged Markdown resolves — a relative one to another
//      packaged file, an absolute repository one to a path that exists.
//   3. Every repository path named in packaged prose exists.
//
// Run by `npm test`. Uses `npm pack --dry-run --ignore-scripts`: without
// --ignore-scripts, prepack would run `npm run check`, which runs this script,
// which packs again.
//
//   4. The minimal root consumer (kemiller2002/limen#61): every Core subpath's
//      transitive graph in the packed dist/ holds emitted Core files only, the
//      root's declarations export only approved Core names, and federation and
//      the reference engine stay reachable through their explicit subpaths.
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, normalize, posix, resolve } from "node:path";
import { promisify } from "node:util";
import { emittedPath, exportedNames, exportTargets, moduleClosure, parseCoreManifest } from "../tools/guardrails/core.ts";

const ROOT = resolve(import.meta.dirname, "..");
const REPO = "https://github.com/kemiller2002/limen/";
const run = promisify(execFile);

// Files a consumer or the documentation explicitly depends on. Anything here
// that goes missing is a broken promise, not a cosmetic change.
const REQUIRED = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "architecture.yaml",
  "bin/limen.js",
  // The published entry points, as declared in package.json "exports".
  "dist/index.js", "dist/index.d.ts",
  "dist/protocol.js", "dist/protocol.d.ts",
  "dist/federation.js", "dist/federation.d.ts",
  "dist/kernel/browser-kernel.js", "dist/kernel/browser-kernel.d.ts",
  "dist/kernel/diagnostics.js", "dist/kernel/diagnostics.d.ts",
  "dist/engine/index.js", "dist/engine/index.d.ts",
  "dist/engine/transport.js", "dist/engine/transport.d.ts",
  "dist/routing/index.js", "dist/routing/index.d.ts",
  // The route inventory schema (LCP-108): Praxis and Conditor validate
  // .echelon/routes.json against it without running the application.
  "contract/routes.schema.json",
  // The documentation set. README.md alone leaves a consumer with links they
  // cannot follow offline; these six are the ones worth carrying.
  "docs/core-mental-model.md",
  "docs/quick-start.md",
  "docs/mental-model.md",
  "docs/where-code-goes.md",
  "docs/11-api-reference.md",
  "docs/16-troubleshooting.md",
  "docs/glossary.md",
  "docs/23-wasm-federation.md",
  "docs/README.md",
  // One complete application, so a consumer never has to clone the repository
  // to see how the pieces fit together.
  "examples/minimal/README.md",
  "examples/minimal/index.html",
  "examples/minimal/engine.js",
  "examples/minimal/main.js",
  "examples/minimal/package.json",
  "examples/minimal/types.check.ts",
] as const;

// Publishing any of these would be a mistake ranging from wasteful to unsafe.
const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  { pattern: /^src\//, why: "source is published as dist/, not src/" },
  { pattern: /^test\//, why: "tests are not part of the consumer surface" },
  { pattern: /^dist\/main\./, why: "the demo entry point must not ship" },
  { pattern: /^(research|missions|prompts|registries|templates|schemas|context|input-document)\//, why: "internal research and process artifacts" },
  { pattern: /^(\.ros|\.sde|\.github|framework|tools|site|cli)\//, why: "repository tooling, not consumer code" },
  // examples/README.md is the one exception, and not by choice: npm always
  // includes a README from any directory it packs, and a "!" negation in
  // "files" does not remove it. It is made npm-safe instead — absolute links,
  // and a banner saying which example actually ships.
  { pattern: /^examples\/(?!minimal\/|README\.md$)/, why: "only examples/minimal/ is small enough to ship" },
  { pattern: /^docs\/00-governance\//, why: "governance process, not consumer documentation" },
  { pattern: /(^|\/)\.env|\.pem$|\.key$|(^|\/)\.npmrc$/, why: "possible secret" },
  { pattern: /(^|\/)node_modules\//, why: "never" },
];

// Directories a packaged file may live in at all. A file outside these is not
// necessarily wrong, but it is unintended, and saying so is the point.
const ALLOWED_PREFIXES = ["dist/", "bin/", "runtimes/", "docs/", "examples/minimal/"];
const ALLOWED_ROOT_FILES = new Set(["package.json", "README.md", "CHANGELOG.md", "LICENSE", "architecture.yaml"]);
// examples/README.md is forced in by npm (see the note in FORBIDDEN above); the
// route inventory schema ships on purpose (LCP-108).
const ALLOWED_EXTRA = new Set(["examples/README.md", "contract/routes.schema.json"]);

type PackEntry = { readonly path: string };
type PackResult = readonly { readonly files: readonly PackEntry[]; readonly size: number; readonly unpackedSize: number }[];

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

async function packedFiles(): Promise<{ files: string[]; size: number; unpackedSize: number }> {
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 });
  const parsed = JSON.parse(stdout) as PackResult;
  const first = parsed[0];
  if (!first) throw new Error("npm pack --json returned no package");
  return {
    files: first.files.map((entry) => entry.path.split("\\").join("/")),
    size: first.size,
    unpackedSize: first.unpackedSize,
  };
}

const violations: string[] = [];
const { files, size, unpackedSize } = await packedFiles();
const packed = new Set(files);

// --- 1. contents -----------------------------------------------------------

for (const required of REQUIRED) {
  if (!packed.has(required)) violations.push(`missing from the tarball: ${required}`);
}

for (const file of files) {
  for (const { pattern, why } of FORBIDDEN) {
    if (pattern.test(file)) violations.push(`must not be published: ${file} — ${why}`);
  }
  const allowed = ALLOWED_ROOT_FILES.has(file) || ALLOWED_EXTRA.has(file)
    || ALLOWED_PREFIXES.some((prefix) => file.startsWith(prefix));
  if (!allowed) violations.push(`unexpected in the tarball: ${file} (add it to ALLOWED_PREFIXES if intended)`);
}

// The CLI binaries are built by `npm run build:cli:all`, which needs the .NET
// SDK. Their absence locally is expected; their absence in a release is not, so
// this reports rather than fails, and the publish workflow builds them.
const hasRuntimes = files.some((file) => file.startsWith("runtimes/"));

// --- 2. links inside packaged documentation --------------------------------

const LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const withoutCodeFences = (source: string): string => source.replace(/```[\s\S]*?```/g, "");

for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
  const body = withoutCodeFences(await readFile(join(ROOT, file), "utf8"));
  const here = posix.dirname(file);

  for (const [, target] of body.matchAll(LINK)) {
    if (!target || target.startsWith("#") || target.startsWith("mailto:")) continue;

    if (target.startsWith(REPO)) {
      // A link back into the repository: the path has to be real, or it is a
      // 404 for every reader who follows it from npmjs.com.
      const rest = target.slice(REPO.length).replace(/^(blob|tree)\/main\//, "").split("#")[0] ?? "";
      if (rest !== "" && !(await exists(join(ROOT, decodeURIComponent(rest))))) {
        violations.push(`${file}: repository link points at a path that does not exist -> ${target}`);
      }
      continue;
    }
    if (/^https?:\/\//.test(target)) continue;

    // A relative link must resolve to something that is ALSO in the tarball.
    // Otherwise it works on GitHub and dies in node_modules.
    const resolvedPath = normalize(posix.join(here, target.split("#")[0] ?? "")).split("\\").join("/");
    const candidates = [resolvedPath, `${resolvedPath}/README.md`, resolvedPath.replace(/\/$/, "/README.md")];
    if (!candidates.some((candidate) => packed.has(candidate.replace(/^\.\//, "")))) {
      violations.push(`${file}: relative link leaves the package -> ${target} (use an absolute ${REPO}… link)`);
    }
  }
}

// --- 3. repository paths named in packaged prose ---------------------------

const MENTION = /`((?:src|test|docs|examples|scripts|cli|bin|dist)\/[A-Za-z0-9._/-]+\.[A-Za-z]+)`/g;
for (const file of files.filter((candidate) => candidate.endsWith(".md"))) {
  const body = withoutCodeFences(await readFile(join(ROOT, file), "utf8"));
  for (const [, mention] of body.matchAll(MENTION)) {
    if (mention && !(await exists(join(ROOT, mention)))) {
      violations.push(`${file}: names a path that does not exist -> ${mention}`);
    }
  }
}

// --- 4. the minimal root consumer ------------------------------------------

const manifest = parseCoreManifest(JSON.parse(await readFile(join(ROOT, "architecture/core.json"), "utf8")) as unknown);
const packageJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as unknown;
const targets = exportTargets(packageJson);
const coreEmitted = new Set([...manifest.files.map((file) => emittedPath(file.path)), emittedPath(manifest.coreEntrypoints["."] ?? "src/index.ts")]);
const packedSources = new Map(await Promise.all(files.filter((file) => file.endsWith(".js")).map(async (file) => [file, await readFile(join(ROOT, file), "utf8")] as const)));
const resolveEmitted = (from: string, specifier: string): string | undefined =>
  specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), specifier)) : undefined;

for (const subpath of Object.keys(manifest.coreEntrypoints)) {
  const entry = targets[subpath];
  if (entry === undefined || !packed.has(entry)) {
    violations.push(`the Core subpath "${subpath}" does not resolve to a packed file (exports: ${entry ?? "missing"})`);
    continue;
  }
  for (const module of moduleClosure([entry], (path) => packedSources.get(path), resolveEmitted)) {
    if (!packed.has(module)) violations.push(`the Core subpath "${subpath}" imports ${module}, which is not in the tarball`);
    else if (!coreEmitted.has(module)) violations.push(`the minimal consumer of "${subpath}" loads ${module}, which is not Core — export it from its own optional subpath`);
  }
}
for (const subpath of Object.keys(manifest.optionalEntrypoints)) {
  const entry = targets[subpath];
  if (entry === undefined || !packed.has(entry)) violations.push(`the optional subpath "${subpath}" does not resolve to a packed file (exports: ${entry ?? "missing"}); optional surfaces must stay reachable by explicit import`);
}
const approvedRoot = new Set(manifest.families.flatMap((family) => family.names));
const rootDeclarations = await readFile(join(ROOT, "dist/index.d.ts"), "utf8").catch(() => "");
for (const name of exportedNames(rootDeclarations).filter((exported) => !approvedRoot.has(exported))) {
  violations.push(`dist/index.d.ts exports ${name}, which is in no approved Core export family (architecture/core.json) — an optional export may not return to the root without Core Admission`);
}

// --- report ----------------------------------------------------------------

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;
  console.log(`Package checks passed: ${files.length} files, ${kb(size)} packed, ${kb(unpackedSize)} unpacked.`);
  if (!hasRuntimes) {
    console.log("Note: no runtimes/ in this tarball — the CLI binaries need `npm run build:cli:all` (.NET SDK 8). The publish workflow builds them.");
  }
}
