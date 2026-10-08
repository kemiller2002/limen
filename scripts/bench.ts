// Reproducible performance baseline (kemiller2002/limen#19, LCP-004/LCP-033).
//
//   npm run bench                              run everything, write bench/results/latest.json
//   npm run bench -- --out bench/results/x.json   write elsewhere (a committed baseline)
//   npm run bench -- --compare bench/results/baseline.json [--tolerance 2]
//                                              also compare medians; exit 1 past the tolerance
//   npm run bench -- --runs 5 --only list-10k  more runs, fewer scenarios
//
// Four parts, each recorded with the machine, browser and runtime it ran on:
//   1. bench/pages scenarios in real Chromium, direct and through the JSON
//      boundary every WebAssembly transport pays;
//   2. the F#, C# and Rust minimal guests (dist-guests/, from `npm run
//      build:guests`) — download, cold and warm start to a verified handshake,
//      and an event → effect → projection round trip — through one host;
//   3. payload size per consumer profile (bench/budgets.json);
//   4. the store pack's LCP-078 rows (bench/pages/store/) through the kernel
//      and the JSON boundary, in Chromium and WebKit, each p95 against its
//      measured budget in bench/budgets.json (`--only store`); a miss exits 1.
//
// Timings are recorded, not enforced in CI: shared runners are too noisy for a
// timing gate to mean anything. Sizes are enforced by test/bench-size.test.ts.
// Needs Playwright; without it the browser parts are skipped and said so.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { cpus, platform, release, totalmem } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { measureProfile, readBudgets } from "../bench/size.ts";

type Page = {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, options?: { timeout: number }): Promise<unknown>;
  evaluate<T>(fn: string): Promise<T>;
  addInitScript(script: { content: string }): Promise<void>;
  on(event: "pageerror", handler: (error: Error) => void): void;
};
type Context = { newPage(): Promise<Page>; close(): Promise<void> };
type Browser = { newContext(): Promise<Context>; close(): Promise<void>; version(): string };
type Chromium = { launch(): Promise<Browser> };

type Summary = { readonly n: number; readonly median: number; readonly p95: number; readonly min: number; readonly max: number };
type Metrics = Readonly<Record<string, Summary | number | string>>;

const ROOT = process.cwd();
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const RUNS = Number(argument("runs") ?? "3");
const ONLY = argument("only");
const OUT = argument("out") ?? "bench/results/latest.json";
const COMPARE = argument("compare");
const TOLERANCE = Number(argument("tolerance") ?? "2");

const PAGE_PORT = 4190;
// WebKit refuses 4190 as a restricted network port (it is ManageSieve's), so
// the store pages, which run in WebKit too, are served on their own port.
const STORE_PORT = 4197;
const GUEST_PORT = 4191;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".css": "text/css",
};

// A static server that makes the page cross-origin isolated (COOP + COEP), so
// Chromium's performance.now() resolves to 5µs rather than a coarsened 100µs.
// Everything the pages load is same-origin, so isolation changes nothing else.
const serve = (directory: string, port: number): Promise<Server> => {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    const file = join(directory, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(directory)) { response.writeHead(403).end(); return; }
    readFile(file).then(
      (body) => {
        response.writeHead(200, {
          "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
          "Cross-Origin-Opener-Policy": "same-origin",
          "Cross-Origin-Embedder-Policy": "require-corp",
          "Cache-Control": "max-age=3600",
        }).end(body);
      },
      () => { response.writeHead(404).end(); },
    );
  });
  return new Promise((resolve) => { server.listen(port, "127.0.0.1", () => resolve(server)); });
};

const isSummary = (value: unknown): value is Summary => typeof value === "object" && value !== null && "median" in value;
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? Number.NaN;
};

