// Core Admission records (kemiller2002/limen#63): the real records are valid,
// the approved baseline rests on one, and feature work can neither write nor
// approve an admission.

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { REQUIRED_FIELDS, checkAdmissions, parseAdmission, type Admission } from "../tools/guardrails/admission.ts";
import { evaluateScope, parseGuardrails, parseManifest, type ScopeManifest } from "../tools/guardrails/scope.ts";

const ROOT = join(import.meta.dirname, "..");
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(ROOT, path), "utf8")) as unknown;

const scopeFiles = (await readdir(join(ROOT, "architecture/work-scopes"))).filter((name) => /^WI-\d{4}\.json$/.test(name));
const scopes: ReadonlyMap<string, ScopeManifest> = new Map(await Promise.all(scopeFiles.map(async (name) => {
  const scope = parseManifest(await json(`architecture/work-scopes/${name}`), name);
  return [scope.workItem, scope] as const;
})));
const recordFiles = (await readdir(join(ROOT, "architecture/core-admissions"))).filter((name) => /^CA-\d{4}\.json$/.test(name));
const records = await Promise.all(recordFiles.map(async (name) => parseAdmission(`architecture/core-admissions/${name}`, await json(`architecture/core-admissions/${name}`))));
const baseline = await json("architecture/core-baseline.json") as { approved: { authority: { workItem: string; admission: string } } };
const authority = { workItem: baseline.approved.authority.workItem, admission: baseline.approved.authority.admission };
const ca0001 = records.find((record) => record.id === "CA-0001") ?? assert.fail("CA-0001 is missing");

const rules = (admissions: readonly Admission[], using = authority): readonly string[] => checkAdmissions(admissions, scopes, using).violations.map((violation) => violation.rule);
const variant = (changes: Record<string, unknown>, file = "architecture/core-admissions/CA-0901.json"): Admission =>
  parseAdmission(file, { ...ca0001.raw, id: /(CA-\d{4})/.exec(file)?.[1], ...changes });
const approvedBy = { outcome: "approved", by: "kemiller2002", date: "2026-09-30", evidence: "https://github.com/kemiller2002/limen/issues/63#issuecomment-1" };

test("every recorded admission is valid, and the baseline rests on CA-0001, pending the owner", () => {
  const report = checkAdmissions(records, scopes, authority);
  assert.deepEqual(report.violations, []);
  assert.equal(ca0001.outcome, "pending");
  assert.deepEqual(report.notices.length, 1);
  assert.match(report.notices[0] ?? "", /CA-0001 .* pending the repository owner's decision/);
});

test("the template has all fifteen fields, and the record requires every one", async () => {
  const template = await json("architecture/core-admissions/TEMPLATE.json") as Record<string, unknown>;
  assert.equal(REQUIRED_FIELDS.length, 15);
  for (const field of REQUIRED_FIELDS) assert.ok(field in template, `TEMPLATE.json lacks ${field}`);
  for (const field of REQUIRED_FIELDS.filter((name) => name !== "consumerEvidence" && name !== "decision")) {
    assert.deepEqual(rules([...records, variant({ [field]: "" })]), ["admission-field-missing"], field);
  }
  assert.deepEqual(rules([...records, variant({ whyNotForma: "TBD" })]), ["admission-field-missing"]);
  assert.deepEqual(rules([...records, variant({ decision: { outcome: "maybe" } })]), ["admission-field-missing"]);
});

test("feature work cannot write or approve its own admission", async () => {
  // A record whose work item is not a guardrail item.
  const feature = [...scopes.values()].find((scope) => !scope.guardrail) ?? assert.fail("no feature work item to use");
  assert.deepEqual(rules([...records, variant({ workItem: feature.workItem })]), ["admission-self-approval"]);
  // A work item cannot be the decider.
  assert.deepEqual(rules([...records, variant({ decision: { ...approvedBy, by: "WI-0123" } })]), ["admission-decider"]);
  // A decision needs evidence of where it was made.
  assert.deepEqual(rules([...records, variant({ decision: { ...approvedBy, evidence: "" } })]), ["admission-decision-evidence"]);
  // And a feature item cannot touch the records at all.
  const guardrails = parseGuardrails(await json("architecture/guardrails.json"));
  const sneaky = parseManifest({ workItem: "WI-0901", reference: "#15", placement: "Capability Pack", guardrail: false, paths: ["src/capabilities/timers/**", "architecture/core-admissions/**"] }, "fixture");
  const violations = evaluateScope(
    [{ sha: "d", message: "chore(scope): declare (WI-0901)", files: ["architecture/work-scopes/WI-0901.json"] }, { sha: "a", message: "feat(timers): admit myself (WI-0901)", files: ["architecture/core-admissions/CA-0901.json"] }],
    new Map([[sneaky.workItem, sneaky]]),
    guardrails,
  ).map((violation) => violation.rule);
  assert.deepEqual(violations, ["guardrail-modification"]);
});

test("a new concept needs two independent consumers; a correctness or security fix does not", () => {
  const one = [{ consumer: "One application", evidence: "examples/08-routing" }];
  assert.deepEqual(rules([...records, variant({ kind: "new-concept", consumerEvidence: one, decision: approvedBy })]), ["admission-consumers"]);
  assert.deepEqual(rules([...records, variant({ kind: "new-binding-primitive", consumerEvidence: [...one, ...one], decision: approvedBy })]), ["admission-consumers"]);
  assert.deepEqual(rules([...records, variant({ kind: "new-concept", consumerEvidence: [...one, { consumer: "A second application", evidence: "site/fsharp" }], decision: approvedBy })]), []);
  assert.deepEqual(rules([...records, variant({ kind: "correctness-or-security-fix", consumerEvidence: one, decision: approvedBy })]), []);
});

test("the approved baseline must rest on an existing, unrejected admission set by a guardrail item", () => {
  assert.deepEqual(rules(records, { ...authority, admission: "CA-0999" }), ["baseline-admission-missing"]);
  const rejected = records.map((record) => (record.id === "CA-0001" ? parseAdmission(record.file, { ...record.raw, decision: { ...approvedBy, outcome: "rejected" } }) : record));
  assert.deepEqual(rules(rejected), ["baseline-admission-rejected"]);
  const feature = [...scopes.values()].find((scope) => !scope.guardrail) ?? assert.fail("no feature work item to use");
  assert.deepEqual(rules(records, { ...authority, workItem: feature.workItem }), ["baseline-authority"]);
});

test("ids match file names and are unique", () => {
  assert.deepEqual(rules([...records, variant({ id: "CA-0002" })]), ["admission-id"]);
  assert.deepEqual(rules([...records, variant({}), variant({}, "architecture/core-admissions/CA-0901.json")]), ["admission-duplicate-id"]);
});
