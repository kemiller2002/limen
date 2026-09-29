// The optional server and static renderer (kemiller2002/limen#38, LCP-022).
// One engine, one page: rendered by the kernel in a browser document and by
// the renderer on the server, the result is semantically the same — head
// metadata included. A data route renders its data; browser-only effects are
// refused explicitly; static output reads without JavaScript; the renderer's
// module graph holds no BrowserKernel; and the template reader is strict.

import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { parse, renderProjection, renderRoute, renderStatic, serialize, ProjectionError, RenderRefused, TemplateError } from "../dist/renderer/index.js";
import type { BrowserToEngineMessage, EngineToBrowserMessage, EngineTransport, CorrelationId } from "../dist/protocol.js";
import { CORE_CONTRACT_IDENTITY } from "../dist/protocol.js";
import { measureProfile } from "../bench/size.ts";
import { catalogueFetch, createCatalogueTransport, ITEMS } from "./fixtures/ssr/engine.ts";
import { withDocument, withFetch } from "./dom-helpers.ts";

const PAGE = await readFile(new URL("./fixtures/ssr/index.html", import.meta.url), "utf8");
const ORIGIN = "http://shop.test";
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 30); });

// What a reader sees, independent of how it was produced: the head metadata,
// and the body's visible text and link targets, in document order. Templates
// (inert) and the renderer's hydration markers are not content.
const semantics = (document: Document) => {
  const body = document.body.cloneNode(true) as HTMLElement;
  body.querySelectorAll("template, script").forEach((element) => element.remove());
  return {
    title: document.title,
    description: document.querySelector("meta[name=description]")?.getAttribute("content"),
    robots: document.querySelector("meta[name=robots]")?.getAttribute("content"),
    canonical: document.querySelector("link[rel=canonical]")?.getAttribute("href"),
    text: (body.textContent ?? "").replace(/\s+/g, " ").trim(),
    links: Array.from(body.querySelectorAll("a"), (link) => link.getAttribute("href")),
  };
};

// The kernel's rendering: the page in a browser document at the route's URL.
const clientRender = async (path: string) => {
  const fetchImpl = (async (url: string) => catalogueFetch(new URL(url, ORIGIN).href)) as unknown as typeof fetch;
  return withFetch(fetchImpl, () => withDocument(PAGE.replace(/<script[^>]*><\/script>/, ""), `${ORIGIN}${path}`, async (document) => {
    await new BrowserKernel(createCatalogueTransport(), document).start();
    await settle();
    return semantics(document);
  }));
};

const serverRender = async (path: string) => {
  const result = await renderRoute({ page: PAGE, engine: createCatalogueTransport(), url: `${ORIGIN}${path}`, fetch: catalogueFetch });
  const read = await withDocument(result.html, `${ORIGIN}${path}`, async (document) => semantics(document));
  return { result, read };
};

// --- one engine, two renderings ----------------------------------------------------------

test("CSR and SSR of the same route are semantically the same: head metadata, text and links", async () => {
  const routes = ["/", "/items/kettle", "/items/cups", "/nowhere"];
  const pairs = await routes.reduce<Promise<readonly (readonly [string, unknown, unknown])[]>>(async (done, route) => {
    const previous = await done;
    return [...previous, [route, await clientRender(route), (await serverRender(route)).read] as const];
  }, Promise.resolve([]));
  pairs.forEach(([route, client, server]) => assert.deepEqual(server, client, route));
});

test("an SSR data route renders its data, its title, description and canonical link", async () => {
  const { result, read } = await serverRender("/items/teapot");
  assert.equal(result.settled, true);
  assert.deepEqual([read.title, read.description, read.canonical, read.robots], ["Teapot — Catalogue", "A six-cup teapot.", `${ORIGIN}/items/teapot`, "index"]);
  assert.match(read.text, /Teapot A six-cup teapot\. All items/);
  const missing = await serverRender("/nowhere");
  assert.deepEqual([missing.read.title, missing.read.robots], ["Not found — Catalogue", "noindex"]);
});