// Across runs: each timing keeps the median of the per-run medians and the
// worst p95; a count keeps the median. The raw runs are recorded too.
const combine = (runs: readonly Metrics[]): Metrics => {
  const keys = Array.from(new Set(runs.flatMap((run) => Object.keys(run))));
  return Object.fromEntries(keys.map((key) => {
    const values = runs.map((run) => run[key]).filter((value) => value !== undefined);
    const summaries = values.filter(isSummary);
    if (summaries.length === values.length && summaries.length > 0) {
      return [key, { n: summaries.reduce((sum, value) => sum + value.n, 0), median: median(summaries.map((value) => value.median)), p95: Math.max(...summaries.map((value) => value.p95)), min: Math.min(...summaries.map((value) => value.min)), max: Math.max(...summaries.map((value) => value.max)) }];
    }
    const numbers = values.filter((value): value is number => typeof value === "number");
    return [key, numbers.length === values.length ? median(numbers) : String(values[0])];
  }));
};

const chromium = await (async (): Promise<Chromium | undefined> => {
  try {
    return (await import("playwright") as { chromium: Chromium }).chromium;
  } catch {
    return undefined;
  }
})();

const git = (...args: readonly string[]): string => {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
};

const packageVersion = async (name: string): Promise<string> => {
  try {
    const resolved = import.meta.resolve(`${name}/package.json`);
    return (JSON.parse(await readFile(new URL(resolved), "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
};

// ---------------------------------------------------------------------------
// 1. Page scenarios
// ---------------------------------------------------------------------------

const PAGE_SCENARIOS: readonly { readonly scenario: string; readonly boundaries: readonly ("direct" | "json")[] }[] = [
  { scenario: "startup", boundaries: ["direct", "json"] },
  { scenario: "event", boundaries: ["direct", "json"] },
  { scenario: "forms-100", boundaries: ["direct", "json"] },
  { scenario: "list-1k", boundaries: ["direct", "json"] },
  { scenario: "list-10k", boundaries: ["direct", "json"] },
  { scenario: "routes", boundaries: ["direct", "json"] },
  { scenario: "serialization", boundaries: ["direct"] },
  { scenario: "federation", boundaries: ["direct"] },
];

const runScenario = async (browser: Browser, scenario: string, boundary: string): Promise<Metrics> => {
  // A fresh context per run: no cache, no state from an earlier scenario.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message); });
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/bench/pages/index.html?scenario=${scenario}&boundary=${boundary}`);
    await page.waitForFunction("window.limenBench !== undefined && ('result' in window.limenBench || 'error' in window.limenBench)", undefined, { timeout: 600000 });
    const outcome = await page.evaluate<{ result?: Metrics; error?: string }>("window.limenBench");
    if (outcome.result === undefined) throw new Error(`${scenario}/${boundary}: ${outcome.error ?? "no result"} ${errors.join("; ")}`);
    if (scenario !== "startup") return outcome.result;
    // Warm start: the same context reloads with its HTTP cache populated.
    await page.reload();
    await page.waitForFunction("window.limenBench !== undefined && 'result' in window.limenBench", undefined, { timeout: 60000 });
    const warm = await page.evaluate<{ result: Metrics }>("window.limenBench");
    return Object.fromEntries([
      ...Object.entries(outcome.result).map(([key, value]) => [`cold.${key}`, value]),
      ...Object.entries(warm.result).map(([key, value]) => [`warm.${key}`, value]),
    ]);
  } finally {
    await context.close();
  }
};

const pageScenarios = async (browser: Browser): Promise<Readonly<Record<string, { readonly summary: Metrics; readonly runs: readonly Metrics[] }>>> => {
  const selected = PAGE_SCENARIOS.filter(({ scenario }) => ONLY === undefined || ONLY.split(",").includes(scenario));
  const jobs = selected.flatMap(({ scenario, boundaries }) => boundaries.map((boundary) => ({ scenario, boundary })));
  const results = await jobs.reduce<Promise<readonly (readonly [string, { summary: Metrics; runs: readonly Metrics[] }])[]>>(async (done, { scenario, boundary }) => {
    const previous = await done;
    const runs = await Array.from({ length: RUNS }).reduce<Promise<readonly Metrics[]>>(async (collected) => [...(await collected), await runScenario(browser, scenario, boundary)], Promise.resolve([]));
    console.log(`  ${scenario} (${boundary}): ${RUNS} run(s)`);
    return [...previous, [`${scenario}@${boundary}`, { summary: combine(runs), runs }]];
  }, Promise.resolve([]));
  return Object.fromEntries(results);
};

// ---------------------------------------------------------------------------
// 2. Guest engines
// ---------------------------------------------------------------------------

// Stamps the moment the kernel reports its handshake verdict, without touching
// the guest host page: window.limenDiagnostics is intercepted as it is set.
const STAMP_HANDSHAKE = `
  Object.defineProperty(window, "limenDiagnostics", {
    configurable: true,
    get() { return undefined; },
    set(list) {
      const push = list.push.bind(list);
      list.push = (...events) => {
        for (const event of events) if (event.kind === "Handshake") window.__limenHandshakeAt = performance.now();
        return push(...events);
      };
      Object.defineProperty(window, "limenDiagnostics", { value: list, writable: true, configurable: true });
    },
  });`;

const RESOURCES = `(() => {
  const entries = performance.getEntriesByType("resource");
  const sum = (list, field) => list.reduce((total, entry) => total + (entry[field] || 0), 0);
  const wasm = entries.filter((entry) => /\\.wasm($|\\?)/.test(entry.name));
  return { requests: entries.length, encodedBytes: sum(entries, "encodedBodySize"), transferredBytes: sum(entries, "transferSize"), wasmBytes: sum(wasm, "encodedBodySize") };
})()`;

// Event → engine → Storage effect → result → engine → projection, timed to
// the new log row the engine projects.
const ROUND_TRIP = `(async () => {
  const button = document.querySelector('button[data-event="storage-set"]');
  const list = document.querySelector("ol");
  const once = () => new Promise((resolve) => {
    const started = performance.now();
    const observer = new MutationObserver((records) => {
      if (records.some((record) => Array.from(record.addedNodes).some((node) => node.nodeName === "LI"))) { observer.disconnect(); resolve(performance.now() - started); }
    });
    observer.observe(list, { childList: true, subtree: true });
    button.click();
  });
  const samples = [];
  for (let index = 0; index < 60; index += 1) samples.push(await once());
  return samples.slice(10);
})()`;

const summarize = (samples: readonly number[]): Summary => {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => Math.round((sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN) * 1000) / 1000;
  return { n: sorted.length, median: at(0.5), p95: at(0.95), min: at(0), max: at(1) };
};

const guestRun = async (browser: Browser, engine: string): Promise<Metrics> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript({ content: STAMP_HANDSHAKE });
    const load = async (): Promise<Metrics> => {
      await page.waitForFunction("document.querySelector('[data-text=status]')?.textContent === 'ready' && window.__limenHandshakeAt !== undefined", undefined, { timeout: 120000 });
      const handshakeMs = await page.evaluate<number>("window.__limenHandshakeAt");
      const resources = await page.evaluate<Readonly<Record<string, number>>>(RESOURCES);
      return { handshakeMs: Math.round(handshakeMs * 1000) / 1000, ...resources };
    };
    await page.goto(`http://127.0.0.1:${GUEST_PORT}/guests/minimal/host/index.html?engine=${engine}`);
    const cold = await load();
    const roundTrip = summarize(await page.evaluate<readonly number[]>(ROUND_TRIP));
    await page.reload();
    const warm = await load();
    return Object.fromEntries([
      ...Object.entries(cold).map(([key, value]) => [`cold.${key}`, value]),
      ...Object.entries(warm).map(([key, value]) => [`warm.${key}`, value]),
      ["eventEffectRoundTripMs", roundTrip],
    ]);
  } finally {
    await context.close();
  }
};

const guests = async (browser: Browser): Promise<Readonly<Record<string, unknown>>> => {
  if (!existsSync(join(ROOT, "dist-guests/guests/minimal/host/index.html"))) return { skipped: "dist-guests/ is not built; run npm run build:guests (needs .NET SDK 8 and cargo)" };
  const server = await serve(join(ROOT, "dist-guests"), GUEST_PORT);
  try {
    const engines = ["fsharp", "csharp", "rust"].filter((engine) => ONLY === undefined || ONLY.split(",").includes("guests") || ONLY.split(",").includes(engine));
    const results = await engines.reduce<Promise<readonly (readonly [string, unknown])[]>>(async (done, engine) => {
      const previous = await done;
      const runs = await Array.from({ length: RUNS }).reduce<Promise<readonly Metrics[]>>(async (collected) => [...(await collected), await guestRun(browser, engine)], Promise.resolve([]));
      console.log(`  guest ${engine}: ${RUNS} run(s)`);
      return [...previous, [engine, { summary: combine(runs), runs }]];
    }, Promise.resolve([]));
    return Object.fromEntries(results);
  } finally {
    server.close();
  }
};

// ---------------------------------------------------------------------------
// 3. The store pack (LCP-078), in Chromium and WebKit
// ---------------------------------------------------------------------------

type StoreBudgets = { readonly doc: string; readonly rows: Readonly<Record<string, { readonly p95Ms: number }>> };
// --engines chromium,webkit (the default) narrows a local run; the budget
// check still names every engine that did not run.
const ALL_STORE_ENGINES = ["chromium", "webkit"] as const;
const STORE_ENGINES = ALL_STORE_ENGINES;
const RUN_ENGINES = (argument("engines") ?? "chromium,webkit").split(",");

const storeRun = async (browser: Browser): Promise<Metrics> => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => { errors.push(error.message); });
    if (process.env.LIMEN_BENCH_DEBUG === "1") (page as unknown as { on(event: string, handler: (message: { text(): string }) => void): void }).on("console", (message) => { console.log(`    page: ${message.text()}`); });
    await page.goto(`http://127.0.0.1:${STORE_PORT}/bench/pages/store/index.html`);
    // Polled with evaluate: Playwright's waitForFunction never resolved in
    // WebKit here (measured), while the page itself had finished.
    const deadline = Date.now() + 600000;
    const poll = async (): Promise<{ result?: Metrics; error?: string } | undefined> => {
      const value = await page.evaluate<{ result?: Metrics; error?: string } | null>("window.limenBench ?? null");
      if (value !== null) return value;
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      return poll();
    };
    const outcome = await poll() ?? { error: "timed out after 600 s" };
    if (outcome.result === undefined) throw new Error(`store: ${outcome.error ?? "no result"} ${errors.join("; ")}`);
    return outcome.result;
  } finally {
    await context.close();
  }
};

