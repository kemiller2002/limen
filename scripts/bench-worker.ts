// Worker-hosting measurements (kemiller2002/limen#41, LCP-035), with the
// methodology of scripts/bench.ts (#19): real Chromium, medians over repeated
// runs, and the machine, browser and runtime recorded with the numbers.
//
//   npm run bench:worker                      write bench/results/worker-hosting.json
//   npm run bench:worker -- --runs 7          more runs
//
// Four measurements, each in the page and in a dedicated worker:
//   1. startup — navigation to a verified handshake, for the F#, C# and Rust
//      minimal engines (dist-guests/, from `npm run build:guests`), cold;
//   2. round trip — one small event dispatched and its projection decoded,
//      for the same three engines;
//   3. large messages — a synthetic engine answering with views of 1 KB to
//      about 4 MB, so serialization and the worker hop are measured by size,
//      with how long the main thread itself was blocked;
//   4. responsiveness — the longest the main thread goes without running a
//      10 ms ticker while the synthetic engine spends 300 ms on one event.
//
// Timings are recorded, not enforced: they depend on the machine. The
// recommendation in docs/50 is drawn from them.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, extname, join, normalize, resolve } from "node:path";

type Page = { goto(url: string): Promise<unknown>; waitForFunction(fn: string, arg?: unknown, options?: { timeout: number }): Promise<unknown>; evaluate<T>(fn: string): Promise<T> };
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };
type Chromium = { launch(): Promise<Browser> };

const ROOT = process.cwd();
const PORT = 4196;
const argument = (name: string): string | undefined => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; };
const RUNS = Number(argument("--runs") ?? 5);
const OUT = argument("--out") ?? "bench/results/worker-hosting.json";

const CONTENT_TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".dat": "application/octet-stream", ".css": "text/css" };

const serve = (): Promise<Server> => new Promise((resolve) => {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    // The minimal engines ask for root-relative /ok.json.
    const file = path === "/ok.json" ? join(ROOT, "dist-guests/ok.json") : join(ROOT, path);
    if (!file.startsWith(ROOT)) { response.writeHead(403).end(); return; }
    readFile(file).then((body) => { response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" }).end(body); }, () => { response.writeHead(404).end(); });
  });
  server.listen(PORT, "127.0.0.1", () => resolve(server));
});

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return Math.round((sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : sorted[middle] ?? 0) * 100) / 100;
};

const repeat = async <T>(times: number, each: (run: number) => Promise<T>): Promise<readonly T[]> =>
  Array.from({ length: times }).reduce<Promise<readonly T[]>>(async (done, _, run) => [...(await done), await each(run)], Promise.resolve([]));

const HOSTS = ["page", "worker"] as const;
const ENGINES = ["fsharp", "csharp", "rust"] as const;

