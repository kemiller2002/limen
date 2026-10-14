// UI conformance suite for the Limen product site against
// visual-engineering/UI-LAYOUT-INTERACTION@1.0.0. Every action resolves by role
// and accessible name, waits with web-first assertions and compares observed
// pre/post state. No coordinates, no fixed sleeps. Demo state is owned by the
// F# WebAssembly engine; the suite observes its projection.
import { expect, test } from "@playwright/test";
import {
  CONTRACT_WIDTHS,
  expectActionOutcome,
  expectLabelIntact,
  expectNoOverflow,
  expectPeerAlignment,
  inventoryActions,
  recordTabSequence,
  scaleDefaultText,
  settleFontsAndFrames,
  wasFocusedDuringSequence
} from "./forma-conformance/index.mjs";
import { CHROME, NAV_NAMES, ROUTES, SURFACES, declaredActionsFor } from "./surfaces.mjs";

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CHROME_PROBE = "/evidence.html";

const annotate = (type, description) => test.info().annotations.push({ type, description });
const primaryNav = page => page.getByRole("navigation", { name: "Primary" });
const pathPattern = destination => new RegExp(`^https?://[^/]+${escape(destination)}$`);
const heading = page => page.getByRole("heading", { level: 1 });
// Declared actions name the landmark they live in, so a label that is both a
// navigation destination and a call to action resolves unambiguously.
const scopeOf = (page, scope) => (scope === "navigation" ? primaryNav(page) : scope && scope !== "page" ? page.getByRole(scope) : page);
const nameMatches = (declared, actual) => (declared instanceof RegExp ? declared.test(actual) : declared === actual);

// --- ULI-L05/L06/L09: every page at every contract width ---------------------

for (const width of CONTRACT_WIDTHS) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const route of ROUTES) {
      test(`${route.path} renders without overflow, with intact navigation labels`, async ({ page }) => {
        annotate("uli-surface", route.id);
        annotate("uli-surface", "chrome");
        await page.goto(route.path);
        await expect(heading(page)).toHaveText(route.heading);
        await expectNoOverflow(page);
        for (const name of [...NAV_NAMES, "GitHub"]) await expectLabelIntact(primaryNav(page).getByRole("link", { name, exact: true }));
        await expect(primaryNav(page).locator("[aria-current=page]")).toHaveCount(route.current ? 1 : 0);
        if (route.current) await expect(primaryNav(page).getByRole("link", { name: route.current, exact: true })).toHaveAttribute("aria-current", "page");
      });
    }
  });

  test.describe(`at ${width}px with 200% text`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const route of ROUTES) {
      test(`${route.path} reflows without overflow`, async ({ page }) => {
        annotate("uli-surface", route.id);
        await page.goto(route.path);
        await scaleDefaultText(page, 2);
        await expectNoOverflow(page);
        for (const name of NAV_NAMES) await expectLabelIntact(primaryNav(page).getByRole("link", { name, exact: true }));
      });
    }
  });
}

// --- ULI-A01/A06/A10: only declared actions render ----------------------------

const engineStarted = async page => {
  if (!["/index.html", "/demos.html"].includes(new URL(page.url()).pathname)) return;
  // The engine's first projection fills the release verdict.
  await expect(page.locator('[data-text="releaseDecision"]').first()).not.toHaveText("", { timeout: 30_000 });
};

for (const route of ROUTES) {
  test(`${route.path} renders only declared actions`, async ({ page }) => {
    annotate("uli-surface", route.id);
    await page.goto(route.path);
    await engineStarted(page);
    await settleFontsAndFrames(page);
    const declared = declaredActionsFor(route);
    const isDeclared = item => declared.some(action => action.control.role === item.role && nameMatches(action.control.name, item.name));
    const outside = [...(await inventoryActions(page.getByRole("banner"))), ...(await inventoryActions(page.getByRole("contentinfo")))];
    const mainItems = await inventoryActions(page.locator("main"));
    expect(outside.filter(item => !isDeclared(item)).map(item => `${item.role} "${item.name}" -> ${item.href}`), "ULI-A10: chrome actions without a declared contract").toEqual([]);
    // Every control in <main> that is not a link must be a declared demo action.
    expect(mainItems.filter(item => item.role !== "link" && !isDeclared(item)).map(item => `${item.role} "${item.name}"`), "ULI-A10: controls without a declared contract").toEqual([]);
    expect([...outside, ...mainItems].filter(item => !item.name).map(item => `${item.role} ${item.href ?? ""}`), "ULI-A06: actions without an accessible name").toEqual([]);
  });
}

