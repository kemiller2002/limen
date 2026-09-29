// State-safe hot reload (kemiller2002/limen#36, LCP-030), against the issue's
// reference tests: a CSS-only update, an HTML template update, a compatible
// snapshot restore and an incompatible snapshot fallback — through the real
// kernel with a counter engine — plus the pure plan and the real dev server's
// change stream.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { createHotReloader, planReload, type HotEngine } from "../dist/tooling/hot-reload.js";
import type { BrowserToEngineMessage, EngineTransport } from "../dist/protocol.js";
import { startDevServer, kindOf } from "../scripts/dev-server.ts";
import { withDom } from "./dom-helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

test("the plan: CSS swaps, HTML remounts, an engine restores only on an exactly equal version, anything else reloads", () => {
  const facts = { stylesheets: ["/app.css"], currentVersion: "3", currentPage: "/index.html" };
  assert.deepEqual(planReload({ kind: "css", path: "/app.css" }, facts), { kind: "swapStylesheet", path: "/app.css" });
  assert.deepEqual(planReload({ kind: "css", path: "/other.css" }, facts), { kind: "fullReload", reason: "the page does not link this stylesheet" });
  assert.deepEqual(planReload({ kind: "html", path: "/index.html" }, facts), { kind: "remount" });
  assert.deepEqual(planReload({ kind: "html", path: "/about.html" }, facts), { kind: "fullReload", reason: "another page changed" });
  assert.deepEqual(planReload({ kind: "engine", path: "/engine.js" }, { ...facts, nextVersion: "3" }), { kind: "restoreEngine", version: "3" });
  assert.deepEqual(planReload({ kind: "engine", path: "/engine.js" }, { ...facts, nextVersion: "3.1" }), { kind: "resetEngine", reason: "incompatible" }, "3 and 3.1 are not guessed compatible");
  assert.deepEqual(planReload({ kind: "engine", path: "/engine.js" }, { ...facts, currentVersion: undefined, nextVersion: "3" }), { kind: "resetEngine", reason: "no-snapshot" });
  assert.deepEqual(planReload({ kind: "other", path: "/data.json" }, facts), { kind: "fullReload", reason: "not a stylesheet, page or engine" });
});

// A counter engine whose snapshot is its count; label shows which build runs.
const counterEngine = (version: string | undefined, label: string, created: string[]): HotEngine => ({
  snapshotVersion: version,
  create: (restored) => {
    created.push(`${label}:${JSON.stringify(restored ?? null)}`);
    const state = { count: typeof restored === "object" && restored !== null && "count" in restored && typeof restored.count === "number" ? restored.count : 0 };
    const view = () => ({ count: String(state.count), label });
    const transport: EngineTransport = {
      start: async () => {},
      dispatch: async (message: BrowserToEngineMessage) => {
        if (message.kind === "Event" && message.event.name === "add") state.count += 1;
        return { view: view(), effects: [], cancellations: [] };
      },
    };
    return { transport, snapshot: () => ({ count: state.count }) };
  },
});

const PAGE = `<link rel="stylesheet" href="/app.css"><h1 id="title">Counter</h1><p id="count" data-text="count"></p><p id="label" data-text="label"></p><button id="add" data-event="add">Add</button>`;

type Session = { readonly document: Document; readonly created: string[]; readonly reloads: number[]; readonly click: (times: number) => Promise<void>; readonly text: (id: string) => string | null | undefined };

const session = async (act: (session: Session, reloader: Awaited<ReturnType<typeof createHotReloader>>) => Promise<void>, engines: Readonly<Record<string, HotEngine>> = {}, version: string | undefined = "1"): Promise<void> => {
  await withDom(PAGE, async (document) => {
    const created: string[] = [];
    const reloads: number[] = [];
    const reloader = await createHotReloader({
      document,
      engine: counterEngine(version, "v1", created),
      kernel: (transport) => new BrowserKernel(transport, document),
      loadEngine: async (path) => {
        const engine = engines[path];
        assert.ok(engine !== undefined, `no engine at ${path}`);
        return engine;
      },
      loadPage: async () => {
        const view = document.defaultView;
        assert.ok(view !== null);
        const parsed = new view.DOMParser().parseFromString(`<body>${PAGE.replace("Counter", "Counter, edited")}</body>`, "text/html");
        return Array.from(parsed.body.childNodes);
      },
      reload: () => reloads.push(1),
      currentPage: "/index.html",
    });
    const click = async (times: number): Promise<void> => {
      for (const _ of Array.from({ length: times })) {
        document.getElementById("add")?.click();
        await sleep(0);
      }
      await sleep(5);
    };
    const text = (id: string) => document.getElementById(id)?.textContent;
    await act({ document, created, reloads, click, text }, reloader);
  });
};

