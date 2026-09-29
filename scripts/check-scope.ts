// Work-item path scope (kemiller2002/limen#53): every commit between the base
// and HEAD that changes a meaningful path names exactly one work item, stays
// inside that item's declared scope manifest, and touches guardrail-owned
// paths only if the item is guardrail-scoped. Logic: tools/guardrails/scope.ts.
//
// Base: LIMEN_SCOPE_BASE, else ROS_BASE_REF, else origin/main. Needs history
// back to the base (CI checks out with fetch-depth: 0).

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describeScopeViolation, evaluateScope, parseGuardrails, parseManifest, type Commit } from "../tools/guardrails/scope.ts";

const ROOT = process.cwd();
const git = (...args: readonly string[]): string => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });

const base = process.env.LIMEN_SCOPE_BASE ?? process.env.ROS_BASE_REF ?? "origin/main";
const resolved = (() => {
  try {
    return git("rev-parse", "--verify", `${base}^{commit}`).trim();
  } catch {
    console.error(`check:scope cannot resolve base "${base}". Fetch it (git fetch origin main) or set LIMEN_SCOPE_BASE; a scope check with no base proves nothing.`);
    process.exit(2);
  }
})();

const shas = git("rev-list", "--reverse", "--no-merges", `${resolved}..HEAD`).split("\n").filter((sha) => sha.length > 0);
const commits: readonly Commit[] = shas.map((sha) => ({
  sha,
  message: git("log", "-1", "--format=%B", sha),
  files: git("diff-tree", "--no-commit-id", "--name-only", "-r", "--no-renames", sha).split("\n").filter((file) => file.length > 0),
}));

const guardrails = parseGuardrails(JSON.parse(await readFile(join(ROOT, "architecture/guardrails.json"), "utf8")) as unknown);
const manifestFiles = (await readdir(join(ROOT, guardrails.workScopes)).catch(() => [])).filter((name) => /^WI-\d{4}\.json$/.test(name));
const manifests = new Map(await Promise.all(manifestFiles.map(async (name) => {
  const manifest = parseManifest(JSON.parse(await readFile(join(ROOT, guardrails.workScopes, name), "utf8")) as unknown, `${guardrails.workScopes}/${name}`);
  if (`${manifest.workItem}.json` !== name) throw new Error(`${guardrails.workScopes}/${name}: workItem ${manifest.workItem} does not match the file name`);
  return [manifest.workItem, manifest] as const;
})));

const violations = evaluateScope(commits, manifests, guardrails);
if (violations.length > 0) {
  console.error(`Work-item scope checks failed (${violations.length} violation(s) in ${commits.length} commit(s) since ${base}):\n${violations.map(describeScopeViolation).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Work-item scope checks passed (${commits.length} commit(s) since ${base}, ${manifests.size} scope manifest(s)).`);
}