// --- ULI-A01: every content link in <main> has a meaningful destination ------

const pageHasFragment = async (request, path, fragment) => {
  const response = await request.get(path);
  const body = await response.text();
  return { status: response.status(), found: !fragment || new RegExp(`\\sid="${escape(fragment)}"`).test(body) };
};

for (const route of ROUTES) {
  test(`${route.path} content links resolve`, async ({ page, request, baseURL }) => {
    annotate("uli-content-links", route.id);
    await page.goto(route.path);
    const links = await page.locator("main a[href]").evaluateAll(anchors => anchors.map(anchor => ({
      text: anchor.textContent.replace(/\s+/g, " ").trim(), href: anchor.getAttribute("href"), resolved: anchor.href
    })));
    const problems = [];
    for (const item of links) {
      const url = new URL(item.resolved);
      if (item.href.startsWith("javascript:") || item.href === "#" || item.href === "") {
        problems.push(`"${item.text}" has no destination (${item.href})`);
      } else if (url.origin === new URL(baseURL).origin) {
        const result = await pageHasFragment(request, url.pathname, decodeURIComponent(url.hash.slice(1)));
        if (result.status !== 200) problems.push(`"${item.text}" -> ${item.href}: HTTP ${result.status}`);
        else if (!result.found) problems.push(`"${item.text}" -> ${item.href}: fragment target missing`);
      } else if (!["https:", "mailto:"].includes(url.protocol)) {
        problems.push(`"${item.text}" -> ${item.href}: not an https destination`);
      }
    }
    expect(problems, `ULI-A01: ${links.length} content links on ${route.path}`).toEqual([]);
  });
}

// --- Declared links: destination and navigation outcome (ULI-A01/A02/A06) ----

for (const surface of SURFACES) {
  for (const action of surface.actions.filter(item => item.kind === "navigate" || item.kind === "external" || item.kind === "skip")) {
    test(`${surface.id}/${action.id} destination is valid`, async ({ page, request }) => {
      annotate("uli-destination", `${surface.id}/${action.id}`);
      await page.goto(action.from ?? surface.path);
      const control = scopeOf(page, action.scope).getByRole("link", { name: action.control.name, exact: true });
      await expect(control).toHaveCount(1);
      await expect(control).toHaveAttribute("href", action.href);
      if (action.kind === "navigate") expect((await request.get(action.destination)).status(), action.destination).toBe(200);
      if (action.kind === "skip") await expect(page.locator(action.destination)).toHaveCount(1);
      if (action.kind === "external") expect(new URL(action.destination).protocol).toBe("https:");
    });
  }
}

const navigationActions = SURFACES.flatMap(surface => surface.actions.filter(action => action.kind === "navigate").map(action => ({ surface, action })));

for (const width of [390, 1280]) {
  test.describe(`navigation outcomes at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });
    for (const { surface, action } of navigationActions) {
      test(`${surface.id}: ${action.id} reaches ${action.destination}`, async ({ page }) => {
        annotate("uli-action", `${surface.id}/${action.id}`);
        await page.goto(action.from);
        await expectActionOutcome(page, {
          ruleId: "ULI-A02",
          action: { ...action.control, scope: action.scope && action.scope !== "page" ? scopeOf(page, action.scope) : undefined },
          outcome: { kind: "url", expected: pathPattern(action.destination) }
        });
        await expect(heading(page)).toHaveText(action.heading);
      });
    }

    test("skip link moves to the main content", async ({ page }) => {
      annotate("uli-action", "chrome/skip-link");
      await page.goto(CHROME_PROBE);
      const skip = page.getByRole("link", { name: "Skip to main content" });
      await expect(skip).not.toBeInViewport();
      await page.keyboard.press("Tab");
      await expect(skip).toBeFocused();
      await expect(skip).toBeInViewport();
      await expectActionOutcome(page, {
        ruleId: "ULI-A02",
        action: { role: "link", name: "Skip to main content" },
        outcome: { kind: "url", expected: pathPattern(`${CHROME_PROBE}#main-content`) }
      });
      await expect(page.getByRole("main")).toBeInViewport();
    });
  });
}

for (const action of CHROME.filter(item => item.kind === "external")) {
  test(`chrome: ${action.id} points at ${action.destination}`, async ({ page }) => {
    annotate("uli-action", `chrome/${action.id}`);
    await page.goto(CHROME_PROBE);
    const control = scopeOf(page, action.scope).getByRole("link", { name: action.control.name, exact: true });
    await expect(control).toBeVisible();
    await expect(control).toHaveAttribute("href", action.destination);
  });
}

