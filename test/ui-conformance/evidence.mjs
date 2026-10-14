// Pure mapping from Playwright results to evidence that validates against
// visual-engineering framework/contracts/ui-conformance.schema.json
// (standardVersion 1.0.0). Lack of evidence is "unknown", never "pass".
import { CONTRACT_WIDTHS } from "./forma-conformance/evaluate.mjs";
import { STANDARD, SURFACES } from "./surfaces.mjs";

const FAILED = new Set(["failed", "timedOut", "interrupted"]);

// The schema's relation vocabulary (1.0.0) has no left/right edge, although
// the Forma helpers measure them. Such groups are still run and reported in
// the surface evidence rather than mislabelled with an allowed relation.
const SCHEMA_RELATIONS = new Set(["top-edge", "text-baseline", "centerline", "bottom-edge"]);

export const statusOf = results => {
  if (results.length === 0) return "unknown";
  if (results.some(result => FAILED.has(result.status))) return "fail";
  if (results.every(result => result.status === "passed")) return "pass";
  return "unknown";
};

const describe = result => `${result.status}: ${result.title} (${result.location})`;

const indexResults = results => results.reduce((index, result) => result.annotations.reduce((acc, { type, description }) => {
  const key = `${type}:${description}`;
  return { ...acc, [key]: [...(acc[key] ?? []), result] };
}, index), {});

const nameText = name => (name instanceof RegExp ? `/${name.source}/` : name);

const UNKNOWN_SCOPE = Object.freeze([
  "Translated and right-to-left text are not exercised (the site ships English only).",
  "Long labels beyond the shipped content are not injected.",
  "Browser page zoom is approximated by the contract widths plus a 200% default text size; WebKit and Firefox are not exercised.",
  "Availability of external destinations (GitHub, npm, echelonfoundry.com) is not verified; only that each is an https URL.",
  "Google Fonts are loaded from the network when reachable; with fonts blocked the fallback stack is measured instead.",
  "Demonstrations run the published F# WebAssembly engine in Chromium only; WebKit/Firefox WASM hosting is not exercised here (smoke:packs:webkit covers packs, not this site)."
]);

const buildAction = (surface, index) => action => {
  const results = [...(index[`uli-action:${surface.id}/${action.id}`] ?? []), ...(index[`uli-destination:${surface.id}/${action.id}`] ?? [])];
  return {
    id: action.id,
    control: { role: action.control.role, name: nameText(action.control.name) },
    intent: action.intent,
    expectedOutcome: action.expectedOutcome,
    status: statusOf(results),
    evidence: results.map(describe),
    resetStrategy: action.resetStrategy ?? "Stateless navigation: reload the source page"
  };
};

const buildGroup = (surface, index) => group => {
  const results = group.widths.flatMap(width => index[`uli-group:${surface.id}/${group.id}@${width}`] ?? []);
  return {
    id: group.id,
    relation: group.relation,
    toleranceCssPx: 1,
    targets: group.peers.map(peer => ({ role: peer.role, name: nameText(peer.name) })),
    rationale: `${group.ruleId}: ${group.rationale} (declared at ${group.widths.join(", ")}px)`,
    evidence: results.map(describe),
    status: statusOf(results)
  };
};

const surfaceStatus = statuses => {
  if (statuses.includes("fail")) return "fail";
  if (statuses.length > 0 && statuses.every(status => status === "pass")) return "pass";
  return "unknown";
};

const buildSurface = index => surface => {
  const own = index[`uli-surface:${surface.id}`] ?? [];
  const contentLinks = index[`uli-content-links:${surface.id}`] ?? [];
  const actions = surface.actions.map(buildAction(surface, index));
  const groups = surface.groups.map(buildGroup(surface, index));
  const statuses = [statusOf(own), ...(surface.id === "chrome" ? [] : [statusOf(contentLinks)]), ...actions.map(action => action.status), ...groups.map(group => group.status)];
  return {
    id: surface.id,
    path: surface.path,
    kind: surface.kind,
    status: surfaceStatus(statuses),
    viewportWidths: [...CONTRACT_WIDTHS],
    alignmentGroups: groups.filter(group => SCHEMA_RELATIONS.has(group.relation))
      .map(({ status, ...group }) => ({ ...group, evidence: [`status: ${status}`, ...group.evidence] })),
    actions,
    evidence: [
      ...own.map(describe),
      ...contentLinks.map(result => `content links (every rendered link in <main>, destination verified): ${describe(result)}`),
      ...groups.filter(group => !SCHEMA_RELATIONS.has(group.relation)).map(group =>
        `alignment group ${group.id} (${group.relation}; not expressible in the schema 1.0.0 relation enum) status ${group.status}: ${group.rationale}; ${group.evidence.join("; ")}`),
      ...(surface.groups.length === 0 && surface.id !== "chrome" ? ["alignment: not-applicable beyond the shared chrome; the page declares no side-by-side peer controls"] : [])
    ],
    unknownScope: [...UNKNOWN_SCOPE]
  };
};

export const buildEvidence = ({ results, revision, repository }) => ({
  standardVersion: STANDARD.version,
  repository,
  revision,
  classification: "site-ui",
  surfaces: SURFACES.map(buildSurface(indexResults(results))),
  exceptions: [],
  notes: `Contract ${STANDARD.id}@${STANDARD.version} (${STANDARD.source}). Surface: the Limen product site built by npm run build:site (site/ pages, the F# WebAssembly site engine and the two-module federation proof) and deployed to GitHub Pages (limen.echelonfoundry.com) by .github/workflows/pages.yml. Helpers: @echelon-foundry/forma-conformance 0.1.0 vendored from kemiller2002/forma@769fa13 (Forma PR #158). Generated by npm run ui:conformance; statuses derive only from executed Playwright tests.`
});

export const totals = evidence => {
  const items = evidence.surfaces.flatMap(surface => [surface, ...surface.actions]);
  return items.reduce((acc, item) => ({ ...acc, [item.status]: (acc[item.status] ?? 0) + 1 }), {});
};