const storeBench = async (): Promise<Readonly<Record<string, unknown>>> => {
  const engines = await (async (): Promise<Record<string, Chromium> | undefined> => {
    try { return await import("playwright") as Record<string, Chromium>; } catch { return undefined; }
  })();
  if (engines === undefined) return { skipped: "Playwright is not installed" };
  const server = await serve(ROOT, STORE_PORT);
  try {
  const results = await STORE_ENGINES.filter((engine) => RUN_ENGINES.includes(engine)).reduce<Promise<readonly (readonly [string, unknown])[]>>(async (done, engine) => {
    const previous = await done;
    const browser = await engines[engine]?.launch().catch((error: unknown) => (error instanceof Error ? error.message.split("\n")[0] ?? "launch failed" : "launch failed"));
    if (browser === undefined || typeof browser === "string") return [...previous, [engine, { unavailable: browser ?? "not in this Playwright" }]];
    try {
      const runs = await Array.from({ length: RUNS }).reduce<Promise<readonly Metrics[]>>(async (collected) => [...(await collected), await storeRun(browser)], Promise.resolve([]));
      console.log(`  store (${engine} ${browser.version()}): ${RUNS} run(s)`);
      return [...previous, [engine, { browser: `${engine} ${browser.version()}`, summary: combine(runs), runs }]];
    } finally {
      await browser.close();
    }
  }, Promise.resolve([]));
  return Object.fromEntries(results);
  } finally {
    server.close();
  }
};