test("browser-only effects are refused explicitly on the server, and the engine's own fallback renders", async () => {
  const { result, read } = await serverRender("/");
  assert.deepEqual(result.refused, ["Storage get"]);
  assert.match(read.text, /No recently viewed items\./);
});

test("the server offers no optional capability: an engine that selects one anyway is refused, not half-rendered", async () => {
  const selecting: EngineTransport = {
    start: async () => {},
    dispatch: async (_message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> => ({
      view: {}, effects: [], cancellations: [],
      handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [{ id: "limen.focus" as never, version: 1, fingerprint: "x" }] },
    }),
  };
  await assert.rejects(renderRoute({ page: PAGE, engine: selecting, url: `${ORIGIN}/` }), (error: unknown) => error instanceof RenderRefused && error.incompatibility.kind === "capability-not-offered");
});

test("a capability request and a request without a server fetch are answered, never dropped", async () => {
  const asks: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> => {
      if (message.kind === "Initialize") {
        assert.deepEqual(message.capabilities, [], "no fetch: not even Http is offered");
        return { view: { title: "t" }, cancellations: [], effects: [
          { kind: "Capability", correlationId: "a" as CorrelationId, capability: "limen.geolocation" as never, version: 1, request: { operation: "permission" } },
          { kind: "Http", correlationId: "b" as CorrelationId, method: "GET", url: "/api/items", timeoutMs: 100 },
          { kind: "Navigation", correlationId: "c" as CorrelationId, operation: "push", path: "/x" } as never,
        ] };
      }
      return { view: { title: message.kind === "EffectResult" ? JSON.stringify(message.result) : "t" }, effects: [], cancellations: [] };
    },
  };
  const result = await renderRoute({ page: "<html><head><title data-text=\"title\">x</title></head><body></body></html>", engine: asks, url: `${ORIGIN}/` });
  assert.deepEqual(result.refused, ["Capability limen.geolocation", "Http GET (no fetch on this server)", "Navigation push"]);
  assert.match(result.html, /Failure.*unavailable/);
});

test("the round budget bounds an engine that never stops asking: rendered as it stands, marked unsettled", async () => {
  const endless: EngineTransport = {
    start: async () => {},
    dispatch: async (): Promise<EngineToBrowserMessage> => ({ view: { title: "busy" }, cancellations: [], effects: [{ kind: "Storage", correlationId: "s" as CorrelationId, operation: "get", key: "k" }] }),
  };
  const result = await renderRoute({ page: "<html><head><title data-text=\"title\">x</title></head><body></body></html>", engine: endless, url: `${ORIGIN}/`, maxRounds: 3 });
  assert.deepEqual([result.settled, result.rounds], [false, 3]);
  assert.match(result.html, /<title[^>]*>busy<\/title>/);
});

// --- static output -------------------------------------------------------------------------

// scripts/smoke-packs.ts loads this page in Chromium. It is the renderer's
// output, not a hand-written copy: LIMEN_WRITE_RENDERED=1 regenerates it.
test("the browser page for the renderer is renderRoute's current output for /", async () => {
  const committed = new URL("./browser/packs/renderer/index.html", import.meta.url);
  const { html, settled } = await renderRoute({ page: PAGE, engine: createCatalogueTransport(), url: `${ORIGIN}/`, fetch: catalogueFetch });
  assert.equal(settled, true);
  if (process.env.LIMEN_WRITE_RENDERED === "1") await writeFile(committed, html);
  assert.equal(await readFile(committed, "utf8"), html, "regenerate with LIMEN_WRITE_RENDERED=1");
});

test("static generation renders every route, and the output reads without JavaScript", async () => {
  const pages = await renderStatic(["/", ...ITEMS.map((item) => `/items/${item.id}`)], { page: PAGE, origin: ORIGIN, engine: () => createCatalogueTransport(), fetch: catalogueFetch });
  assert.equal(pages.size, 4);
  const home = pages.get("/")?.html ?? "";
  // A document whose scripts never run: what a crawler or a no-JS reader gets.
  await withDocument(home, `${ORIGIN}/`, async (document) => {
    const items = Array.from(document.querySelectorAll("#items li"), (row) => row.textContent?.replace(/\s+/g, " ").trim());
    assert.deepEqual(items, ["Kettle £24.50", "Teapot £18.00", "Cups & saucers £12.25"]);
    assert.deepEqual(Array.from(document.querySelectorAll("#items a"), (link) => link.getAttribute("href")), ["/items/kettle", "/items/teapot", "/items/cups"]);
  });
  assert.match(pages.get("/items/cups")?.html ?? "", /Four &lt;fine&gt; cups\./, "text is escaped, never markup");
});

