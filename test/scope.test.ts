// Work-item path-scope guardrail (kemiller2002/limen#53).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateScope, parseGuardrails, parseManifest, workItemsIn, type Commit, type ScopeManifest } from "../tools/guardrails/scope.ts";

const guardrails = parseGuardrails(JSON.parse(await readFile(new URL("../architecture/guardrails.json", import.meta.url), "utf8")) as unknown);

const focus: ScopeManifest = parseManifest({
  workItem: "WI-0100",
  reference: "kemiller2002/limen#23",
  placement: "Capability Pack",
  guardrail: false,
  paths: ["contract/capabilities/focus.contract.json", "src/capabilities/focus/**", "test/focus*.test.ts", "docs/**"],
}, "fixture");

const governance: ScopeManifest = parseManifest({
  workItem: "WI-0101",
  reference: "kemiller2002/limen#53",
  placement: "Tooling / Governance",
  guardrail: true,
  paths: ["scripts/check-*.ts", "tools/guardrails/**", "architecture/**"],
}, "fixture");

const manifests = new Map([[focus.workItem, focus], [governance.workItem, governance]]);
const commit = (sha: string, message: string, files: readonly string[]): Commit => ({ sha, message, files });
const declare = (workItem: string): Commit => commit(`declare-${workItem}`, `chore(scope): declare (${workItem})`, [`architecture/work-scopes/${workItem}.json`]);
const rules = (commits: readonly Commit[]): readonly string[] => evaluateScope(commits, manifests, guardrails).map((violation) => violation.rule);

test("attribution is the parenthesized subject group or a Work-Item trailer, not any mention", () => {
  assert.deepEqual(workItemsIn("feat: focus (GH-23, WI-0100)\n\nFollows up WI-0099."), ["WI-0100"]);
  assert.deepEqual(workItemsIn("chore: repair findings for WI-0028 (WI-0029)"), ["WI-0029"]);
  assert.deepEqual(workItemsIn("fix: thing\n\nWork-Item: WI-0100"), ["WI-0100"]);
  assert.deepEqual(workItemsIn("fix: thing about WI-0100"), []);
});

test("an approved capability commit inside its declared scope passes", () => {
  assert.deepEqual(rules([declare("WI-0100"), commit("a1", "feat(focus): provider (GH-23, WI-0100)", ["src/capabilities/focus/provider.ts", "test/focus.test.ts", ".ros/events/events.jsonl"])]), []);
});

test("ordinary capability work changing an unrelated Core path fails as out of scope", () => {
  const violations = evaluateScope([declare("WI-0100"), commit("a2", "feat(focus): tweak kernel (WI-0100)", ["src/capabilities/focus/provider.ts", "src/kernel/browser-kernel.ts"])], manifests, guardrails);
  assert.deepEqual(violations.map((violation) => violation.rule), ["out-of-scope"]);
  assert.match(violations[0]!.detail, /WI-0100 \(Capability Pack\) changes src\/kernel\/browser-kernel\.ts/);
  assert.match(violations[0]!.remedy, /expansion with a reason|its own work item/);
});

test("a feature work item editing the guardrail that blocks it fails, even when it declared the path", () => {
  const sneaky = parseManifest({ workItem: "WI-0102", reference: "#23", placement: "Capability Pack", guardrail: false, paths: ["src/capabilities/focus/**", "scripts/check-layers.ts"] }, "fixture");
  const violations = evaluateScope(
    [commit("d", "chore(scope): declare (WI-0102)", ["architecture/work-scopes/WI-0102.json"]), commit("b1", "feat(focus): relax check (WI-0102)", ["scripts/check-layers.ts"])],
    new Map([[sneaky.workItem, sneaky]]),
    guardrails,
  );
  assert.deepEqual(violations.map((violation) => violation.rule), ["guardrail-modification"]);
  assert.match(violations[0]!.remedy, /may not change its supervisor/);
});