// --- Interactive demonstrations: every enabled action (ULI-A02/A05/A07/A10) --

const region = (page, name) => page.getByRole("region", { name, exact: true });
const cell = (scope, label) => scope.locator(".state-grid > div").filter({ has: scope.page().getByText(label, { exact: true }) }).locator(".status");
const readout = (scope, label) => scope.locator(".readout > div").filter({ has: scope.page().getByText(label, { exact: true }) }).locator(".value");
const press = async (scope, name) => {
  const control = scope.getByRole("button", { name, exact: true });
  await expect(control).toBeEnabled();
  await control.click();
};

const RELEASE_PAGES = [
  { surface: "index", path: "/index.html", region: "Release gate", prefix: "home-", reset: "Reset scenario", applied: "Authoritative check: applied", notApplied: "Authoritative check: not applied" },
  { surface: "demos", path: "/demos.html", region: "Can this release legally move?", prefix: "", reset: "Reset", applied: "Reconcile: applied", notApplied: "Reconcile: not applied" }
];

const tag = (setup, ids) => ids.forEach(id => annotate("uli-action", `${setup.surface}/${setup.prefix}${id}`));

const openRelease = async (page, setup) => {
  await page.goto(setup.path);
  await engineStarted(page);
  const demo = region(page, setup.region);
  await expect(demo).not.toHaveAttribute("inert");
  for (const [label, value] of [["Tests", "Unverified"], ["Security", "Unverified"], ["Approval", "Not approved"], ["Deployment", "Not started"]]) {
    await expect(cell(demo, label)).toHaveText(value);
  }
  return demo;
};

const approve = async demo => {
  await expect(demo.getByRole("button", { name: "Approve release" })).toBeDisabled();
  await press(demo, "Pass tests");
  await expect(cell(demo, "Tests")).toHaveText("Passed");
  await press(demo, "Clear security");
  await expect(cell(demo, "Security")).toHaveText("Passed");
  await press(demo, "Approve release");
  await expect(cell(demo, "Approval")).toHaveText("Approved");
};

for (const setup of RELEASE_PAGES) {
  test.describe(`${setup.path} release demonstration`, () => {
    test("evidence, approval and a successful deployment", async ({ page }) => {
      tag(setup, ["tests-pass", "security-clear", "approve", "deploy-success"]);
      const demo = await openRelease(page, setup);
      await approve(demo);
      await press(demo, "Deploy: success");
      await expect(cell(demo, "Deployment")).toHaveText("Deployed");
      await expect(demo.getByRole("status").filter({ hasText: "Complete." })).toHaveText("Complete. The deployment is authoritative.");
      await expect(demo.getByRole("button", { name: "Deploy: success" })).toBeDisabled();
    });

    test("failing evidence blocks approval and reset restores the scenario", async ({ page }) => {
      tag(setup, ["tests-fail", "security-block", "reset"]);
      const demo = await openRelease(page, setup);
      await press(demo, "Fail tests");
      await expect(cell(demo, "Tests")).toHaveText("Failed");
      await press(demo, "Block security");
      await expect(cell(demo, "Security")).toHaveText("Failed");
      await expect(demo.getByRole("button", { name: "Approve release" })).toBeDisabled();
      await press(demo, setup.reset);
      await expect(cell(demo, "Tests")).toHaveText("Unverified");
      await expect(cell(demo, "Security")).toHaveText("Unverified");
    });

    test("an unknown outcome requires reconciliation; applied is authoritative", async ({ page }) => {
      tag(setup, ["deploy-unknown", "reconcile-applied"]);
      const demo = await openRelease(page, setup);
      await approve(demo);
      await press(demo, "Evidence: timeout after dispatch");
      await expect(cell(demo, "Deployment")).toHaveText("Outcome unknown");
      await expect(demo.getByRole("button", { name: "Deploy: success" })).toBeDisabled();
      await press(demo, setup.applied);
      await expect(cell(demo, "Deployment")).toHaveText("Deployed");
      await expect(demo.getByRole("button", { name: setup.applied })).toHaveCount(0);
    });

    test("an unknown outcome reconciled as not applied re-enables deployment", async ({ page }) => {
      tag(setup, ["reconcile-not-applied"]);
      const demo = await openRelease(page, setup);
      await approve(demo);
      await press(demo, "Evidence: timeout after dispatch");
      await press(demo, setup.notApplied);
      await expect(cell(demo, "Deployment")).toHaveText("Not started");
      await expect(demo.getByRole("button", { name: "Deploy: success" })).toBeEnabled();
    });

    test("a transport failure is reported as a failure, never as deployed", async ({ page }) => {
      tag(setup, ["deploy-network-failure"]);
      const demo = await openRelease(page, setup);
      await approve(demo);
      await press(demo, "Deploy: network failure");
      await expect(cell(demo, "Deployment")).toHaveText("Failed");
      await expect(demo.getByRole("status").filter({ hasText: "Retry" })).toHaveText(/^Retry may be allowed: /);
      await expect(cell(demo, "Deployment")).not.toHaveText("Deployed");
    });
  });
}

