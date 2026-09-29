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
import { serveHttp } from "../test/browser/servers/http.ts";
import { serveOffline } from "../test/browser/servers/offline.ts";
import { serveRealtime, upgradeRealtime } from "../test/browser/servers/realtime.ts";

type Page = {
  goto(url: string): Promise<unknown>;
  goBack(options: { waitUntil: "commit" }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  addInitScript(script: { content: string }): Promise<void>;
  on(event: "pageerror", handler: (error: { message?: string }) => void): void;
  on(event: "download", handler: (download: Download) => void): void;
  click(selector: string, options?: { force?: boolean; timeout?: number }): Promise<void>;
  reload(): Promise<unknown>;
  setInputFiles(selector: string, files: readonly { name: string; mimeType: string; buffer: Buffer }[]): Promise<void>;
  focus(selector: string): Promise<void>;
  dragAndDrop(source: string, target: string): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void> };
};
type Download = { suggestedFilename(): string; path(): Promise<string | null> };
type CdpSession = { send(method: string, params: Record<string, unknown>): Promise<unknown> };
type Context = { newPage(): Promise<Page>; close(): Promise<void>; newCDPSession(page: Page): Promise<CdpSession>; setOffline(offline: boolean): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void> };
type Chromium = { launch(options?: { channel?: string; ignoreDefaultArgs?: readonly string[] }): Promise<Browser> };
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

// A page whose host creates Trusted Types policies names them in page.json
// (service-worker registration is a Trusted Types sink, so no policy means no
// worker). Only those names are allowed, and only for that page's folder.
const policyFor = (trustedTypes: ReadonlyMap<string, readonly string[]>, path: string): string => {
  const names = [...trustedTypes].find(([pack]) => path.startsWith(`/${PACKS}/${pack}/`))?.[1];
  return names === undefined ? POLICY : POLICY.replace("trusted-types 'none'", `trusted-types ${names.join(" ")}`);
};

const serve = (trustedTypes: ReadonlyMap<string, readonly string[]>): Promise<Server> => {
  const server = createServer((request, response) => {
    // Same-origin test endpoints a pack page may need (realtime, HTTP, offline); not files.
    if (serveRealtime(request, response) || serveHttp(request, response) || serveOffline(request, response)) return;
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    const file = join(ROOT, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(ROOT)) { response.writeHead(403).end(); return; }
    readFile(file).then(
      (body) => { response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "Content-Security-Policy": policyFor(trustedTypes, path) }).end(body); },
      () => { response.writeHead(404).end(); },
    );
  });
  server.on("upgrade", (request, socket) => { if (!upgradeRealtime(request, socket)) socket.destroy(); });
  return new Promise((resolve) => { server.listen(PORT, "127.0.0.1", () => resolve(server)); });
};

const RECORD_VIOLATIONS = `
  window.__limenViolations = [];
  document.addEventListener("securitypolicyviolation", (event) => {
    window.__limenViolations.push(event.violatedDirective + " " + (event.blockedURI || "") + " " + (event.sample || ""));
  });`;


// page.evaluate goes through the DevTools protocol, which the page's policy
// does not govern; Playwright's string waitForFunction would use in-page eval
// and trip Trusted Types itself. So the runner polls with page.evaluate.
//
// Some facts exist only for trusted input: a real key press, a pointer drag, a
// native drag and drop, IME composition, a trusted click (user activation),
// files chosen in a file input, a reload, the network going away, a trip
// through the back/forward cache. A page
// asks for one by setting window.__limenPackAction; the runner performs it
// with Playwright's real input (IME through the DevTools protocol)
// and calls window.__limenPackActionDone().
type Action =
  | { readonly kind: "press"; readonly selector: string; readonly key: string }
  | { readonly kind: "drag"; readonly from: readonly [number, number]; readonly to: readonly [number, number]; readonly steps: number }
  | { readonly kind: "dragAndDrop"; readonly source: string; readonly target: string }
  | { readonly kind: "compose"; readonly selector: string; readonly steps: readonly string[]; readonly commit: string }
  // force: dispatch a real mouse click at the element's position even if the
  // browser says something else would receive it (an inert page, a cover).
  | { readonly kind: "click"; readonly selector: string; readonly force?: boolean }
  | { readonly kind: "reload" }
  // The browser's network: offline or online (real online/offline events), or
  // emulated conditions (which change the Network Information API's estimate).
  | { readonly kind: "offline"; readonly offline: boolean }
  | { readonly kind: "network"; readonly latencyMs: number; readonly downloadBytesPerSecond: number; readonly connectionType: string }
  // Navigate to url, then back without waiting for load: a page restored from
  // the back/forward cache never fires load again. Needs a pack that asked for
  // the cache (page.json: { "backForwardCache": true }).
  | { readonly kind: "backForward"; readonly url: string }
  | { readonly kind: "setFiles"; readonly selector: string; readonly files: readonly { readonly name: string; readonly mimeType: string; readonly base64?: string; readonly size?: number }[] };

// A file for setFiles: given bytes, or `size` bytes of the repeating pattern
// index % 251, which a page can verify without the runner sending it.
const fileBuffer = (file: { readonly base64?: string; readonly size?: number }): Buffer =>
  file.base64 !== undefined ? Buffer.from(file.base64, "base64") : Buffer.from(Uint8Array.from({ length: file.size ?? 0 }, (_, index) => index % 251));

