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

// Documentation that ships inside the npm tarball links back into the
// repository with absolute URLs, because a relative link is dead once the file
// is sitting in node_modules (and npmjs.com renders the README with no
// repository around it). Those links are still repository paths, so they are
// checked for existence and they still count against the orphan rule below —
// otherwise adopting absolute links would quietly disable both checks.
const REPO_URL = "https://github.com/kemiller2002/typescript-wasm-kernel/";

const repositoryPath = (target: string): string | null => {
  if (!target.startsWith(REPO_URL)) return null;
  const rest = target.slice(REPO_URL.length).replace(/^(blob|tree)\/main\//, "").split("#")[0] ?? "";
  return rest === "" ? null : decodeURIComponent(rest.replace(/\/$/, ""));
};

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
    const repoTarget = repositoryPath(target);
    if (repoTarget !== null && !await exists(resolve(ROOT, repoTarget))) {
      violations.push(`${relative(ROOT, file)}: repository link points at a path that does not exist -> ${target}`);
      continue;
    }
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
    if (!target || /^(mailto:|#)/.test(target)) continue;
    const repoTarget = repositoryPath(target);
    if (repoTarget !== null) { linkedFromReadmes.add(normalize(resolve(ROOT, repoTarget))); continue; }
    if (/^https?:/.test(target)) continue;
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

// --- 4: documented type literals agree with the source ---------------------
//
// The failure this exists to prevent, observed: two capabilities were added to
// the protocol and roughly six documents were never swept, including the one
// written for agents and one that ships to npm consumers. Prose rot is hard to
// detect mechanically; a quoted *type declaration* is not.
//
// For each type below, the set of string literals a document declares must
// equal the set in the source. A document showing an abbreviated declaration
// must mark it with an ellipsis (…) — then it is treated as an excerpt and
// skipped, which is an honest label rather than a silent exception.
const CHECKED_TYPES: readonly { readonly name: string; readonly source: string }[] = [
  { name: "Capability", source: "src/protocol.ts" },
  { name: "ClipboardOutcome", source: "src/protocol.ts" },
  { name: "NavigationOutcome", source: "src/protocol.ts" },
  { name: "StorageOutcome", source: "src/protocol.ts" },
  { name: "EffectOutcome", source: "src/protocol.ts" },
  { name: "EffectResult", source: "src/protocol.ts" },
  { name: "BrowserToEngineMessage", source: "src/protocol.ts" },
  { name: "DiagnosticEvent", source: "src/kernel/diagnostics.ts" },
];

// Comments are stripped first: a literal quoted in prose inside a declaration
// would otherwise count as part of the type.
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const declarationOf = (source: string, name: string): string | null => {
  const match = new RegExp(`type ${name}\\b[^=]*=([\\s\\S]*?);\\s*\\n`).exec(source);
  return match?.[1] ?? null;
};

const literalsOf = (declaration: string): Set<string> =>
  new Set(Array.from(withoutComments(declaration).matchAll(/"([^"]+)"/g), (match) => match[1] ?? ""));

const sorted = (values: Set<string>): string => Array.from(values).sort().join(", ");

const expected = new Map<string, Set<string>>();
for (const { name, source } of CHECKED_TYPES) {
  const declaration = declarationOf(await readFile(join(ROOT, source), "utf8"), name);
  if (declaration === null) {
    violations.push(`scripts/check-docs.ts: cannot find "type ${name}" in ${source} — this check is now blind to it`);
    continue;
  }
  expected.set(name, literalsOf(declaration));
}

const FENCE = /```(?:ts|typescript)\n([\s\S]*?)```/g;

for (const file of files) {
  if (ROS_MANAGED.has(relative(ROOT, file))) continue;
  const source = await readFile(file, "utf8");
  for (const [, fence] of source.matchAll(FENCE)) {
    if (!fence) continue;
    for (const [name, want] of expected) {
      const declaration = declarationOf(fence, name);
      if (declaration === null) continue;
      // An excerpt says so. "…" or "..." marks a deliberately partial listing.
      if (/…|\.\.\./.test(declaration)) continue;
      const got = literalsOf(declaration);
      if (sorted(got) !== sorted(want)) {
        violations.push(
          `${relative(ROOT, file)}: the documented "${name}" disagrees with the source\n` +
          `    documented: ${sorted(got) || "(none)"}\n` +
          `    source:     ${sorted(want)}`,
        );
      }
    }
  }
}

// --- 5: the website quotes the same types, so check it too -----------------
//
// The site is a third surface, and the one nobody re-reads. Its code blocks are
// syntax-highlighted HTML rather than fences, so the tags come off first; the
// string literals survive that untouched.
const stripTags = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"');

for (const page of await readdir(join(ROOT, "site/pages"))) {
  if (!page.endsWith(".html")) continue;
  const html = stripTags(await readFile(join(ROOT, "site/pages", page), "utf8"));
  for (const [name, want] of expected) {
    const declaration = declarationOf(html, name);
    if (declaration === null || /…|\.\.\./.test(declaration)) continue;
    const got = literalsOf(declaration);
    if (sorted(got) !== sorted(want)) {
      violations.push(
        `site/pages/${page}: the documented "${name}" disagrees with the source\n` +
        `    documented: ${sorted(got) || "(none)"}\n` +
        `    source:     ${sorted(want)}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Documentation checks passed (${files.length} files plus the website, ${expected.size} protocol types cross-checked).`);
}