test.describe("/demos.html other demonstrations", () => {
  test("stale policy evidence is discarded and the current result accepted", async ({ page }) => {
    ["policy-start-a", "policy-start-b", "policy-deliver-a", "policy-deliver-b", "policy-reset"].forEach(id => annotate("uli-action", `demos/${id}`));
    await page.goto("/demos.html");
    await engineStarted(page);
    const demo = region(page, "Overlapping policy checks");
    await expect(readout(demo, "Latest request")).toHaveText("none");
    await press(demo, "1. Start policy A");
    await expect(readout(demo, "Latest request")).toHaveText("policy-a");
    await expect(demo.getByRole("button", { name: "1. Start policy A" })).toBeDisabled();
    await press(demo, "2. Start newer policy B");
    await expect(readout(demo, "Latest request")).toHaveText("policy-b");
    await press(demo, "3. Deliver A first");
    await expect(readout(demo, "Stale discarded")).toHaveText("1");
    await expect(readout(demo, "Accepted result")).toHaveText("none");
    await press(demo, "4. Deliver B");
    await expect(readout(demo, "Accepted result")).toHaveText("policy-b → Review required");
    await press(demo, "Reset");
    await expect(readout(demo, "Latest request")).toHaveText("none");
    await expect(demo.getByRole("button", { name: "1. Start policy A" })).toBeEnabled();
  });

  test("a placement answer is judged once, then the next task is offered", async ({ page }) => {
    ["placement-pick", "placement-next"].forEach(id => annotate("uli-action", `demos/${id}`));
    await page.goto("/demos.html");
    await engineStarted(page);
    const demo = region(page, "Where does this decision belong?");
    await expect(demo.getByRole("heading", { level: 3 })).toHaveText("Task 1 of 12");
    const choices = demo.getByRole("button", { name: /^(HTML|CSS|Limen kernel|F# engine|Effect request|Protocol change)$/ });
    await expect(choices).toHaveCount(6);
    const first = choices.first();
    await expectActionOutcome(page, {
      ruleId: "ULI-A02",
      action: { role: "button", name: await first.textContent(), scope: demo },
      outcome: { kind: "attribute", target: { role: "button", name: await first.textContent(), scope: demo }, attribute: "aria-pressed", expected: "true" }
    });
    await expect(demo.getByRole("status")).toHaveText(/^(Correct — |Not quite\. )/);
    await expect(demo.getByText(/^[01] of 1 so far$/)).toBeVisible();
    // Answered: picking again is not a legal command, so no choice offers it.
    for (const choice of await choices.all()) await expect(choice).toBeDisabled();
    await press(demo, "Next challenge");
    await expect(demo.getByRole("heading", { level: 3 })).toHaveText("Task 2 of 12");
    await expect(demo.getByRole("status")).toHaveCount(0);
    await expect(choices.first()).toBeEnabled();
  });

  test("the trace records transitions and clears only when it has entries", async ({ page }) => {
    annotate("uli-action", "demos/trace-clear");
    await page.goto("/demos.html");
    await engineStarted(page);
    const trace = region(page, "Cross-boundary decisions");
    await expect(trace.getByRole("button", { name: "Clear trace" })).toBeDisabled();
    await press(region(page, "Can this release legally move?"), "Pass tests");
    await expect(trace.getByRole("list", { name: "Application transition trace, newest first" }).getByRole("listitem")).toHaveCount(1);
    await press(trace, "Clear trace");
    await expect(trace.getByText("Use any challenge above. Legal state changes appear here.")).toBeVisible();
    await expect(trace.getByRole("button", { name: "Clear trace" })).toBeDisabled();
  });
});

// --- Failure path: the engine cannot start -----------------------------------

for (const path of ["/index.html", "/demos.html"]) {
  test(`${path} says when the F# engine cannot start and offers no dead controls`, async ({ page }) => {
    annotate("uli-surface", path === "/index.html" ? "index" : "demos");
    await page.route("**/wasm/_framework/dotnet.js", route => route.abort("connectionrefused"));
    await page.goto(path);
    const demos = page.locator("[data-requires-engine], .demo");
    await expect(page.getByRole("status").filter({ hasText: "could not start" }).first()).toBeVisible();
    // Every demonstration control is unreachable rather than silently inert.
    // (Role queries ignore `inert`, so the containment is checked directly.)
    const exposed = await page.getByRole("main").locator("button").evaluateAll(buttons =>
      buttons.filter(button => !button.disabled && !button.closest("[inert]")).map(button => button.textContent.trim()));
    expect(exposed, "ULI-A01/A07: buttons exposed while no engine can answer them").toEqual([]);
    await expect(demos.first()).toHaveAttribute("aria-busy", "false");
  });
}

test("/federation.html proves the two-module exchange", async ({ page }) => {
  annotate("uli-surface", "federation");
  await page.goto("/federation.html");
  await expect(page.getByRole("heading", { level: 2, name: /^Passed: two independent F# WebAssembly runtimes/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("#federation-transcript")).not.toHaveText("Waiting for modules…");
});

test("/federation.html reports a runtime that cannot load as a failure", async ({ page }) => {
  annotate("uli-surface", "federation");
  await page.route(/\/federation\/.*\/dotnet\.js$/, route => route.abort("connectionrefused"));
  await page.goto("/federation.html");
  await expect(page.getByRole("heading", { level: 2, name: /^Failed: / })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { level: 2, name: /^Passed/ })).toHaveCount(0);
});

// --- ULI-L01/L02/L10: declared alignment groups ----------------------------

for (const surface of SURFACES) {
  for (const group of surface.groups) {
    for (const width of group.widths) {
      test(`${surface.id}: ${group.id} aligns at ${width}px`, async ({ page }) => {
        annotate("uli-group", `${surface.id}/${group.id}@${width}`);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(surface.id === "chrome" ? CHROME_PROBE : surface.path);
        await engineStarted(page);
        const scope = group.region ? region(page, { release: "Can this release legally move?", policy: "Overlapping policy checks" }[group.region])
          : group.scope === "navigation" ? primaryNav(page) : group.scope ? page.getByRole(group.scope) : undefined;
        await expectPeerAlignment(page, { ruleId: group.ruleId, id: group.id, edge: group.edge, peers: group.peers, scope });
      });
    }
  }
}

// --- ULI-A08: keyboard reachability; reduced motion; forced colors ----------

test("every chrome action is reachable by keyboard", async ({ page }) => {
  annotate("uli-surface", "chrome");
  await page.goto(CHROME_PROBE);
  await page.getByRole("main").evaluate(main => main.setAttribute("inert", ""));
  await recordTabSequence(page, CHROME.length + 2);
  for (const action of CHROME) {
    expect(await wasFocusedDuringSequence(scopeOf(page, action.scope).getByRole("link", { name: action.control.name, exact: true })), action.id).toBe(true);
  }
});

test("the release demonstration is operable by keyboard", async ({ page }) => {
  annotate("uli-surface", "demos");
  await page.goto("/demos.html");
  await engineStarted(page);
  const demo = region(page, "Can this release legally move?");
  await demo.getByRole("button", { name: "Pass tests" }).focus();
  await page.keyboard.press("Enter");
  await expect(cell(demo, "Tests")).toHaveText("Passed");
  await page.keyboard.press("Tab");
  await expect(demo.getByRole("button", { name: "Fail tests" })).toBeFocused();
});

test("reduced motion removes smooth scrolling and transitions", async ({ page }) => {
  annotate("uli-surface", "index");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/index.html");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");
  await expect.poll(() => page.getByRole("main").getByRole("link", { name: "Why Limen", exact: true }).evaluate(element => getComputedStyle(element).transitionDuration)).toBe("0s");
});

test("forced colors keep filled controls bounded and navigation visible", async ({ page }) => {
  annotate("uli-surface", "index");
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/index.html");
  await expect.poll(() => page.getByRole("main").getByRole("link", { name: "Why Limen", exact: true }).evaluate(element => getComputedStyle(element).borderTopStyle)).toBe("solid");
  for (const name of NAV_NAMES) await expect(primaryNav(page).getByRole("link", { name, exact: true })).toBeVisible();
  await expectNoOverflow(page);
});

test("an unknown page is reported as not found", async ({ request }) => {
  annotate("uli-surface", "chrome");
  expect((await request.get("/no-such-page.html")).status()).toBe(404);
});
