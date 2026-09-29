// Real-browser binding security smoke (kemiller2002/limen#18, LCP-027).
//
// Serves test/browser/security/ under a strict Content-Security-Policy with
// Trusted Types enforced and no policy defined — the setting in which any
// HTML-string sink, inline handler or javascript: URL the kernel wrote would
// throw or be reported. Then checks, in Chromium:
//
//   1. Trusted Types really is enforced (an innerHTML probe throws), so the
//      rest cannot pass vacuously.
//   2. The kernel starts, projects and re-projects with zero policy violations.
//   3. Projected markup stays text; no payload ever runs.
//   4. Unsafe URLs are never written; safe ones are; each refusal is reported
//      without the value.
//   5. If dist-guests/ is built, the three WebAssembly guest engines run under
//      the same policy (plus 'wasm-unsafe-eval', which compiling WebAssembly
//      requires) with the handshake negotiated and zero violations.
//
// Needs Playwright; locally a skip is reported, and LIMEN_REQUIRE_BROWSER=1
// forbids skipping.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

type Page = {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
  addInitScript(script: { content: string }): Promise<void>;
  on(event: "pageerror" | "console", handler: (value: { message?: string; text?: () => string }) => void): void;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };
type Chromium = { launch(): Promise<Browser> };

const ROOT = process.cwd();
const PORT = 4192;
const GUEST_PORT = 4193;

const POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "style-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "require-trusted-types-for 'script'",
  "trusted-types 'none'",
].join("; ");
// Compiling WebAssembly needs 'wasm-unsafe-eval' — it permits no JavaScript eval.
const GUEST_POLICY = POLICY.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm",
};

const serve = (directory: string, port: number, policy: string): Promise<Server> => {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    const file = join(directory, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(directory)) { response.writeHead(403).end(); return; }
    readFile(file).then(
      (body) => { response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": policy }).end(body); },
      () => { response.writeHead(404).end(); },
    );
  });
  return new Promise((resolve) => { server.listen(port, "127.0.0.1", () => resolve(server)); });
};

// Records every CSP / Trusted Types violation from before the first script runs.
const RECORD_VIOLATIONS = `
  window.__limenViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__limenViolations.push(event.violatedDirective + " " + (event.blockedURI || "") + " " + (event.sample || ""));
  });`;

const TRUSTED_TYPES_PROBE = `(() => {
  try { document.createElement("div").innerHTML = "<b>probe</b>"; return "innerHTML accepted a string: Trusted Types is not enforced"; }
  catch (error) { return error instanceof TypeError ? "enforced" : "unexpected " + String(error); }
})()`;

// Playwright's waitForFunction evaluates a string predicate with eval inside
// the page, which Trusted Types rightly blocks. page.evaluate runs through the
// DevTools protocol instead and is not subject to the page's policy, so the
// harness polls with it and never adds a violation of its own.
const waitUntil = async (page: Page, expression: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<boolean> => {
    if (await page.evaluate<boolean>(`Boolean(${expression})`).catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
    return poll();
  };
  return poll();
};

const chromium = await (async (): Promise<Chromium | undefined> => {
  try {
    return (await import("playwright") as { chromium: Chromium }).chromium;
  } catch {
    return undefined;
  }
})();

const check = (failures: string[], passes: string[], name: string, ok: boolean, detail = ""): void => {
  if (ok) passes.push(`PASS  ${name}`);
  else failures.push(`${name}${detail === "" ? "" : `: ${detail}`}`);
};

const smokePage = async (browser: Browser, failures: string[], passes: string[]): Promise<void> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message ?? "page error"); });
    await page.addInitScript({ content: RECORD_VIOLATIONS });
    await page.goto(`http://127.0.0.1:${PORT}/test/browser/security/index.html`);
    if (!await waitUntil(page, "window.__limenReady === true", 30000)) throw new Error("the security page did not start");
    for (const _ of [1, 2, 3, 4, 5, 6]) await page.click("#next");
    if (!await waitUntil(page, "document.getElementById('round').textContent === '6'", 10000)) throw new Error("the security page did not re-project");
    await page.click("#unsafe");
    await page.click("#rows li:first-child a");
    const state = await page.evaluate<{
      violations: string[]; pwned: unknown; text: string; images: number; scripts: number; unsafeHref: string | null; imageSrc: string | null;
      safeHref: string | null; rowHrefs: (string | null)[]; refusals: string[]; bindingErrors: string[]; location: string;
    }>(`({
      violations: window.__limenViolations.slice(),
      pwned: window.__limenPwned,
      text: document.getElementById("text").textContent,
      images: document.querySelectorAll("#text img, #rows img").length,
      scripts: document.querySelectorAll("body script:not([type=module])").length,
      unsafeHref: document.getElementById("unsafe").getAttribute("href"),
      imageSrc: document.getElementById("image").getAttribute("src"),
      safeHref: document.getElementById("safe").getAttribute("href"),
      rowHrefs: Array.from(document.querySelectorAll("#rows a"), (a) => a.getAttribute("href")),
      refusals: window.__limenDiagnostics.filter((e) => e.kind === "BridgeError" && e.phase === "projection").map((e) => e.detail),
      bindingErrors: window.__limenDiagnostics.filter((e) => e.kind === "BridgeError" && e.phase !== "projection").map((e) => e.detail),
      location: window.location.pathname,
    })`);
    const probe = await page.evaluate<string>(TRUSTED_TYPES_PROBE);
    check(failures, passes, "Trusted Types is enforced on the page (innerHTML probe throws)", probe === "enforced", probe);
    check(failures, passes, "kernel ran with zero CSP / Trusted Types violations", state.violations.length === 0, state.violations.join(" | "));
    check(failures, passes, "no uncaught page errors", errors.length === 0, errors.join(" | "));
    check(failures, passes, "no bridge errors other than URL refusals", state.bindingErrors.length === 0, state.bindingErrors.join(" | "));
    check(failures, passes, "projected markup stays text; no payload ran", state.pwned === undefined && state.images === 0 && state.scripts === 0 && state.text.startsWith("<img src=x onerror="), JSON.stringify({ pwned: state.pwned, images: state.images, scripts: state.scripts }));
    check(failures, passes, "unsafe URLs were never written (links and image)", state.unsafeHref === null && state.imageSrc === null, JSON.stringify({ href: state.unsafeHref, src: state.imageSrc }));
    check(failures, passes, "safe URLs were written", state.safeHref === "/safe?round=6" && state.rowHrefs.filter((href) => href !== null).every((href) => href.startsWith("https://example.com/")) && state.rowHrefs.filter((href) => href !== null).length === 3, JSON.stringify(state.rowHrefs));
    check(failures, passes, "each unsafe URL refusal is reported without its value", state.refusals.length > 0 && state.refusals.every((detail) => detail.startsWith("refused a ") && !detail.includes("__limenPwned") && !detail.includes("msgbox")), state.refusals.slice(0, 3).join(" | "));
    check(failures, passes, "clicking a neutralized link navigates nowhere", state.location === "/test/browser/security/index.html", state.location);
  } finally {
    await context.close();
  }
};