test("weakening a strictness setting or a CI workflow is a guardrail modification", () => {
  assert.deepEqual(rules([declare("WI-0100"), commit("b2", "feat(focus): (WI-0100)", ["src/capabilities/focus/a.ts", "tsconfig.json", ".github/workflows/ci.yml", "guests/fsharp/Limen.Contract/Limen.Contract.fsproj"])]),
    ["out-of-scope", "out-of-scope", "out-of-scope", "guardrail-modification", "guardrail-modification", "guardrail-modification"]);
});

test("a guardrail-scoped governance work item may change the checker", () => {
  assert.deepEqual(rules([declare("WI-0101"), commit("c1", "fix(guardrails): correct layer rule (GH-53, WI-0101)", ["scripts/check-layers.ts", "tools/guardrails/layers.ts"])]), []);
});

test("a commit with no work item, or with two, fails", () => {
  assert.deepEqual(rules([commit("e1", "fix: quick thing", ["src/kernel/browser-kernel.ts"])]), ["unattributed-commit"]);
  assert.deepEqual(rules([commit("e2", "fix: two things (WI-0100, WI-0101)", ["src/kernel/browser-kernel.ts"])]), ["multiple-work-items"]);
});

test("a commit touching only ROS bookkeeping needs no attribution", () => {
  assert.deepEqual(rules([commit("f1", "chore: complete WI-0100 and WI-0101", [".ros/events/events.jsonl", "registries/decisions.json"])]), []);
});

test("changing paths before the scope was declared fails", () => {
  assert.deepEqual(rules([commit("g1", "feat(focus): early (WI-0100)", ["src/capabilities/focus/a.ts"]), declare("WI-0100")]), ["scope-declared-after-mutation"]);
});

test("a work item with no manifest fails", () => {
  assert.deepEqual(rules([commit("h1", "feat: x (WI-0199)", ["src/capabilities/x/a.ts"])]), ["undeclared-scope"]);
});

test("a feature work item may not edit another item's scope; a governance item may", () => {
  assert.deepEqual(rules([declare("WI-0100"), commit("i1", "feat(focus): widen other (WI-0100)", ["architecture/work-scopes/WI-0101.json"])]), ["foreign-scope-edit"]);
  assert.deepEqual(rules([declare("WI-0101"), commit("i2", "chore(scope): record (WI-0101)", ["architecture/work-scopes/WI-0100.json"])]), []);
});

test("only listed legacy work items may have scopes recorded after completion", () => {
  const late = parseManifest({ workItem: "WI-0103", reference: "#1", placement: "x", paths: ["docs/**"], recordedAfterCompletion: true }, "fixture");
  const violations = evaluateScope([commit("j1", "docs: x (WI-0103)", ["docs/a.md"]), commit("j2", "chore(scope): (WI-0103)", ["architecture/work-scopes/WI-0103.json"])], new Map([[late.workItem, late]]), guardrails);
  assert.ok(violations.some((violation) => violation.rule === "scope-declared-after-mutation"));
});

test("an expansion must carry a real reason", () => {
  assert.throws(() => parseManifest({ workItem: "WI-0104", reference: "#1", placement: "x", paths: ["docs/**"], expansions: [{ paths: ["src/**"], reason: "needed" }] }, "fixture"), /reason of at least 20 characters/);
});

test("this branch's own history satisfies its declared scopes", async () => {
  const { execFileSync } = await import("node:child_process");
  const root = new URL("..", import.meta.url).pathname;
  const base = (() => {
    try {
      return execFileSync("git", ["rev-parse", "--verify", "origin/main^{commit}"], { cwd: root, encoding: "utf8" }).trim();
    } catch {
      return undefined;
    }
  })();
  if (base === undefined) return; // no base available (e.g. a shallow clone): CI's dedicated job runs check:scope with full history
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/check-scope.ts"], { cwd: root, encoding: "utf8", env: { ...process.env, LIMEN_SCOPE_BASE: base } });
  assert.match(output, /Work-item scope checks passed/);
});