test("CSS-only update: the stylesheet is swapped in place; the DOM, the kernel and the engine are untouched", async () => {
  await session(async ({ document, created, click, text }, reloader) => {
    await click(3);
    const title = document.getElementById("title");
    const applying = reloader.apply({ kind: "css", path: "/app.css" });
    await sleep(0);
    const links = Array.from(document.querySelectorAll("link"));
    assert.equal(links.length, 2, "the new stylesheet loads next to the old one");
    links[1]?.dispatchEvent(new (document.defaultView?.Event ?? Event)("load"));
    assert.deepEqual(await applying, { kind: "swapStylesheet", path: "/app.css" });
    assert.deepEqual(Array.from(document.querySelectorAll("link"), (link) => link.getAttribute("href")), ["http://localhost/app.css?limen-hot=1"]);
    assert.equal(document.getElementById("title"), title, "the same DOM nodes");
    assert.deepEqual(created, ["v1:null"], "no engine was created again");
    await click(1);
    assert.equal(text("count"), "4");
  });
});

test("HTML template update: the new page is mounted and the same engine continues from its own snapshot", async () => {
  await session(async ({ created, click, text }, reloader) => {
    await click(3);
    assert.deepEqual(await reloader.apply({ kind: "html", path: "/index.html" }), { kind: "remount" });
    assert.equal(text("title"), "Counter, edited");
    assert.equal(text("count"), "3", "state preserved across the new markup");
    await click(1);
    assert.equal(text("count"), "4", "one click, one increment: the old kernel is gone");
    assert.deepEqual(created, ["v1:null", "v1:{\"count\":3}"]);
  });
});

test("compatible engine replacement: the snapshot version matches exactly, so the new engine continues", async () => {
  const created: string[] = [];
  await session(async ({ click, text }, reloader) => {
    await click(2);
    assert.deepEqual(await reloader.apply({ kind: "engine", path: "/engine.js" }), { kind: "restoreEngine", version: "1" });
    assert.deepEqual([text("count"), text("label")], ["2", "v1-patched"]);
    assert.deepEqual(created, ["v1-patched:{\"count\":2}"]);
  }, { "/engine.js": counterEngine("1", "v1-patched", created) });
});

test("incompatible engine replacement: a different snapshot version resets instead of guessing", async () => {
  const created: string[] = [];
  await session(async ({ click, text }, reloader) => {
    await click(2);
    assert.deepEqual(await reloader.apply({ kind: "engine", path: "/engine.js" }), { kind: "resetEngine", reason: "incompatible" });
    assert.deepEqual([text("count"), text("label")], ["0", "v2"]);
    assert.deepEqual(created, ["v2:null"], "the old snapshot was never offered to the new engine");
  }, { "/engine.js": counterEngine("2", "v2", created) });
});

test("an engine without a snapshot version always resets; unknown changes reload the page", async () => {
  const created: string[] = [];
  await session(async ({ click, text, reloads }, reloader) => {
    await click(2);
    assert.deepEqual(await reloader.apply({ kind: "engine", path: "/engine.js" }), { kind: "resetEngine", reason: "no-snapshot" });
    assert.equal(text("count"), "0");
    assert.deepEqual(await reloader.apply({ kind: "other", path: "/data.json" }), { kind: "fullReload", reason: "not a stylesheet, page or engine" });
    assert.deepEqual(reloads, [1]);
  }, { "/engine.js": counterEngine(undefined, "v1b", created) }, undefined);
});

test("the dev server serves files and streams each change with its kind", async () => {
  assert.deepEqual(["/a.css", "/b.html", "/c.js", "/d.json"].map(kindOf), ["css", "html", "engine", "other"]);
  const root = await mkdtemp(join(tmpdir(), "limen-dev-"));
  await writeFile(join(root, "index.html"), "<p>hi</p>");
  const dev = await startDevServer(root, 4199);
  try {
    const page = await (await fetch("http://127.0.0.1:4199/")).text();
    assert.equal(page, "<p>hi</p>");
    const received = await new Promise<string>((resolve, reject) => {
      const request = get("http://127.0.0.1:4199/__limen/dev/events", (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          const line = chunk.split("\n").find((part) => part.startsWith("data: "));
          if (line !== undefined) { resolve(line.slice(6)); request.destroy(); }
        });
      });
      request.on("error", reject);
      setTimeout(() => { void writeFile(join(root, "style.css"), "p { color: red }"); }, 100);
    });
    assert.deepEqual(JSON.parse(received), { kind: "css", path: "/style.css" });
  } finally {
    dev.close();
    await rm(root, { recursive: true, force: true });
  }
});
