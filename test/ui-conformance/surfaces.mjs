// Declared conformance inventory for the Limen product site against
// visual-engineering/UI-LAYOUT-INTERACTION@1.0.0 (pinned at visual-engineering
// 8da8fbc). This file is data. Routes and headings are read from site/pages,
// the sources scripts/build-site.ts renders into dist-site/.
//
// Action classes:
// - chrome: skip link, brand, primary navigation and footer actions
//   (site/templates/layout.html). Declared individually.
// - calls to action: every `.button` link authored in site/pages.
// - demo controls: every enabled button of every interactive demo, declared
//   with its initial state, invocation, expected observable outcome and
//   reset strategy (ULI-A05, A10). The F# engine (site/fsharp) owns the state.
// - content links: prose links in <main>, enumerated at runtime and checked
//   for a meaningful destination. Third-party availability is unknown scope.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const STANDARD = Object.freeze({ id: "visual-engineering/UI-LAYOUT-INTERACTION", version: "1.0.0", source: "kemiller2002/visual-engineering@8da8fbc" });

const PAGES = fileURLToPath(new URL("../../site/pages/", import.meta.url));
const plain = html => html.replace(/<[^>]+>/g, "").replace(/&rsquo;/g, "’").replace(/&amp;/g, "&").replace(/&middot;/g, "·").replace(/\s+/g, " ").trim();
const source = file => readFileSync(join(PAGES, file), "utf8");

const NAV = Object.freeze([
  ["Overview", "index"], ["Why Limen", "why-limen"], ["Architecture", "architecture"], ["Demos", "demos"],
  ["Federation", "federation"], ["Evidence", "evidence"], ["For agents", "agents"], ["Docs", "docs"]
]);
export const NAV_NAMES = NAV.map(([name]) => name);

export const ROUTES = Object.freeze(readdirSync(PAGES).filter(name => name.endsWith(".html")).sort().map(file => {
  const slug = file.replace(/\.html$/, "");
  return {
    id: slug, path: `/${file}`, file,
    heading: plain(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(source(file))?.[1] ?? ""),
    current: NAV.find(([, page]) => page === slug)?.[0] ?? null
  };
}));

const routeFor = path => ROUTES.find(route => route.path === path);
const link = name => ({ role: "link", name });
const button = name => ({ role: "button", name });

const navigate = (id, name, destination, from, scope, href = `.${destination}`) =>
  ({ id, control: link(name), kind: "navigate", scope, href, destination, heading: routeFor(destination)?.heading, from, intent: `Navigate to ${destination}`, expectedOutcome: `URL becomes ${destination} and the destination's heading "${routeFor(destination)?.heading}" is shown` });

const external = (id, name, href, scope) =>
  ({ id, control: link(name), kind: "external", scope, href, destination: href, from: "/evidence.html", intent: `Open ${href}`, expectedOutcome: `href is ${href} (an https destination; the external service's availability is not claimed)` });

const NEUTRAL = "/evidence.html";

export const CHROME = Object.freeze([
  { id: "skip-link", control: link("Skip to main content"), kind: "skip", scope: "page", href: "#main-content", destination: "#main-content", from: NEUTRAL, intent: "Move keyboard focus past the header to the page content", expectedOutcome: "The link appears on keyboard focus; activating it changes the hash to #main-content and the main region is in view" },
  navigate("brand-home", "Limen", "/index.html", NEUTRAL, "banner"),
  ...NAV.map(([name, page]) => navigate(`nav-${page}`, name, `/${page}.html`, page === "evidence" ? "/docs.html" : NEUTRAL, "navigation")),
  external("nav-github", "GitHub", "https://github.com/kemiller2002/limen", "navigation"),
  external("footer-echelon", "Echelon Foundry", "https://echelonfoundry.com", "contentinfo"),
  external("footer-source", "Source", "https://github.com/kemiller2002/limen", "contentinfo"),
  external("footer-npm", "npm", "https://www.npmjs.com/package/@echelon-foundry/limen", "contentinfo"),
  navigate("footer-docs", "Documentation", "/docs.html", NEUTRAL, "contentinfo")
]);

