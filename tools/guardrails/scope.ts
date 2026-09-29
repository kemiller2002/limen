// Work-item path scope, checked commit by commit.
//
// ROS attributes changed paths to work items, but with ROS_BASE_REF its
// `work.completed.paths` is the cumulative branch diff, so it cannot say which
// item changed which file (negative knowledge recorded in DF-LIMEN-2026-0002).
// This check therefore works from git: every commit that changes a meaningful
// path names exactly one work item, and every path it changes must be inside
// that item's declared scope manifest. It owns no work-item state: the ids and
// lifecycle remain ROS's; the manifest only declares placement and paths.

import { matches } from "./layers.ts";

export type Commit = { readonly sha: string; readonly message: string; readonly files: readonly string[] };

export type ScopeManifest = {
  readonly workItem: string;
  readonly reference: string;
  readonly placement: string;
  readonly guardrail: boolean;
  readonly paths: readonly string[];
  readonly expansions: readonly { readonly paths: readonly string[]; readonly reason: string }[];
  readonly recordedAfterCompletion: boolean;
};

export type Guardrails = {
  readonly paths: readonly string[];
  readonly exemptPaths: readonly string[];
  readonly workScopes: string;
  readonly legacyWorkItems: readonly string[];
};

export type ScopeViolation = { readonly rule: string; readonly commit: string; readonly detail: string; readonly remedy: string };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export const parseGuardrails = (raw: unknown): Guardrails => {
  if (!isRecord(raw)) throw new Error("architecture/guardrails.json must be an object");
  return {
    paths: strings(raw.paths),
    exemptPaths: strings(raw.exemptPaths),
    workScopes: typeof raw.workScopes === "string" ? raw.workScopes : "architecture/work-scopes",
    legacyWorkItems: isRecord(raw.legacyWorkItems) ? strings(raw.legacyWorkItems.ids) : [],
  };
};

export const parseManifest = (raw: unknown, source: string): ScopeManifest => {
  if (!isRecord(raw)) throw new Error(`${source}: must be an object`);
  const required = (key: string): string => {
    const value = raw[key];
    if (typeof value !== "string" || value.length === 0) throw new Error(`${source}: ${key} is required`);
    return value;
  };
  const paths = strings(raw.paths);
  if (paths.length === 0) throw new Error(`${source}: paths must list at least one glob`);
  const expansions = Array.isArray(raw.expansions)
    ? raw.expansions.map((expansion, index) => {
      if (!isRecord(expansion) || typeof expansion.reason !== "string" || expansion.reason.length < 20) throw new Error(`${source}: expansions[${index}] needs paths and a reason of at least 20 characters`);
      return { paths: strings(expansion.paths), reason: expansion.reason };
    })
    : [];
  return {
    workItem: required("workItem"),
    reference: required("reference"),
    placement: required("placement"),
    guardrail: raw.guardrail === true,
    paths,
    expansions,
    recordedAfterCompletion: raw.recordedAfterCompletion === true,
  };
};

const WORK_ITEM = /\bWI-\d{4}\b/g;

// Attribution, as opposed to mention: the work item ids inside a parenthesized
// group on the subject line — "feat: … (GH-52, WI-0033)" — or on a
// "Work-Item: WI-0033" trailer. "repair findings for WI-0028 (WI-0029)"
// mentions WI-0028 and is attributed to WI-0029.
export const workItemsIn = (message: string): readonly string[] => {
  const [subject = "", ...body] = message.split("\n");
  const fromSubject = Array.from(subject.matchAll(/\(([^)]*)\)/g), (group) => group[1] ?? "").flatMap((group) => group.match(WORK_ITEM) ?? []);
  const fromTrailers = body.flatMap((line) => /^Work-Item:\s*(WI-\d{4})\s*$/.exec(line.trim())?.slice(1) ?? []);
  return [...new Set([...fromSubject, ...fromTrailers])];
};

const manifestPathOf = (guardrails: Guardrails, workItem: string): string => `${guardrails.workScopes}/${workItem}.json`;

