// Document metadata is a projection (kemiller2002/limen#38): the kernel binds
// <head> with the same data-text / data-bind-* rules and binding policy as
// <body>, so a route's title, description, robots and canonical link follow
// the engine on the client exactly as the server renderer writes them.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { BrowserToEngineMessage, EngineTransport, ViewState } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const HEAD = `<title data-text="title">Loading</title>
<meta name="description" data-bind-content="description" content="">
<meta name="robots" data-bind-content="robots" content="index">
<link rel="canonical" data-bind-href="canonical" href="/">`;

const withPage = async (views: readonly ViewState[], act: (document: Document, next: () => Promise<void>, diagnostics: readonly string[]) => Promise<void>): Promise<void> => {
  const queue = [...views];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (_message: BrowserToEngineMessage) => ({ view: queue.length > 1 ? queue.shift() ?? {} : queue[0] ?? {}, effects: [], cancellations: [] }),
  };
  await withDom(`<button id="next" data-event="next">next</button>`, async (document) => {
    document.head.innerHTML = HEAD;
    const diagnostics: string[] = [];
    await new BrowserKernel(transport, document, { report: (event) => { diagnostics.push(JSON.stringify(event)); } }).start();
    const next = async (): Promise<void> => { document.getElementById("next")?.click(); await new Promise((resolve) => { setTimeout(resolve, 10); }); };
    await act(document, next, diagnostics);
  });
};

const meta = (document: Document, name: string): string | null => document.querySelector(`meta[name=${name}]`)?.getAttribute("content") ?? null;

test("the title, description, robots and canonical link are projected from the engine's view", async () => {
  await withPage([{ title: "Orders — Acme", description: "Your open orders", robots: "noindex", canonical: "/orders" }], async (document) => {
    assert.equal(document.title, "Orders — Acme");
    assert.equal(meta(document, "description"), "Your open orders");
    assert.equal(meta(document, "robots"), "noindex");
    assert.equal(document.querySelector("link[rel=canonical]")?.getAttribute("href"), "/orders");
  });
});

test("a later projection updates the metadata, as a route change would", async () => {
  await withPage([
    { title: "Orders", description: "a", robots: "index", canonical: "/orders" },
    { title: "Order 7", description: "b", robots: "index", canonical: "/orders/7" },
  ], async (document, next) => {
    await next();
    assert.deepEqual([document.title, meta(document, "description"), document.querySelector("link[rel=canonical]")?.getAttribute("href")], ["Order 7", "b", "/orders/7"]);
  });
});

test("the binding policy applies in <head> too: an unsafe canonical URL is refused, and its value is not written", async () => {
  await withPage([{ title: "t", description: "d", robots: "index", canonical: "javascript:alert(1)" }], async (document, _next, diagnostics) => {
    assert.equal(document.querySelector("link[rel=canonical]")?.hasAttribute("href"), false);
    assert.ok(diagnostics.some((line) => line.includes("refused a javascript: URL")), diagnostics.join("\n"));
  });
});

test("only inert metadata becomes bindable: http-equiv, charset, other meta, and links that load something stay refused", async () => {
  const { bindableElement } = await import("../dist/kernel/binding-policy.js");
  const attrs = (values: Record<string, string>) => (name: string): string | null => values[name] ?? null;
  const allowed = [
    bindableElement("meta", attrs({ name: "description" }), ["content"]),
    bindableElement("meta", attrs({ name: "twitter:title" }), ["content"]),
    bindableElement("meta", attrs({ property: "og:image" }), ["content"]),
    bindableElement("link", attrs({ rel: "canonical" }), ["href"]),
    bindableElement("link", attrs({ rel: "alternate", hreflang: "fr" }), ["href", "hreflang"]),
  ];
  assert.deepEqual(allowed, [undefined, undefined, undefined, undefined, undefined]);
  const refused = [
    bindableElement("meta", attrs({ "http-equiv": "refresh" }), ["content"]),
    bindableElement("meta", attrs({ charset: "utf-8" }), ["content"]),
    bindableElement("meta", attrs({ name: "viewport" }), ["content"]),
    bindableElement("meta", attrs({ name: "referrer" }), ["content"]),
    bindableElement("meta", attrs({ name: "description" }), ["name"]),
    bindableElement("meta", attrs({ name: "description" }), ["data-text"]),
    bindableElement("link", attrs({ rel: "stylesheet" }), ["href"]),
    bindableElement("link", attrs({ rel: "canonical preload" }), ["href"]),
    bindableElement("link", attrs({ rel: "canonical" }), ["rel"]),
    bindableElement("script", attrs({}), ["src"]),
  ];
  assert.ok(refused.every((problem) => typeof problem === "string"), JSON.stringify(refused));
});
