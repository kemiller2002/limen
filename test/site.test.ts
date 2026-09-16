// Verification for the Limen website.
//
// The site is itself a Limen application, so it can rot in the same ways any
// application can — most cheaply by binding a view key the engine does not
// project, which throws at runtime and leaves the page frozen with nothing in
// the console unless a diagnostics sink is installed.
//
// These tests run against the BUILT site in dist-site/, so they check the
// markup that actually ships rather than a copy of it. Run `npm run build:site`
// first; `pretest` does.
//
// Real-browser behavior (layout, responsive overflow, fonts) is verified
// separately against Chromium — see docs/09-testing-and-debugging.md. jsdom
// cannot speak to any of that, and this file does not pretend to.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { JSDOM } from "jsdom";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { DiagnosticEvent } from "../dist/kernel/diagnostics.js";
import { withDom, withFetch } from "./dom-helpers.ts";
import { createSiteTransport, project, initialState, PLACEMENT_TASKS } from "../site/app/engine.ts";

const SITE = new URL("../dist-site/", import.meta.url);
const built = existsSync(new URL("index.html", SITE));

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

async function pages(): Promise<readonly string[]> {
  const entries = await readdir(SITE);
  return entries.filter((name) => name.endsWith(".html")).sort();
}

const load = async (name: string): Promise<Document> =>
  new JSDOM(await readFile(new URL(name, SITE), "utf8")).window.document;

/** Every view key the markup binds, by primitive. */
function boundKeys(document: Document): { scalars: Set<string>; conditions: Set<string>; lists: Set<string>; events: Set<string> } {
  const scalars = new Set<string>();
  const conditions = new Set<string>();
  const lists = new Set<string>();
  const events = new Set<string>();
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    const text = el.getAttribute("data-text");
    if (text) scalars.add(text);
    const iff = el.getAttribute("data-if");
    if (iff) conditions.add(iff);
    const each = el.getAttribute("data-each");
    if (each) lists.add(each);
    const evt = el.getAttribute("data-event");
    if (evt) events.add(evt);
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-bind-")) scalars.add(attr.value);
    }
  }
  return { scalars, conditions, lists, events };
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

test("the site builds every expected page", { skip: built ? false : "run `npm run build:site` first" }, async () => {
  assert.deepEqual(await pages(), [
    "agents.html", "architecture.html", "demos.html", "docs.html", "evidence.html", "index.html",
  ]);
});

test("every page has one h1, a nav current marker, and a skip link target", { skip: built ? false : "not built" }, async () => {
  for (const name of await pages()) {
    const document = await load(name);
    assert.equal(document.querySelectorAll("h1").length, 1, `${name}: expected exactly one h1`);
    assert.equal(document.querySelectorAll('nav a[aria-current="page"]').length, 1, `${name}: nav current`);
    assert.ok(document.querySelector("#main-content"), `${name}: skip-link target missing`);
    assert.equal(document.querySelector("a.skip-link")?.getAttribute("href"), "#main-content", `${name}: skip link`);
  }
});

// Absolute paths would break under a GitHub project-pages base path
// (/typescript-wasm-kernel/). Everything the site references must be relative.
test("no page references a root-absolute asset path", { skip: built ? false : "not built" }, async () => {
  for (const name of await pages()) {
    const document = await load(name);
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("[src], [href]"))) {
      const url = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      if (url.startsWith("#") || /^(https?:|data:|mailto:)/.test(url)) continue;
      assert.ok(!url.startsWith("/"), `${name}: root-absolute path would break under a base path — ${url}`);
    }
  }
});

test("the build injects the real package version", { skip: built ? false : "not built" }, async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  const document = await load("index.html");
  assert.match(document.querySelector(".footer-note")?.textContent ?? "", new RegExp(`Limen ${pkg.version.replace(/\./g, "\\.")}`));
});

// ---------------------------------------------------------------------------
// The site as a Limen application
// ---------------------------------------------------------------------------

// The cheapest way to break a Limen app: bind a key the engine never projects.
// It throws at runtime and the page silently stops updating.
test("every bound view key is actually projected by the site engine", { skip: built ? false : "not built" }, async () => {
  const view = project(initialState);
  for (const name of ["index.html", "demos.html"]) {
    const document = await load(name);
    const { scalars, conditions, lists } = boundKeys(document);
    for (const key of scalars) {
      assert.ok(key in view, `${name}: data-text/data-bind-* references "${key}", which the engine never projects`);
      assert.ok(["string", "number", "boolean"].includes(typeof view[key]), `${name}: "${key}" must project a scalar`);
    }
    for (const key of conditions) {
      assert.ok(key in view, `${name}: data-if references "${key}", which the engine never projects — it would be silently falsy forever`);
    }
    for (const key of lists) {
      assert.ok(Array.isArray(view[key]), `${name}: data-each="${key}" must project an array`);
    }
  }
});

test("every bound event name is in the engine's command vocabulary", { skip: built ? false : "not built" }, async () => {
  for (const name of ["index.html", "demos.html"]) {
    const document = await load(name);
    for (const event of boundKeys(document).events) {
      // eventToCommand throws on anything it does not recognize, so a typo in
      // the markup surfaces here rather than as a runtime BridgeError.
      await withDom("<p></p>", async () => {
        const transport = createSiteTransport();
        await assert.doesNotReject(
          () => transport.dispatch({ kind: "Event", event: { kind: "Event", name: event, key: "engine" } }),
          `${name}: data-event="${event}" is not in the engine's vocabulary`,
        );
      });
    }
  }
});