const smokeGuests = async (browser: Browser, failures: string[], passes: string[]): Promise<void> => {
  if (!existsSync(join(ROOT, "dist-guests/guests/minimal/host/index.html"))) {
    passes.push("SKIP  guest engines under strict CSP: dist-guests/ is not built (npm run build:guests)");
    return;
  }
  const server = await serve(join(ROOT, "dist-guests"), GUEST_PORT, GUEST_POLICY);
  try {
    for (const engine of ["fsharp", "csharp", "rust"]) {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.addInitScript({ content: RECORD_VIOLATIONS });
        await page.goto(`http://127.0.0.1:${GUEST_PORT}/guests/minimal/host/index.html?engine=${engine}`);
        const started = await waitUntil(page, "document.querySelector('[data-text=status]')?.textContent === 'ready'", 120000);
        const roundTrip = started && await (async () => {
          await page.click('button[data-event="storage-set"]');
          return waitUntil(page, "Array.from(document.querySelectorAll('ol li'), (li) => li.textContent).includes('storage-set: success null')", 30000);
        })();
        const violations = await page.evaluate<string[]>("window.__limenViolations.slice()");
        const handshake = await page.evaluate<string>("JSON.stringify((window.limenDiagnostics || []).find((event) => event.kind === 'Handshake') || null)");
        const probe = await page.evaluate<string>(TRUSTED_TYPES_PROBE);
        check(failures, passes, `${engine} guest runs under strict CSP + Trusted Types (handshake negotiated, zero violations)`, started && roundTrip && probe === "enforced" && violations.length === 0 && handshake.includes("Negotiated"), JSON.stringify({ started, roundTrip, probe, violations: violations.slice(0, 3), handshake }));
      } finally {
        await context.close();
      }
    }
  } finally {
    server.close();
  }
};

const failures: string[] = [];
const passes: string[] = [];
if (chromium === undefined) {
  if (process.env.LIMEN_REQUIRE_BROWSER === "1") failures.push("Playwright is not installed, and LIMEN_REQUIRE_BROWSER=1 forbids skipping.");
  else console.log("Playwright is not installed, so the binding security smoke was skipped.");
} else {
  const server = await serve(ROOT, PORT, POLICY);
  const browser = await chromium.launch();
  try {
    await smokePage(browser, failures, passes);
    await smokeGuests(browser, failures, passes);
  } finally {
    await browser.close();
    server.close();
  }
  console.log(passes.join("\n"));
}

if (failures.length > 0) {
  console.error(`\n${failures.length} binding security check(s) failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else if (chromium !== undefined) {
  console.log(`\nBinding security smoke passed under: ${POLICY}`);
}
