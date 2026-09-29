// Real-browser proof (kemiller2002/limen#17, LCP-001): the F#, C# and Rust
// minimal engines, compiled to WebAssembly, each drive every built-in Limen
// capability through the same unmodified kernel — a success and a failure
// path per capability where a real browser can produce one — with the
// contract-fingerprint handshake required. Run scripts/build-guests-site.ts
// first. Needs Playwright (Chromium).

import { spawn } from "node:child_process";
import { join } from "node:path";

type Page = {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  goBack(): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, options?: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  on(event: "pageerror", handler: (error: Error) => void): void;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(options?: { permissions?: string[] }): Promise<Context>; close(): Promise<void> };
type Chromium = { launch(): Promise<Browser> };

const PORT = 4180;
const ROOT = process.cwd();
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", join(ROOT, "dist-guests")], { stdio: "ignore" });

const chromium = await (async (): Promise<Chromium | undefined> => {
  try {
    return (await import("playwright") as { chromium: Chromium }).chromium;
  } catch {
    return undefined;
  }
})();

const logText = (page: Page): Promise<string> => page.evaluate<string>("Array.from(document.querySelectorAll('ol li'), (li) => li.textContent).join('\\n')");

const waitForLog = (page: Page, pattern: RegExp): Promise<unknown> =>
  page.waitForFunction(`Array.from(document.querySelectorAll('ol li'), (li) => li.textContent).some((text) => new RegExp(${JSON.stringify(pattern.source)}).test(text))`, undefined, { timeout: 30000 });

const checks: readonly { readonly button: string | "back"; readonly expect: RegExp }[] = [
  { button: "http-ok", expect: /^http-ok: success 200$/ },
  { button: "http-missing", expect: /^http-missing: failure invalid-response 404$/ },
  { button: "storage-set", expect: /^storage-set: success null$/ },
  { button: "storage-get", expect: /^storage-get: success saved$/ },
  { button: "clipboard", expect: /^clipboard: success$/ },
  { button: "nav-push", expect: /^nav-push: success \/guests\/minimal\/host\/index\.html\?screen=two$/ },
  { button: "nav-away", expect: /^nav-away: failure not-same-origin$/ },
  // The browser's own Back: adopted as LocationChanged, never answered with a push.
  { button: "back", expect: /^location \/guests\/minimal\/host\/index\.html\?engine=/ },
];

const results: string[] = [];
const failures: string[] = [];
if (chromium === undefined) {
  // Locally a skip is reported; CI sets LIMEN_REQUIRE_BROWSER so a missing
  // browser can never turn into a silent pass.
  if (process.env.LIMEN_REQUIRE_BROWSER === "1") failures.push("Playwright is not installed, and LIMEN_REQUIRE_BROWSER=1 forbids skipping.");
  else console.log("Playwright is not installed, so the guest-engine smoke test was skipped.");
} else {
  const browser = await chromium.launch();
  try {
    for (const engine of ["fsharp", "csharp", "rust"]) {
      // Clipboard writes are permission-gated; this context grants the
      // permission so the success path is observable. The denied path is
      // exercised below without it.
      const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
      const page = await context.newPage();
      page.on("pageerror", (error) => { failures.push(`${engine}: uncaught page error ${error.message}`); });
      await page.goto(`http://127.0.0.1:${PORT}/guests/minimal/host/index.html?engine=${engine}`);
      try {
        await page.waitForFunction("document.querySelector('[data-text=status]')?.textContent === 'ready'", undefined, { timeout: 60000 });
        await waitForLog(page, /^ready$/);
        for (const check of checks) {
          if (check.button === "back") await page.goBack();
          else await page.click(`button[data-event="${check.button}"]`);
          try {
            await waitForLog(page, check.expect);
            results.push(`PASS  ${engine}: ${check.expect.source}`);
          } catch {
            failures.push(`${engine}: expected a log entry matching ${check.expect} — log was:\n${await logText(page)}`);
          }
        }
        const handshake = await page.evaluate<string>("JSON.stringify(window.limenDiagnostics.find((event) => event.kind === 'Handshake'))");
        if (!handshake.includes('"Negotiated"')) failures.push(`${engine}: handshake was not negotiated: ${handshake}`);
        else results.push(`PASS  ${engine}: contract fingerprint handshake negotiated (requireHandshake)`);
        const pushes = await page.evaluate<number>("window.limenDiagnostics.filter((event) => event.kind === 'BridgeError').length");
        if (pushes !== 0) failures.push(`${engine}: ${pushes} bridge error(s)`);
      } catch (error) {
        failures.push(`${engine}: did not start — ${String(error)}`);
      }
      await context.close();

      const denied = await browser.newContext();
      const deniedPage = await denied.newPage();
      await deniedPage.goto(`http://127.0.0.1:${PORT}/guests/minimal/host/index.html?engine=${engine}`);
      await deniedPage.waitForFunction("document.querySelector('[data-text=status]')?.textContent === 'ready'", undefined, { timeout: 60000 });
      await deniedPage.click('button[data-event="clipboard"]');
      try {
        await waitForLog(deniedPage, /^clipboard: failure (denied|unavailable)$/);
        results.push(`PASS  ${engine}: clipboard without permission is a typed failure`);
      } catch {
        failures.push(`${engine}: clipboard without permission — log was:\n${await logText(deniedPage)}`);
      }
      await denied.close();
    }
  } finally {
    await browser.close();
  }
  console.log(results.join("\n"));
}

server.kill();
if (failures.length > 0) {
  console.error(`\n${failures.length} guest-engine browser check(s) failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else if (chromium !== undefined) {
  console.log(`\n${results.length}/${results.length} guest-engine browser checks passed.`);
}