test("pages with no application behavior carry no bindings", { skip: built ? false : "not built" }, async () => {
  // Static prose stays static: the kernel is only loaded where it has work.
  for (const name of ["architecture.html", "evidence.html", "agents.html", "docs.html"]) {
    const document = await load(name);
    const { scalars, conditions, lists, events } = boundKeys(document);
    const total = scalars.size + conditions.size + lists.size + events.size;
    assert.equal(total, 0, `${name}: prose pages should not bind anything, found ${total}`);
    assert.equal(document.querySelectorAll('script[src*="main.js"]').length, 0, `${name}: should not load the app`);
  }
});

test("pages with application behavior do load the app", { skip: built ? false : "not built" }, async () => {
  for (const name of ["index.html", "demos.html"]) {
    const document = await load(name);
    assert.equal(document.querySelectorAll('script[type="module"][src="./site/app/main.js"]').length, 1, `${name}: app script`);
  }
});

// ---------------------------------------------------------------------------
// Behavior, driven through the real kernel against the real built markup
// ---------------------------------------------------------------------------

async function bodyOf(name: string): Promise<string> {
  const dom = new JSDOM(await readFile(new URL(name, SITE), "utf8"));
  for (const script of Array.from(dom.window.document.querySelectorAll("script"))) script.remove();
  return dom.window.document.body.innerHTML;
}

test("the home counter runs, and projects its own capabilities", { skip: built ? false : "not built" }, async () => {
  await withDom(await bodyOf("index.html"), async (document) => {
    const errors: DiagnosticEvent[] = [];
    await new BrowserKernel(createSiteTransport(), document, { report: (e) => { errors.push(e); } }).start();
    assert.deepEqual(errors.filter((e) => e.kind === "BridgeError"), [], "no bridge errors on the real markup");
    assert.equal(document.querySelector("[data-text='counter']")?.textContent, "0");
    assert.equal((document.querySelector("[data-event='resetCounter']") as HTMLButtonElement).disabled, true);

    (document.querySelector("[data-event='increment']") as HTMLElement).click();
    await flush();
    assert.equal(document.querySelector("[data-text='counter']")?.textContent, "1");
    assert.equal((document.querySelector("[data-event='resetCounter']") as HTMLButtonElement).disabled, false);
    assert.ok(document.querySelectorAll("ol.trace li").length >= 1, "the engine recorded the round trip");
  });
});

test("the demos page binds cleanly and the explicit-state demo cannot skip ahead", { skip: built ? false : "not built" }, async () => {
  await withDom(await bodyOf("demos.html"), async (document) => {
    const errors: DiagnosticEvent[] = [];
    await new BrowserKernel(createSiteTransport(), document, { report: (e) => { errors.push(e); } }).start();
    assert.deepEqual(errors.filter((e) => e.kind === "BridgeError"), [], "no bridge errors on the real markup");

    const advance = document.querySelector("[data-event='advanceSave']") as HTMLButtonElement;
    for (const expected of ["Editing", "Saving", "Saved"]) {
      advance.click();
      await flush();
      assert.equal(document.querySelector("[data-text='saveState']")?.textContent, expected);
    }
    assert.equal(advance.disabled, true, "Saved is terminal on this path");
    // "Make it fail" is only legal while Saving — never from Saved.
    assert.equal((document.querySelector("[data-event='failSave']") as HTMLButtonElement).disabled, true);
  });
});

test("the effects demo classifies a real success through the kernel", { skip: built ? false : "not built" }, async () => {
  const impl = (async () => ({
    status: 200,
    json: async () => [{ id: "1" }, { id: "2" }, { id: "3" }],
  })) as unknown as typeof fetch;

  await withFetch(impl, async () => {
    await withDom(await bodyOf("demos.html"), async (document) => {
      await new BrowserKernel(createSiteTransport(), document).start();
      (document.querySelector("[data-event='loadSuccess']") as HTMLElement).click();
      await flush();
      await flush();
      assert.equal(document.querySelector("[data-text='loadState']")?.textContent, "Loaded");
      assert.match(document.querySelector("[data-text='loadMessage']")?.textContent ?? "", /Loaded 3 record/);
    });
  });
});

test("an undecodable error response is distinguished from a malformed 200 (P-3, via the site)", { skip: built ? false : "not built" }, async () => {
  const notJson = (status: number) => (async () => ({
    status,
    json: async () => { throw new Error("Unexpected token <"); },
  })) as unknown as typeof fetch;

  // A 503 HTML error page: the server refused, and that is worth retrying.
  await withFetch(notJson(503), async () => {
    await withDom(await bodyOf("demos.html"), async (document) => {
      await new BrowserKernel(createSiteTransport(), document).start();
      (document.querySelector("[data-event='loadNotFound']") as HTMLElement).click();
      await flush();
      await flush();
      assert.match(document.querySelector("[data-text='loadMessage']")?.textContent ?? "", /answered 503/);
      assert.ok(document.querySelector("[data-event='retryLoad'], .note"), "retry guidance is offered");
    });
  });

  // A 200 whose body is malformed: retrying would fail identically.
  await withFetch(notJson(200), async () => {
    await withDom(await bodyOf("demos.html"), async (document) => {
      await new BrowserKernel(createSiteTransport(), document).start();
      (document.querySelector("[data-event='loadInvalid']") as HTMLElement).click();
      await flush();
      await flush();
      assert.match(document.querySelector("[data-text='loadMessage']")?.textContent ?? "", /could not be read as JSON/);
    });
  });
});

test("the placement quiz has a defensible answer for every task", () => {
  assert.ok(PLACEMENT_TASKS.length >= 5, "enough tasks to be worth taking");
  for (const task of PLACEMENT_TASKS) {
    assert.ok(task.prompt.trim().length > 0);
    assert.ok(task.because.trim().length > 20, `"${task.prompt}" needs a real explanation, not a label`);
    assert.ok(["html", "css", "kernel", "engine", "effect"].includes(task.answer));
  }
});