export const evaluateScope = (commits: readonly Commit[], manifests: ReadonlyMap<string, ScopeManifest>, guardrails: Guardrails): readonly ScopeViolation[] => {
  // Where each manifest was first introduced, by commit index (oldest first).
  const introduced = (path: string): number => commits.findIndex((commit) => commit.files.includes(path));
  return commits.flatMap((commit, index): readonly ScopeViolation[] => {
    const short = commit.sha.slice(0, 10);
    const meaningful = commit.files.filter((file) => !guardrails.exemptPaths.some((glob) => matches(glob, file)));
    if (meaningful.length === 0) return [];
    const items = workItemsIn(commit.message);
    if (items.length === 0) {
      return [{ rule: "unattributed-commit", commit: short, detail: `changes ${meaningful.length} path(s) but names no work item`, remedy: "Name the one work item the commit belongs to (e.g. \"(WI-0042)\") in its message; start one with ./ros work start first if none exists." }];
    }
    if (items.length > 1) {
      return [{ rule: "multiple-work-items", commit: short, detail: `names ${items.join(", ")} while changing ${meaningful.length} path(s)`, remedy: "One commit, one work item. Split the commit so each scope can be checked." }];
    }
    const [workItem] = items as [string];
    const ownManifest = manifestPathOf(guardrails, workItem);
    const manifest = manifests.get(workItem);
    if (manifest === undefined) {
      return [{ rule: "undeclared-scope", commit: short, detail: `${workItem} has no scope manifest at ${ownManifest}`, remedy: `Declare placement and allowed paths in ${ownManifest} before changing anything, in the first commit of the work item.` }];
    }
    const declaredAt = introduced(ownManifest);
    // Not introduced within the checked range means it predates the range.
    const late = declaredAt > index;
    const legacy = manifest.recordedAfterCompletion && guardrails.legacyWorkItems.includes(workItem);
    const timing: readonly ScopeViolation[] = late && !legacy
      ? [{ rule: "scope-declared-after-mutation", commit: short, detail: `${workItem} changed paths before its scope manifest existed`, remedy: "Commit the scope manifest first (or with) the work item's first change." }]
      : manifest.recordedAfterCompletion && !legacy
        ? [{ rule: "scope-declared-after-mutation", commit: short, detail: `${workItem} claims recordedAfterCompletion but is not a listed legacy work item`, remedy: "Only work items listed in architecture/guardrails.json legacyWorkItems predate scope manifests." }]
        : [];
    const allowed = [...manifest.paths, ...manifest.expansions.flatMap((expansion) => expansion.paths)];
    const otherManifests = meaningful.filter((file) => file.startsWith(`${guardrails.workScopes}/`) && file !== ownManifest);
    const outOfScope = meaningful.filter((file) => file !== ownManifest && !otherManifests.includes(file) && !allowed.some((glob) => matches(glob, file)));
    const guardrailTouches = meaningful.filter((file) => file !== ownManifest && guardrails.paths.some((glob) => matches(glob, file)));
    return [
      ...timing,
      // Recording another item's scope is a governance act: only a
      // guardrail-scoped item may do it (e.g. back-filling legacy scopes).
      ...(manifest.guardrail ? [] : otherManifests).map((file) => ({ rule: "foreign-scope-edit", commit: short, detail: `${workItem} edits another work item's scope manifest ${file}`, remedy: "A work item may declare only its own scope; a guardrail-scoped governance item may record others'." })),
      ...outOfScope.map((file) => ({ rule: "out-of-scope", commit: short, detail: `${workItem} (${manifest.placement}) changes ${file}, outside its declared paths`, remedy: `If this change is genuinely required, add it to ${ownManifest} as an expansion with a reason; if it is separate work, capture it with ./ros add and do it under its own work item.` })),
      ...(manifest.guardrail ? [] : guardrailTouches.map((file) => ({ rule: "guardrail-modification", commit: short, detail: `${workItem} is not guardrail-scoped but changes guardrail-owned ${file}`, remedy: "Feature work may not change its supervisor. If the guardrail is wrong, stop, record the evidence, and change it under a separate work item whose manifest declares \"guardrail\": true." }))),
    ];
  });
};

export const describeScopeViolation = (violation: ScopeViolation): string =>
  `[${violation.rule}] ${violation.commit}: ${violation.detail}\n    → ${violation.remedy}`;