// A fresh context per run: nothing cached, as a first visit.
const fresh = async <T>(browser: Browser, url: string, ready: string, measure: (page: Page) => Promise<T>): Promise<T> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/${url}`);
    await page.waitForFunction(ready, undefined, { timeout: 60000 });
    return await measure(page);
  } finally {
    await context.close();
  }
};

const guestUrl = (engine: string, host: string): string => `dist-guests/guests/minimal/host/index.html?engine=${engine}${host === "worker" ? "&host=worker" : ""}`;
const GUEST_READY = "performance.getEntriesByName('limen-ready').length > 0";
const SYNTHETIC_READY = "window.benchReady === true";

const startupOf = (browser: Browser, engine: string, host: string): Promise<readonly number[]> =>
  repeat(RUNS, () => fresh(browser, guestUrl(engine, host), GUEST_READY, (page) => page.evaluate<number>("performance.getEntriesByName('limen-ready')[0].startTime")));

const startup = (browser: Browser) => repeatEach(ENGINES, (engine) => repeatEach(HOSTS, async (host) => ({ engine, host, medianMs: median(await startupOf(browser, engine, host)) })));

// A small event through the transport alone, 100 times after 10 to warm up.
const ROUND_TRIP = `(async () => {
  const send = () => window.limenTransport.dispatch({ kind: "Event", event: { kind: "Event", name: "bench-noop" } });
  for (let i = 0; i < 10; i += 1) await send();
  const times = [];
  for (let i = 0; i < 100; i += 1) { const at = performance.now(); await send(); times.push(performance.now() - at); }
  times.sort((a, b) => a - b);
  return times[50];
})()`;

const roundTripOf = (browser: Browser, engine: string, host: string): Promise<readonly number[]> =>
  repeat(RUNS, () => fresh(browser, guestUrl(engine, host), GUEST_READY, (page) => page.evaluate<number>(ROUND_TRIP)));

const roundTrip = (browser: Browser) => repeatEach(ENGINES, (engine) => repeatEach(HOSTS, async (host) => ({ engine, host, medianMs: median(await roundTripOf(browser, engine, host)) })));

const ROWS = [10, 1000, 10000, 50000] as const;
const payload = (rows: number): string => `(async () => {
  const send = () => window.benchTransport.dispatch({ kind: "Event", event: { kind: "Event", name: "payload", value: "${rows}" } });
  await send();
  const times = [];
  const gaps = [];
  let bytes = 0;
  for (let i = 0; i < 9; i += 1) {
    let last = performance.now();
    let longest = 0;
    const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
    const at = performance.now();
    const reply = await send();
    times.push(performance.now() - at);
    await new Promise((resolve) => setTimeout(resolve, 10));
    clearInterval(ticker);
    gaps.push(longest);
    bytes = JSON.stringify(reply).length;
  }
  times.sort((a, b) => a - b);
  gaps.sort((a, b) => a - b);
  return { ms: times[4], gap: gaps[4], bytes };
})()`;

const largeMessages = (browser: Browser) => repeatEach(ROWS, (rows) => repeatEach(HOSTS, async (host) => {
  const results = await repeat(RUNS, () => fresh(browser, `bench/pages/worker/index.html?host=${host}`, SYNTHETIC_READY, (page) => page.evaluate<{ ms: number; gap: number; bytes: number }>(payload(rows))));
  // medianMs is the whole round trip; longestMainThreadGapMs is how long the
  // page itself could not run anything (5 ms ticker) during it.
  return { rows, bytes: results[0]?.bytes ?? 0, host, medianMs: median(results.map((result) => result.ms)), longestMainThreadGapMs: median(results.map((result) => result.gap)) };
}));

// The main thread's longest gap between 10 ms ticks while the engine spends
// 300 ms on one event.
const RESPONSIVENESS = `(async () => {
  let last = performance.now();
  let longest = 0;
  const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 10);
  const at = performance.now();
  await window.benchTransport.dispatch({ kind: "Event", event: { kind: "Event", name: "work", value: "300" } });
  const took = performance.now() - at;
  await new Promise((resolve) => setTimeout(resolve, 30));
  clearInterval(ticker);
  return { longestGapMs: longest, dispatchMs: took };
})()`;

const responsiveness = (browser: Browser) => repeatEach(HOSTS, async (host) => {
  const results = await repeat(RUNS, () => fresh(browser, `bench/pages/worker/index.html?host=${host}`, SYNTHETIC_READY, (page) => page.evaluate<{ longestGapMs: number; dispatchMs: number }>(RESPONSIVENESS)));
  return { host, longestMainThreadGapMs: median(results.map((result) => result.longestGapMs)), dispatchMs: median(results.map((result) => result.dispatchMs)) };
});

function repeatEach<T, R>(items: readonly T[], each: (item: T) => Promise<R | readonly R[]>): Promise<readonly R[]> {
  return items.reduce<Promise<readonly R[]>>(async (done, item) => [...(await done), ...[await each(item)].flat() as R[]], Promise.resolve([]));
}

const chromium = await (async (): Promise<Chromium | undefined> => {
  try {
    return (await import("playwright") as { chromium: Chromium }).chromium;
  } catch {
    return undefined;
  }
})();

if (chromium === undefined) {
  console.log("Playwright is not installed, so the worker-hosting measurements were skipped.");
} else {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const record = {
      doc: "Worker-hosting measurements (kemiller2002/limen#41): medians over the stated runs; startup and round trip for the F#, C# and Rust minimal engines, large messages and main-thread responsiveness for a synthetic engine behind the same boundary. docs/50-worker-hosting.md draws the recommendation from these numbers.",
      environment: { date: new Date().toISOString(), platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), node: process.version, browser: `chromium ${browser.version()}`, runs: RUNS },
      startup: await startup(browser),
      roundTrip: await roundTrip(browser),
      largeMessages: await largeMessages(browser),
      responsiveness: await responsiveness(browser),
    };
    await mkdir(dirname(resolve(ROOT, OUT)), { recursive: true });
    await writeFile(resolve(ROOT, OUT), `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify(record, null, 2));
    console.log(`\nWritten to ${OUT}.`);
  } finally {
    await browser.close();
    server.close();
  }
}