const perform = async (page: Page, context: Context, cdp: () => Promise<CdpSession>, action: Action): Promise<void> => {
  switch (action.kind) {
    case "press":
      await page.focus(action.selector);
      await page.keyboard.press(action.key);
      return;
    case "drag":
      await page.mouse.move(action.from[0], action.from[1]);
      await page.mouse.down();
      await page.mouse.move(action.to[0], action.to[1], { steps: action.steps });
      await page.mouse.up();
      return;
    case "dragAndDrop":
      await page.dragAndDrop(action.source, action.target);
      return;
    case "click":
      await page.click(action.selector, { force: action.force === true, timeout: 5000 });
      return;
    case "reload":
      await page.reload();
      return;
    case "offline":
      await context.setOffline(action.offline);
      return;
    case "network": {
      const session = await cdp();
      await session.send("Network.enable", {});
      await session.send("Network.emulateNetworkConditions", { offline: false, latency: action.latencyMs, downloadThroughput: action.downloadBytesPerSecond, uploadThroughput: action.downloadBytesPerSecond, connectionType: action.connectionType });
      return;
    }
    case "backForward":
      await page.goto(`http://127.0.0.1:${PORT}/${action.url}`);
      await page.goBack({ waitUntil: "commit" });
      return;
    case "setFiles":
      await page.setInputFiles(action.selector, action.files.map((file) => ({ name: file.name, mimeType: file.mimeType, buffer: fileBuffer(file) })));
      return;
    case "compose": {
      await page.focus(action.selector);
      const session = await cdp();
      for (const text of action.steps) await session.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
      await session.send("Input.insertText", { text: action.commit });
      return;
    }
  }
};

const drive = async (page: Page, context: Context, cdp: () => Promise<CdpSession>, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  const step = async (): Promise<boolean> => {
    if (await page.evaluate<boolean>("Boolean(window.__limenPackResult)").catch(() => false)) return true;
    const action = await page.evaluate<Action | null>("window.__limenPackAction ?? null").catch(() => null);
    if (action !== null) {
      await page.evaluate("window.__limenPackAction = null");
      // A failed action is reported to the page (which decides whether that
      // is a failed check), never allowed to end the run.
      const failure = await perform(page, context, cdp, action).then(() => null, (error: unknown) => (error instanceof Error ? error.name : "Error"));
      await page.evaluate(`window.__limenPackActionError = ${JSON.stringify(failure)}; window.__limenPackActionDone?.()`);
    } else {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    return step();
  };
  return step();
};

// What a pack directory's optional page.json may say.
type PageConfig = { readonly url?: string; readonly backForwardCache?: boolean; readonly trustedTypes?: readonly string[] };

const configOf = (pack: string): Promise<PageConfig> =>
  readFile(join(ROOT, PACKS, pack, "page.json"), "utf8").then((text): PageConfig => {
    const value: unknown = JSON.parse(text);
    const field = (name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);
    const url = field("url");
    const trustedTypes = field("trustedTypes");
    const names = Array.isArray(trustedTypes) ? trustedTypes.filter((name): name is string => typeof name === "string" && /^[A-Za-z0-9-]+$/.test(name)) : [];
    return { ...(typeof url === "string" ? { url } : {}), backForwardCache: field("backForwardCache") === true, ...(names.length > 0 ? { trustedTypes: names } : {}) };
  }, () => ({}));

const runPack = async (browser: Browser, pack: string, config: PageConfig): Promise<readonly string[]> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message ?? "page error"); });
    // A download the page starts is handed back to it as window.__limenDownloads.
    page.on("download", (download) => {
      void download.path().then(async (path) => {
        const text = path === null ? "" : await readFile(path, "utf8");
        await page.evaluate(`(window.__limenDownloads ??= []).push(${JSON.stringify({ name: download.suggestedFilename(), text })})`);
      });
    });
    await page.addInitScript({ content: RECORD_VIOLATIONS });
    // A pack directory may point at a page elsewhere in the repository (an
    // example that runs its own checks) with page.json: { "url": "…" }.
    await page.goto(`http://127.0.0.1:${PORT}/${config.url ?? `${PACKS}/${pack}/index.html`}`);
    const reported = await drive(page, context, () => context.newCDPSession(page), 30000);
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
  const configs = new Map(await Promise.all(packs.map(async (pack) => [pack, await configOf(pack)] as const)));
  const server = await serve(new Map([...configs].flatMap(([pack, config]) => (config.trustedTypes !== undefined ? [[pack, config.trustedTypes] as const] : []))));
  const browser = await chromium.launch();
  // Playwright's default Chromium is the headless shell with the back/forward
  // cache switched off. A pack that needs the cache gets full Chromium with the
  // switch left out — launched only if one asks.
  const cached: { browser?: Promise<Browser> } = {};
  const withCache = (): Promise<Browser> => (cached.browser ??= chromium.launch({ channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] }));
  try {
    const failures = await packs.reduce<Promise<readonly string[]>>(async (done, pack) => {
      const previous = await done;
      const config = configs.get(pack) ?? {};
      return [...previous, ...(await runPack(config.backForwardCache === true ? await withCache() : browser, pack, config))];
    }, Promise.resolve([]));
    if (failures.length > 0) {
      console.error(`\n${failures.length} capability pack check(s) failed:\n${failures.join("\n")}`);
      process.exitCode = 1;
    } else {
      console.log(`\nCapability packs passed in Chromium under a strict CSP with Trusted Types (${packs.join(", ")}).`);
    }
  } finally {
    await browser.close();
    await (await cached.browser)?.close();
    server.close();
  }
}