// Every measured p95 against its budget; an engine that did not run is
// reported, never counted as within budget.
const storeMisses = (budgets: StoreBudgets | undefined, store: Readonly<Record<string, unknown>>): readonly string[] => {
  if (budgets === undefined) return ["bench/budgets.json has no store budgets"];
  return STORE_ENGINES.flatMap((engine) => {
    const entry = store[engine] as { summary?: Metrics; unavailable?: string } | undefined;
    if (entry?.summary === undefined) return [`store in ${engine} did not run: ${entry?.unavailable ?? "no result"}`];
    const summary = entry.summary;
    return Object.entries(budgets.rows).flatMap(([row, budget]) => {
      const measured = summary[row];
      if (!isSummary(measured)) return [`store ${row} in ${engine}: not measured`];
      return measured.p95 > budget.p95Ms ? [`store ${row} in ${engine}: p95 ${measured.p95}ms over its budget of ${budget.p95Ms}ms`] : [];
    });
  });
};

// ---------------------------------------------------------------------------
// 4. Sizes, then the record
// ---------------------------------------------------------------------------

const sizes = async (): Promise<readonly unknown[]> => {
  const budgets = await readBudgets(ROOT);
  return Promise.all(budgets.profiles.map(async (profile) => ({ ...(await measureProfile(ROOT, profile)), budget: profile.budget })));
};

