// Documentation verification, run as part of `npm test`.
//
// Documentation rots silently; code does not. These three checks turn the
// most common kinds of doc rot into build failures:
//
//   1. Every relative link in a Markdown file points at a file that exists.
//   2. Every `path/like/this.ts` mentioned in prose actually exists.
//   3. Every document under docs/ is reachable from the README, so nothing
//      becomes an orphan nobody can find.
//
// It deliberately does not check prose quality or external URLs.
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

// Directories that are not part of the kernel's own documentation set. The
// ROS governance framework, the SDE methodology install, and the upstream
// prompt specs have their own lifecycle and their own link conventions.
//
// `.sde/` in particular is vendored and explicitly read-only — its own README
// says "Do not modify them directly" — and it names illustrative paths that a
// given project need not have.
const SKIPPED_DIRS = new Set([
  "node_modules", ".git", "dist", "framework", "templates", "schemas",
  "registries", "research", "missions", ".ros", ".sde", "input-document",
  "prompts", "docs/00-governance",
]);

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = await Promise.all(entries.map(async (entry) => {
    const full = join(directory, entry.name);
    if (SKIPPED_DIRS.has(relative(ROOT, full))) return [];
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  }));
  return found.flat();
}

// Documents installed and owned by the Repository Operating System package,
// not by this repository. Their links are not checked because editing them
// here would be reverted by the next `ros` install. They ARE still required to
// be reachable from an index below, so they don't become orphans.
//
// docs/work-protocol.md currently ships two broken links; that is an upstream
// ROS defect, recorded as finding D-7 in docs/DOCUMENTATION-AUDIT.md rather
// than patched here.
const ROS_MANAGED = new Set([
  "docs/work-protocol.md",
  "docs/work-adapter-contract.md",
  "docs/PILOT-MEASUREMENT-PLAN.md",
  "docs/architecture/README.md",
  "docs/decisions/README.md",
]);

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

// Strips fenced code blocks so a link-shaped string inside a sample doesn't
// get treated as a real link.
const withoutCodeFences = (source: string): string => source.replace(/```[\s\S]*?```/g, "");

const violations: string[] = [];
const files = await markdownFiles(ROOT);

// --- 1 & 2: links and file mentions resolve --------------------------------

const LINK = /\[[^\]]*\]\(([^)]+)\)/g;
// A repo-relative path mentioned in prose or inline code, e.g. `src/protocol.ts`.
const MENTION = /`((?:src|test|docs|examples|scripts|cli|bin)\/[A-Za-z0-9._/-]+\.[A-Za-z]+)`/g;

for (const file of files) {
  if (ROS_MANAGED.has(relative(ROOT, file))) continue;
  const source = await readFile(file, "utf8");
  const body = withoutCodeFences(source);
  const here = dirname(file);

  for (const [, target] of body.matchAll(LINK)) {
    if (!target) continue;
    // External links, anchors, and mailto: are out of scope.
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const path = resolve(here, target.split("#")[0] ?? "");
    if (!await exists(path)) {
      violations.push(`${relative(ROOT, file)}: broken link -> ${target}`);
    }
  }

  for (const [, mention] of body.matchAll(MENTION)) {
    if (!mention) continue;
    // Placeholders like examples/<name>/engine.ts are illustrative, not paths.
    if (mention.includes("<") || mention.includes("*")) continue;
    if (!await exists(resolve(ROOT, mention))) {
      violations.push(`${relative(ROOT, file)}: mentions a path that does not exist -> ${mention}`);
    }
  }
}

// --- 3: no orphaned documentation ------------------------------------------

const linkedFromReadmes = new Set<string>();
for (const entry of ["README.md", "docs/README.md", "AGENTS.md", "CLAUDE.md"]) {
  const path = join(ROOT, entry);
  if (!await exists(path)) continue;
  const source = withoutCodeFences(await readFile(path, "utf8"));
  for (const [, target] of source.matchAll(LINK)) {
    if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
    linkedFromReadmes.add(normalize(resolve(dirname(path), target.split("#")[0] ?? "")));
  }
}

for (const file of files) {
  const rel = relative(ROOT, file);
  if (!rel.startsWith("docs/")) continue;
  if (rel === "docs/README.md") continue;
  if (!linkedFromReadmes.has(normalize(file))) {
    violations.push(`${rel}: orphaned — not linked from README.md, docs/README.md, AGENTS.md, or CLAUDE.md`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed (${files.length} files).`);
}
