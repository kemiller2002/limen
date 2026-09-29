// Real-browser proof for every capability pack (kemiller2002/limen#15), and
// for Core mechanisms whose behaviour only a real browser shows (directories
// named core-*, such as form-control state).
//
// Each directory under test/browser/packs/ is one page. Its own script
// drives the pack through the real kernel and sets
//   window.__limenPackResult = { pack, checks: [{ name, ok, detail }] }.
// This runner serves them under the same strict CSP with Trusted Types
// enforced and no policy that scripts/smoke-security.ts uses, and fails on
// any failed check, any policy violation, any uncaught error, or a page that
// never reports. A new pack adds a page; the runner and its CI step stay put.
//
// Needs Playwright; locally a skip is reported, and LIMEN_REQUIRE_BROWSER=1
// forbids skipping.

import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

type Page = {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  addInitScript(script: { content: string }): Promise<void>;
  on(event: "pageerror", handler: (error: { message?: string }) => void): void;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };
type Chromium = { launch(): Promise<Browser> };
type Check = { readonly name: string; readonly ok: boolean; readonly detail: string };

const ROOT = process.cwd();
const PORT = 4194;
const PACKS = "test/browser/packs";

const POLICY = [
  "default-src 'none'", "script-src 'self'", "connect-src 'self'", "img-src 'self'", "style-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "object-src 'none'",
  "require-trusted-types-for 'script'", "trusted-types 'none'",
].join("; ");

const CONTENT_TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const serve = (): Promise<Server> => {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(ROOT)) { response.writeHead(403).end(); return; }
    readFile(file).then(
      (body) => { response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": POLICY }).end(body); },
      () => { response.writeHead(404).end(); },
    );
  });
  return new Promise((resolve) => { server.listen(PORT, "127.0.0.1", () => resolve(server)); });
};

const RECORD_VIOLATIONS = `
  window.__limenViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__limenViolations.push(event.violatedDirective + " " + (event.blockedURI || "") + " " + (event.sample || ""));
  });`;

// page.evaluate goes through the DevTools protocol, which the page's policy
// does not govern; Playwright's string waitForFunction would use in-page eval
// and trip Trusted Types itself.
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

const runPack = async (browser: Browser, pack: string): Promise<readonly string[]> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message ?? "page error"); });
    await page.addInitScript({ content: RECORD_VIOLATIONS });
    await page.goto(`http://127.0.0.1:${PORT}/${PACKS}/${pack}/index.html`);
    const reported = await waitUntil(page, "window.__limenPackResult", 30000);
    const checks = reported ? await page.evaluate<readonly Check[]>("window.__limenPackResult.checks") : [];
    const violations = await page.evaluate<readonly string[]>("window.__limenViolations.slice()");
    checks.forEach((check) => { console.log(`${check.ok ? "PASS" : "FAIL"}  ${pack}: ${check.name}`); });
    return [
      ...(reported ? [] : [`${pack}: the page never reported a result`]),
      ...(reported && checks.length === 0 ? [`${pack}: the page reported no checks`] : []),
      ...checks.filter((check) => !check.ok).map((check) => `${pack}: ${check.name} — ${check.detail}`),
      ...violations.map((violation) => `${pack}: policy violation ${violation}`),
      ...errors.map((error) => `${pack}: uncaught ${error}`),
    ];
  } finally {
    await context.close();
  }
};

const chromium = await (async (): Promise<Chromium | undefined> => {
  try {
    return (await import("playwright") as { chromium: Chromium }).chromium;
  } catch {
    return undefined;
  }
})();

const packs = (await readdir(join(ROOT, PACKS), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();

if (chromium === undefined) {
  if (process.env.LIMEN_REQUIRE_BROWSER === "1") {
    console.error("Playwright is not installed, and LIMEN_REQUIRE_BROWSER=1 forbids skipping.");
    process.exitCode = 1;
  } else {
    console.log("Playwright is not installed, so the capability pack smoke was skipped.");
  }
} else {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const failures = await packs.reduce<Promise<readonly string[]>>(async (done, pack) => [...(await done), ...(await runPack(browser, pack))], Promise.resolve([]));
    if (failures.length > 0) {
      console.error(`\n${failures.length} capability pack check(s) failed:\n${failures.join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log(`\nCapability packs passed in Chromium under a strict CSP with Trusted Types (${packs.join(", ")}).`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}