// `.button` links authored in a page are calls to action.
const BUTTON_LINK = /<a\s+class="button[^"]*"\s+href="\.\/([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const callsToAction = route => [...source(route.file).matchAll(BUTTON_LINK)].map(([, target, label]) =>
  navigate(`cta-${slug(plain(label))}`, plain(label), `/${target}`, route.path, "main"));

// --- Interactive demonstrations (state owned by the F# engine) ---------------

const RELEASE_RESET = "Activate the scenario's Reset control (or reload the page); the engine returns the release to its initial state.";

const releaseDemo = (resetName, reconcileApplied, reconcileNotApplied) => [
  { id: "tests-pass", control: button("Pass tests"), intent: "Record passing test evidence", expectedOutcome: "Tests reads Passed (was Unverified); a trace step is recorded", resetStrategy: RELEASE_RESET },
  { id: "tests-fail", control: button("Fail tests"), intent: "Record failing test evidence", expectedOutcome: "Tests reads Failed and the obligation remains; approval stays disabled", resetStrategy: RELEASE_RESET },
  { id: "security-clear", control: button("Clear security"), intent: "Record a security clearance", expectedOutcome: "Security reads Passed (was Unverified)", resetStrategy: RELEASE_RESET },
  { id: "security-block", control: button("Block security"), intent: "Record a security block", expectedOutcome: "Security reads Failed; approval stays disabled", resetStrategy: RELEASE_RESET },
  { id: "approve", control: button("Approve release"), intent: "Approve a release whose evidence is complete", expectedOutcome: "Disabled until tests and security pass; then Approval reads Approved and deploy controls are enabled", resetStrategy: RELEASE_RESET },
  { id: "deploy-success", control: button("Deploy: success"), intent: "Deploy through a real Limen Http effect that succeeds", expectedOutcome: "Deployment reads Deployed and the verdict says the deployment is authoritative", resetStrategy: RELEASE_RESET },
  { id: "deploy-unknown", control: button("Evidence: timeout after dispatch"), intent: "Inject an OutcomeUnknown deployment result", expectedOutcome: "Deployment reads Outcome unknown; deploy controls disable and reconciliation controls appear", resetStrategy: RELEASE_RESET },
  { id: "deploy-network-failure", control: button("Deploy: network failure"), intent: "Deploy through a real Http effect that fails in transport", expectedOutcome: "Deployment reads Failed and the verdict says a retry may be allowed; never Deployed", resetStrategy: RELEASE_RESET },
  { id: "reconcile-applied", control: button(reconcileApplied), intent: "Reconcile an unknown outcome as applied", expectedOutcome: "Deployment reads Deployed; reconciliation controls disappear", resetStrategy: RELEASE_RESET },
  { id: "reconcile-not-applied", control: button(reconcileNotApplied), intent: "Reconcile an unknown outcome as not applied", expectedOutcome: "Deployment returns to Not started and deploy controls are enabled again", resetStrategy: RELEASE_RESET },
  { id: "reset", control: button(resetName), intent: "Reset the release scenario", expectedOutcome: "Tests, Security, Approval and Deployment return to Unverified, Unverified, Not approved and Not started", resetStrategy: "Idempotent: the scenario returns to its initial state" }
].map(action => ({ ...action, demo: "release", kind: "demo" }));

const POLICY_RESET = "Activate the policy scenario's Reset control (or reload the page).";
const policyDemo = [
  { id: "policy-start-a", control: button("1. Start policy A"), intent: "Request policy A", expectedOutcome: "Latest request reads policy-a (was none); Start policy A disables", resetStrategy: POLICY_RESET },
  { id: "policy-start-b", control: button("2. Start newer policy B"), intent: "Request a newer policy B", expectedOutcome: "Latest request reads policy-b", resetStrategy: POLICY_RESET },
  { id: "policy-deliver-a", control: button("3. Deliver A first"), intent: "Deliver the stale response A after B started", expectedOutcome: "Stale discarded reads 1 and Accepted result stays none", resetStrategy: POLICY_RESET },
  { id: "policy-deliver-b", control: button("4. Deliver B"), intent: "Deliver the current response B", expectedOutcome: "Accepted result reads policy-b → Review required", resetStrategy: POLICY_RESET },
  { id: "policy-reset", control: button("Reset"), intent: "Reset the policy scenario", expectedOutcome: "Latest request and accepted result read none; Start policy A is enabled", resetStrategy: "Idempotent" }
].map(action => ({ ...action, demo: "policy", kind: "demo" }));

const placementDemo = [
  { id: "placement-pick", control: { role: "button", name: /^(HTML|CSS|Limen kernel|F# engine|Effect request|Protocol change)$/ }, intent: "Answer where the decision belongs", expectedOutcome: "The chosen answer is pressed, a verdict explains the answer, the score counts it and the other choices can no longer be picked for this task", resetStrategy: "Next challenge moves to the next task; reload restarts at task 1" },
  { id: "placement-next", control: button("Next challenge"), intent: "Move to the next placement task", expectedOutcome: "Task number advances and the verdict is hidden until the next answer", resetStrategy: "Tasks cycle; reload restarts at task 1" }
].map(action => ({ ...action, demo: "placement", kind: "demo" }));

const traceDemo = [
  { id: "trace-clear", control: button("Clear trace"), intent: "Clear the transition trace", expectedOutcome: "Disabled while the trace is empty; after transitions, clearing sets the recorded count to 0 and shows the empty hint", resetStrategy: "Any demo action records new steps" }
].map(action => ({ ...action, demo: "trace", kind: "demo" }));

export const DEMO_REGIONS = Object.freeze({
  release: "Can this release legally move?",
  policy: "Overlapping policy checks",
  placement: "Where does this decision belong?",
  trace: "Cross-boundary decisions"
});

const actionsFor = route => ({
  index: [...callsToAction(route), ...releaseDemo("Reset scenario", "Authoritative check: applied", "Authoritative check: not applied").map(action => ({ ...action, id: `home-${action.id}` }))],
  demos: [...callsToAction(route), ...releaseDemo("Reset", "Reconcile: applied", "Reconcile: not applied"), ...policyDemo, ...placementDemo, ...traceDemo]
})[route.id] ?? callsToAction(route);

const NAV_PEERS = NAV_NAMES.map(link);

export const SURFACES = Object.freeze([
  {
    id: "chrome", path: "/* (shared header and footer on every page)", kind: "marketing",
    actions: CHROME,
    groups: [
      { id: "primary-nav", ruleId: "ULI-L10", relation: "centerline", edge: "center", widths: [1280], peers: [...NAV_PEERS, link("GitHub")], scope: "navigation", rationale: "Primary destinations share one row beside the brand above 70em" },
      { id: "footer-actions", ruleId: "ULI-L10", relation: "centerline", edge: "center", widths: [390, 768, 1280], peers: [link("Source"), link("npm"), link("Documentation")], scope: "contentinfo", rationale: "Footer actions share one row" }
    ]
  },
  ...ROUTES.map(route => ({
    id: route.id, path: route.path, kind: route.id === "demos" || route.id === "federation" ? "demo" : "marketing",
    actions: actionsFor(route),
    groups: [
      ...(route.id === "index" ? [{ id: "hero-actions", ruleId: "ULI-L10", relation: "centerline", edge: "center", widths: [1280], peers: [link("Why Limen"), link("Challenge the boundary"), link("See the architecture")], scope: "main", rationale: "Hero calls to action share one row" }] : []),
      ...(route.id === "demos" ? [
        { id: "release-evidence-controls", ruleId: "ULI-L10", relation: "centerline", edge: "center", widths: [1280], peers: ["Pass tests", "Fail tests", "Clear security", "Block security", "Approve release"].map(button), region: "release", rationale: "Evidence and approval controls share one control row" },
        { id: "policy-controls", ruleId: "ULI-L10", relation: "centerline", edge: "center", widths: [1280], peers: ["1. Start policy A", "2. Start newer policy B", "3. Deliver A first", "4. Deliver B", "Reset"].map(button), region: "policy", rationale: "Policy controls share one control row in their numbered order" }
      ] : [])
    ]
  }))
]);

export const surfaceForRoute = route => SURFACES.find(surface => surface.path === route.path);

export const declaredActionsFor = route => [
  ...CHROME.map(action => ({ ...action, surfaceId: "chrome" })),
  ...(surfaceForRoute(route)?.actions ?? []).map(action => ({ ...action, surfaceId: surfaceForRoute(route).id }))
];
