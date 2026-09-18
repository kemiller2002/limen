// Exercises the DOM-facing behavior in a real browser.
//
// This repository's definition of done says that anything touching the DOM must
// be exercised in a real browser, not only asserted in jsdom — and jsdom really
// does differ where it matters most here. It has no Clipboard API at all, and
// its history implementation is a model of the real one rather than the real
// one. A clipboard write that Chromium accepts and can read back, and a Back
// button that moves a real session history, are claims only a browser can
// settle.
//
// **Playwright is not a dependency.** Adding a browser automation stack to a
// package that ships with zero runtime dependencies, for a check that runs by
// hand, is not a trade this repository makes. Install it yourself and run:
//
//     npm i -g playwright && playwright install chromium
//     npm run smoke:browser
//
// Without it, this script says so and exits 0 — `npm run check` does not depend
// on it. `test/kernel.test.ts` and `test/examples.test.ts` remain the gate.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}`;

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

type Chromium = { launch(options?: { headless?: boolean }): Promise<BrowserLike> };
type BrowserLike = {
  newContext(options?: { permissions?: readonly string[] }): Promise<ContextLike>;
  close(): Promise<void>;
};
type ContextLike = { newPage(): Promise<PageLike> };
type PageLike = {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  isDisabled(selector: string): Promise<boolean>;
  waitForSelector(selector: string): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  $(selector: string): Promise<unknown | null>;
  url(): string;
  goBack(): Promise<unknown>;
  goForward(): Promise<unknown>;
  on(event: string, handler: (payload: never) => void): void;
};

// A static file server, written here rather than depended on: three of these
// examples are only correct when *served*, because ES modules will not load
// from a file:// URL.
function serve(): { close: () => Promise<void> } {
  const server = createServer((request, response) => {
    const requested = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const relative = normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const path = join(ROOT, relative.endsWith("/") ? `${relative}index.html` : relative);
    stat(path).then(
      (found) => {
        if (found.isDirectory()) { response.writeHead(302, { location: `${requested}/` }); response.end(); return; }
        response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
        createReadStream(path).pipe(response);
      },
      () => { response.writeHead(404); response.end("not found"); },
    );
  });
  server.listen(PORT, "127.0.0.1");
  return { close: () => new Promise<void>((done) => { server.close(() => done()); }) };
}

const chromium = await (async (): Promise<Chromium | null> => {
  try {
    const playwright = await import("playwright") as { chromium: Chromium };
    return playwright.chromium;
  } catch {
    return null;
  }
})();

if (chromium === null) {
  console.log("Playwright is not installed, so the browser smoke test was skipped.");
  console.log("  npm i -g playwright && playwright install chromium");
  process.exit(0);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = ""): void => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
};
const trimmed = async (page: PageLike, selector: string): Promise<string> => (await page.textContent(selector))?.trim() ?? "";

const server = serve();
const browser = await chromium.launch();

try {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on("pageerror", (error: never) => failures.push(String(error)));

  // --- 01 counter: the binding mechanism itself ----------------------------
  await page.goto(`${BASE}/examples/01-counter/`);
  await page.click("button[data-event='increment']");
  check("01 counter increments", await trimmed(page, "[data-text='count']") === "1");
  check("01 counter enables Reset", !(await page.isDisabled("button[data-event='reset']")));

  // --- 07 clipboard: the part jsdom cannot test at all ---------------------
  await page.goto(`${BASE}/examples/07-clipboard/`);
  const shown = await trimmed(page, ".list li code");
  await page.click(".list li button[data-event='copy']");
  await page.waitForSelector(".status");
  check("07 clipboard reports success", await trimmed(page, ".status") === "Copied to the clipboard.");
  const pasted = await page.evaluate(() => navigator.clipboard.readText());
  check("07 clipboard wrote the projected URL, verbatim", pasted === shown, `clipboard=${pasted}`);
  await page.click("button[data-event='dismiss']");
  check("07 clipboard dismiss clears the status", await page.$(".status") === null);

  // --- 08 routing: real session history, not a model of one ----------------
  await page.goto(`${BASE}/examples/08-routing/`);
  check("08 routing starts at Home", await trimmed(page, "section h2") === "Home");
  await page.click("button[data-event='goInvoices']");
  check("08 routing pushes the invoices URL", page.url().includes("route=%2Finvoices"), page.url());
  await page.click(".list li button[data-event='openInvoice']");
  check("08 routing opens an invoice", await trimmed(page, "section h2") === "Invoice 1001");
  await page.goBack();
  check("08 routing: the browser's own Back returns to the list", await trimmed(page, "section h2") === "Invoices");
  await page.goForward();
  check("08 routing: Forward returns to the invoice", await trimmed(page, "section h2") === "Invoice 1001");
  await page.click("button[data-event='goBack']");
  await page.waitForTimeout(150);
  check("08 routing: the in-app Back button moves too", await trimmed(page, "section h2") === "Invoices");
  await page.goto(`${BASE}/examples/08-routing/?route=%2Finvoices%2F1002`);
  check("08 routing: a pasted deep link opens that screen directly", await trimmed(page, "section h2") === "Invoice 1002");
  await page.goto(`${BASE}/examples/08-routing/?route=%2Finvoices%2F9999`);
  check("08 routing: an unknown id is the Not found screen", await trimmed(page, "section h2") === "Not found");

  // --- both capabilities at once: compose a shareable link, then copy it ---
  await page.goto(`${BASE}/examples/08-routing/`);
  await page.click("button[data-event='goInvoices']");
  const link = await trimmed(page, "code[data-text='currentUrl']");
  await page.click("button[data-event='copyLink']");
  await page.waitForSelector(".status");
  const copiedLink = await page.evaluate(() => navigator.clipboard.readText());
  check("08 routing: Copy link copies the absolute URL of the current screen", copiedLink === link && link === page.url(), `clipboard=${copiedLink}`);

  // --- the pages that were already shipping still bind ---------------------
  await page.goto(`${BASE}/`);
  check("the reference feature binds", await page.$("[data-text='statusText']") !== null);
  await page.goto(`${BASE}/examples/kitchen-sink.html`);
  check("the kitchen sink binds", await page.$("[data-event]") !== null);

  check("no uncaught page errors anywhere", failures.length === 0, failures.join(" | "));
} finally {
  await browser.close();
  await server.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
if (failed.length > 0) process.exitCode = 1;