const comparison = (baseline: Readonly<Record<string, { summary: Metrics }>>, current: Readonly<Record<string, { summary: Metrics }>>): readonly string[] =>
  Object.entries(current).flatMap(([name, { summary }]) => Object.entries(summary).flatMap(([key, value]) => {
    const before = baseline[name]?.summary[key];
    if (!isSummary(value) || !isSummary(before) || before.median <= 0) return [];
    const ratio = value.median / before.median;
    return ratio > TOLERANCE ? [`${name} ${key}: median ${value.median}ms vs baseline ${before.median}ms (${ratio.toFixed(2)}x > ${TOLERANCE}x)`] : [];
  }));

const main = async (): Promise<void> => {
  const environment = {
    recordedAt: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    os: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    playwright: await packageVersion("playwright"),
    runsPerScenario: RUNS,
  };
  const measuredSizes = await sizes();
  if (chromium === undefined) {
    console.log("Playwright is not installed: browser timings skipped; sizes only.");
  }
  const browser = chromium === undefined ? undefined : await chromium.launch();
  const server = await serve(ROOT, PAGE_PORT);
  try {
    console.log("Page scenarios:");
    const scenarios = browser === undefined ? {} : await pageScenarios(browser);
    console.log("Guest engines:");
    const guestResults = browser === undefined || (ONLY !== undefined && !ONLY.split(",").some((name) => ["guests", "fsharp", "csharp", "rust"].includes(name))) ? {} : await guests(browser);
    const runStore = ONLY === undefined || ONLY.split(",").includes("store");
    console.log("Store pack:");
    const store = runStore ? await storeBench() : {};
    const record = { environment: { ...environment, browser: browser === undefined ? "none" : `chromium ${browser.version()}` }, sizes: measuredSizes, scenarios, guests: guestResults, store };
    await mkdir(dirname(join(ROOT, OUT)), { recursive: true });
    await writeFile(join(ROOT, OUT), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Recorded ${OUT}`);
    if (runStore) {
      const budgets = (await readBudgets(ROOT) as unknown as { store?: StoreBudgets }).store;
      const misses = storeMisses(budgets, store);
      if (misses.length > 0) {
        console.error(`Store budgets (LCP-078):\n${misses.join("\n")}`);
        process.exitCode = 1;
      } else {
        console.log(`Every store row is within its p95 budget in ${STORE_ENGINES.join(" and ")}.`);
      }
    }
    if (COMPARE !== undefined) {
      const baseline = JSON.parse(await readFile(join(ROOT, COMPARE), "utf8")) as { scenarios: Readonly<Record<string, { summary: Metrics }>> };
      const regressions = comparison(baseline.scenarios, scenarios);
      if (regressions.length > 0) {
        console.error(`Slower than ${COMPARE} by more than ${TOLERANCE}x:\n${regressions.join("\n")}`);
        process.exitCode = 1;
      } else {
        console.log(`No median more than ${TOLERANCE}x slower than ${COMPARE}.`);
      }
    }
  } finally {
    server.close();
    await browser?.close();
  }
};

await main();