test("rendered rows and mounted sections carry the markers hydration will adopt; a client-only section is left as authored", async () => {
  const { result } = await serverRender("/");
  assert.match(result.html, /<ul id="items" data-limen-if="showList">/);
  assert.deepEqual(Array.from(result.html.matchAll(/data-limen-key="([^"]+)"/g), (match) => match[1]), ["kettle", "teapot", "cups"]);
  assert.match(result.html, /<section id="stock" data-client-only>\s*<p>Live stock levels appear once the page is running\.<\/p>/);
});

// --- the policy and the template reader ----------------------------------------------------------

test("the kernel's binding policy applies on the server: an unsafe URL is refused and not written; projection errors match the kernel's", () => {
  const nodes = parse(`<a data-bind-href="href">x</a><p data-text="missing"></p>`);
  assert.throws(() => renderProjection(nodes, { href: "/ok" }, ORIGIN), (error: unknown) => error instanceof ProjectionError && error.message === `View value for "missing" is missing or not scalar`);
  const unsafe = renderProjection(parse(`<a data-bind-href="href">x</a>`), { href: "javascript:alert(1)" }, ORIGIN);
  assert.equal(serialize(unsafe.nodes), `<a data-bind-href="href">x</a>`);
  assert.deepEqual(unsafe.refusals, ["refused a javascript: URL for <a href>; only http, https, mailto, tel and relative URLs are projected"]);
  assert.throws(() => renderProjection(parse(`<script data-text="x"></script>`), { x: "alert(1)" }, ORIGIN), ProjectionError);
  assert.throws(() => renderProjection(parse(`<a data-bind-onclick="x">x</a>`), { x: "1" }, ORIGIN), ProjectionError);
});

test("booleans by presence, and value on inputs, text areas and selects, as the kernel sets them", () => {
  const html = `<button data-bind-disabled="off">b</button><input data-bind-value="name"><textarea data-bind-value="note"></textarea><select data-bind-value="size"><option value="s">S</option><option value="m" selected>M</option></select>`;
  const rendered = serialize(renderProjection(parse(html), { off: false, name: "Ada \"L\"", note: "<hi>", size: "s" }, ORIGIN).nodes);
  assert.equal(rendered, `<button data-bind-disabled="off">b</button><input data-bind-value="name" value="Ada &quot;L&quot;"><textarea data-bind-value="note">&lt;hi&gt;</textarea><select data-bind-value="size"><option value="s" selected>S</option><option value="m">M</option></select>`);
});

test("the template reader is strict: an unclosed element or a stray end tag is an error with its line, never a guess", () => {
  assert.throws(() => parse("<main>\n<p>open"), (error: unknown) => error instanceof TemplateError && /line 2: <p> is never closed/.test(error.message));
  assert.throws(() => parse("<div>\n</span>"), (error: unknown) => error instanceof TemplateError && /line 2: <\/span> does not close the open <div>/.test(error.message));
  const page = "<!doctype html><html><head><title>A &amp; B</title></head><body><p class=\"x\">T &lt; U</p><!-- note --><br></body></html>";
  assert.equal(serialize(parse(page)), page, "what it reads, it writes back unchanged");
});

test("the renderer's module graph holds no BrowserKernel", async () => {
  const closure = await measureProfile(process.cwd(), { name: "renderer", doc: "", entries: ["dist/renderer/index.js"], forbidden: ["dist/kernel/browser-kernel.js", "dist/capabilities/", "dist/hosts/"] });
  assert.deepEqual(closure.forbiddenPresent, []);
  assert.ok(closure.modules.includes("dist/kernel/binding-policy.js"), "the same binding policy as the kernel");
});
