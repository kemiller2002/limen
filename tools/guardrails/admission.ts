// Core Admission records (kemiller2002/limen#63), validated purely.
//
// A record is architecture/core-admissions/CA-####.json (docs/core-admission.md).
// scripts/check-core-budget.ts reads the records, the scope manifests and the
// baseline, and calls `checkAdmissions`; test/core-admission.test.ts calls it
// with fixtures.

import type { ScopeManifest } from "./scope.ts";

export const REQUIRED_FIELDS = [
  "proposedAddition",
  "invariantOrUseCase",
  "whyNotHtmlCss",
  "whyNotEngineLibrary",
  "whyNotCapabilityPack",
  "whyNotForma",
  "whyNotGovernedAdapter",
  "whyNotTooling",
  "whyNotHostRenderer",
  "consumerEvidence",
  "complexityDelta",
  "compatibilityImpact",
  "negativeBoundaryTests",
  "guestLanguageImpact",
  "decision",
] as const;

export const KINDS = ["new-concept", "new-root-export-family", "new-binding-primitive", "new-capability-family", "runtime-dependency", "core-file", "budget-growth", "correctness-or-security-fix"] as const;

// Kinds that add a concept surface: they need two independent consumers.
const NEEDS_TWO_CONSUMERS: readonly string[] = ["new-concept", "new-root-export-family", "new-binding-primitive", "new-capability-family"];

export type Outcome = "approved" | "rejected" | "pending";

export type Admission = {
  readonly file: string;
  readonly id: string;
  readonly workItem: string;
  readonly kind: string;
  readonly consumers: readonly string[];
  readonly outcome: Outcome | undefined;
  readonly raw: Readonly<Record<string, unknown>>;
};

export type AdmissionViolation = { readonly rule: string; readonly path: string; readonly detail: string; readonly remedy: string };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const said = (value: unknown): boolean => typeof value === "string" && value.trim().length >= 3 && !/^(tbd|todo|\.\.\.|…)$/i.test(value.trim());

export const parseAdmission = (file: string, raw: unknown): Admission => {
  const record = isRecord(raw) ? raw : {};
  const decision = isRecord(record.decision) ? record.decision : {};
  const outcome = decision.outcome === "approved" || decision.outcome === "rejected" || decision.outcome === "pending" ? decision.outcome : undefined;
  const consumers = Array.isArray(record.consumerEvidence)
    ? record.consumerEvidence.filter(isRecord).filter((entry) => said(entry.consumer) && said(entry.evidence)).map((entry) => String(entry.consumer))
    : [];
  return { file, id: typeof record.id === "string" ? record.id : "", workItem: typeof record.workItem === "string" ? record.workItem : "", kind: typeof record.kind === "string" ? record.kind : "", consumers, outcome, raw: record };
};

const violation = (rule: string, path: string, detail: string, remedy: string): AdmissionViolation => ({ rule, path, detail, remedy });

const recordViolations = (admission: Admission, scopes: ReadonlyMap<string, ScopeManifest>): readonly AdmissionViolation[] => {
  const { file, raw } = admission;
  const expectedId = /(CA-\d{4})\.json$/.exec(file)?.[1];
  const decision = isRecord(raw.decision) ? raw.decision : {};
  const scope = scopes.get(admission.workItem);
  const missing = REQUIRED_FIELDS.filter((field) => {
    const value = raw[field];
    if (field === "consumerEvidence") return !Array.isArray(value);
    if (field === "decision") return admission.outcome === undefined;
    return !said(value);
  });
  return [
    ...(expectedId === undefined || admission.id !== expectedId ? [violation("admission-id", file, `id is "${admission.id}", but the file is named for ${expectedId ?? "no CA-#### id"}`, "Name the file CA-####.json and give the record the same id.")] : []),
    ...(KINDS.some((kind) => kind === admission.kind) ? [] : [violation("admission-kind", file, `kind "${admission.kind}" is not one of ${KINDS.join(", ")}`, "Choose the kind of Core growth this is.")]),
    ...missing.map((field) => violation("admission-field-missing", file, `required field ${field} is missing or says nothing`, "Every one of the fifteen fields must be answered (docs/core-admission.md); \"n/a\" needs a reason.")),
    ...(scope === undefined
      ? [violation("admission-work-item", file, `workItem ${admission.workItem || "(none)"} has no scope manifest`, "Write the record under its own guardrail work item.")]
      : scope.guardrail ? [] : [violation("admission-self-approval", file, `workItem ${admission.workItem} is not a guardrail work item`, "Feature work cannot write or approve its own admission; open a guardrail work item for it.")]),
    ...(admission.outcome === "approved" || admission.outcome === "rejected"
      ? [
        ...(said(decision.by) && !/^WI-\d+$/.test(String(decision.by).trim()) ? [] : [violation("admission-decider", file, `a ${admission.outcome} decision must name the person who made it, not a work item (by: "${String(decision.by ?? "")}")`, "Record who decided; a work item cannot decide its own admission.")]),
        ...(said(decision.evidence) ? [] : [violation("admission-decision-evidence", file, "a decision must link where it was made (decision.evidence)", "Link the issue comment or review in which the owner decided.")]),
        ...(said(decision.date) ? [] : [violation("admission-decision-date", file, "a decision must carry its date", "Add decision.date.")]),
      ]
      : []),
    ...(admission.outcome === "approved" && NEEDS_TWO_CONSUMERS.includes(admission.kind) && new Set(admission.consumers).size < 2
      ? [violation("admission-consumers", file, `a ${admission.kind} needs at least two independent consumers; ${new Set(admission.consumers).size} given`, "Show two real, independent consumers, or keep it optional until there are.")]
      : []),
  ];
};

// The approved baseline must rest on an admission that exists and was not
// rejected. A pending one is reported, not failed: it is the owner's decision.
export type BaselineAuthority = { readonly workItem: string; readonly admission: string | undefined };

export type AdmissionReport = { readonly violations: readonly AdmissionViolation[]; readonly notices: readonly string[] };

export const checkAdmissions = (admissions: readonly Admission[], scopes: ReadonlyMap<string, ScopeManifest>, authority: BaselineAuthority): AdmissionReport => {
  const duplicates = admissions.filter((admission, index) => admissions.findIndex((other) => other.id === admission.id) !== index);
  const cited = authority.admission === undefined ? undefined : admissions.find((admission) => admission.id === authority.admission);
  const authorityScope = scopes.get(authority.workItem);
  const baseline = "architecture/core-baseline.json";
  return {
    violations: [
      ...admissions.flatMap((admission) => recordViolations(admission, scopes)),
      ...duplicates.map((admission) => violation("admission-duplicate-id", admission.file, `${admission.id} is used by more than one record`, "Each record has its own id.")),
      ...(authorityScope?.guardrail === true ? [] : [violation("baseline-authority", baseline, `the approved baseline names ${authority.workItem || "no work item"}, which is not a guardrail work item`, "Only a guardrail work item may set the approved baseline.")]),
      ...(authority.admission !== undefined && cited === undefined ? [violation("baseline-admission-missing", baseline, `the approved baseline cites ${authority.admission}, which does not exist`, "Cite an existing admission record.")] : []),
      ...(cited?.outcome === "rejected" ? [violation("baseline-admission-rejected", baseline, `the approved baseline rests on ${cited.id}, which was rejected`, "Restore a baseline the owner accepted, and bring Core back within it.")] : []),
    ],
    notices: cited?.outcome === "pending" ? [`The approved Core baseline rests on ${cited.id} (${String(cited.raw.title ?? "")}), which is pending the repository owner's decision.`] : [],
  };
};
