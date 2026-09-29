// Binding security (kemiller2002/limen#18, LCP-027): what a projection may
// write, and where. The HTML author picks a binding's target; the engine
// supplies its value, which is often user data. Real-browser proof under a
// strict CSP with Trusted Types enforced is scripts/smoke-security.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { checkUrl, classifyAttribute, bindableElement } from "../dist/kernel/binding-policy.js";
import type { DiagnosticEvent } from "../dist/kernel/diagnostics.js";
import type { BrowserToEngineMessage, CorrelationId, EffectRequest, EngineToBrowserMessage, EngineTransport, ViewState } from "../dist/protocol.js";
import { withClipboard, withDom, withFetch } from "./dom-helpers.ts";

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

// An engine that answers Initialize with `first`, then each later message with
// the next view in `later` (the last one repeats), plus optional effects.
const scripted = (first: ViewState, later: readonly ViewState[] = [], effects: readonly EffectRequest[] = []): { readonly transport: EngineTransport; readonly calls: BrowserToEngineMessage[] } => {
  const calls: BrowserToEngineMessage[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message): Promise<EngineToBrowserMessage> => {
      calls.push(message);
      const index = calls.length - 2;
      return message.kind === "Initialize"
        ? { view: first, effects: [...effects], cancellations: [] }
        : { view: later[Math.min(index, later.length - 1)] ?? first, effects: [], cancellations: [] };
    },
  };
  return { transport, calls };
};

const run = async (body: string, first: ViewState, later: readonly ViewState[] = [], effects: readonly EffectRequest[] = [], act: (document: Document) => Promise<void> = async () => {}) => {
  const events: DiagnosticEvent[] = [];
  const engine = scripted(first, later, effects);
  const snapshot = await withDom(body, async (document) => {
    await new BrowserKernel(engine.transport, document, { report: (event) => { events.push(event); } }).start();
    await flush();
    await act(document);
    return document.body.innerHTML;
  });
  return { events, calls: engine.calls, html: snapshot };
};

const bridgeErrors = (events: readonly DiagnosticEvent[], phase: string): readonly string[] =>
  events.flatMap((event) => (event.kind === "BridgeError" && event.phase === phase ? [event.detail] : []));

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

test("text projection is textContent: markup and script payloads stay inert text", async () => {
  const payload = `<img src=x onerror="globalThis.__limenPwned=1"><script>globalThis.__limenPwned=1</script>`;
  const { html, events } = await run(`<p id="out" data-text="message"></p>`, { message: payload });
  assert.equal(Reflect.get(globalThis, "__limenPwned"), undefined);
  assert.ok(!/<img|<script/.test(html.replace(/&lt;/g, "")), "no element was created from projected text");
  assert.ok(html.includes("&lt;img src=x onerror="), "the payload is present, escaped, as text");
  assert.deepEqual(bridgeErrors(events, "projection"), []);
});

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const UNSAFE_URLS: readonly string[] = [
  "javascript:globalThis.__limenPwned=1",
  "JaVaScRiPt:globalThis.__limenPwned=1",
  "java\tscript:globalThis.__limenPwned=1",
  "java\nscript:globalThis.__limenPwned=1",
  "  javascript:globalThis.__limenPwned=1",
  "\u0001javascript:globalThis.__limenPwned=1",
  "data:text/html,<script>globalThis.__limenPwned=1</script>",
  "vbscript:msgbox(1)",
  "blob:http://localhost/0b6f",
  "file:///etc/passwd",
  "http://[::1",
];

const SAFE_URLS: readonly string[] = ["https://example.com/a?token=x", "http://example.com/", "/invoices/42", "../up", "?tab=2", "#section", "mailto:a@example.com", "tel:+15555550100", "//example.com/protocol-relative"];

test("the URL policy: only http, https, mailto, tel and relative URLs, resolved as the browser resolves them", () => {
  const base = "http://localhost/app/";
  assert.deepEqual(UNSAFE_URLS.map((url) => checkUrl(url, base).kind), UNSAFE_URLS.map(() => "Unsafe"));
  assert.deepEqual(SAFE_URLS.map((url) => checkUrl(url, base).kind), SAFE_URLS.map(() => "Safe"));
  assert.deepEqual(checkUrl("java\tscript:x", base), { kind: "Unsafe", scheme: "javascript:" }, "tab-split schemes are seen as the browser sees them");
});

for (const url of UNSAFE_URLS) {
  test(`an unsafe URL is not written, and its refusal does not echo the value: ${JSON.stringify(url.slice(0, 24))}`, async () => {
    const { html, events } = await run(`<a id="link" data-bind-href="target">go</a><img data-bind-src="target"><form data-bind-action="target"></form>`, { target: url });
    assert.ok(!/\s(href|src|action)=/.test(html), html);
    const refusals = bridgeErrors(events, "projection");
    assert.equal(refusals.length, 3, "each unsafe URL binding is reported");
    for (const refusal of refusals) {
      assert.match(refusal, /^refused a [a-z:]+ URL for <(a href|img src|form action)>/);
      assert.ok(!refusal.includes("__limenPwned") && !refusal.includes("passwd") && !refusal.includes("msgbox"), refusal);
    }
  });
}

test("safe URLs are written as given", async () => {
  const { html, events } = await run(`<a data-bind-href="target">go</a>`, { target: SAFE_URLS[0] ?? "" }, [], [], async () => {});
  assert.match(html, /href="https:\/\/example\.com\/a\?token=x"/);
  assert.deepEqual(bridgeErrors(events, "projection"), []);
});

test("a later unsafe value removes the earlier safe URL instead of leaving it stale", async () => {
  const { html, events } = await run(`<a data-bind-href="target">go</a><button id="b" data-event="next">next</button>`, { target: "/safe" }, [{ target: "javascript:void 0" }], [], async (document) => {
    document.getElementById("b")?.click();
    await flush();
  });
  assert.ok(!/\shref=/.test(html), html);
  assert.equal(bridgeErrors(events, "projection").length, 1);
});

test("an unsafe URL refuses only that attribute: the rest of the projection still applies", async () => {
  const { html } = await run(`<a data-bind-href="target" data-bind-title="label">go</a><p data-text="label"></p>`, { target: "javascript:x", label: "still here" });
  assert.match(html, /title="still here"/);
  assert.match(html, /<p data-text="label">still here<\/p>/);
});

// ---------------------------------------------------------------------------
// Targets refused when the page starts
// ---------------------------------------------------------------------------

const FORBIDDEN_PAGES: readonly (readonly [string, RegExp])[] = [
  [`<button data-bind-onclick="handler">x</button>`, /onclick is an event-handler attribute/],
  [`<img data-bind-onerror="handler">`, /onerror is an event-handler attribute/],
  [`<p data-bind-OnMouseOver="handler"></p>`, /onmouseover is an event-handler attribute/],
  [`<p data-bind-style="css"></p>`, /inline style is appearance/],
  [`<img data-bind-srcset="list">`, /srcset is a list of URLs/],
  [`<a data-bind-ping="list">x</a>`, /ping sends a request/],
  [`<div data-bind-srcdoc="doc"></div>`, /srcdoc loads a whole document/],
  [`<iframe data-bind-src="page"></iframe>`, /<iframe> loads, runs or rewrites code/],
  [`<script data-text="code"></script>`, /<script> loads, runs or rewrites code/],
  [`<style data-text="css"></style>`, /<style> loads, runs or rewrites code/],
  [`<base data-bind-href="root">`, /<base> loads, runs or rewrites code/],
  [`<object data-bind-data="thing"></object>`, /<object> loads, runs or rewrites code/],
  [`<svg><a><set data-bind-to="value" attributeName="href"></set></a></svg>`, /<set> loads, runs or rewrites code/],
  [`<ul><template data-each="rows" data-key="id"><li><script data-text="code"></script></li></template></ul>`, /<script> loads, runs or rewrites code/],
  [`<template data-if="shown"><p data-bind-onclick="handler"></p></template>`, /onclick is an event-handler attribute/],
];

for (const [body, reason] of FORBIDDEN_PAGES) {
  test(`refused when the page starts, before the engine is asked anything: ${body.slice(0, 60)}`, async () => {
    const { events, calls } = await run(body, { handler: "globalThis.__limenPwned=1", css: "x", list: "a", doc: "<p>", page: "/", code: "x", root: "/", thing: "/", value: "javascript:x", rows: [], shown: true });
    const errors = bridgeErrors(events, "binding");
    assert.equal(errors.length, 1, JSON.stringify(events));
    assert.match(errors[0] ?? "", reason);
    assert.deepEqual(calls, [], "no Initialize: the kernel faulted before any traffic");
    assert.equal(Reflect.get(globalThis, "__limenPwned"), undefined);
  });
}

test("ordinary attributes, aria-*, data-*, boolean properties and value stay bindable", () => {
  assert.deepEqual(["title", "aria-current", "data-tone", "class", "lang", "alt", "placeholder"].map((name) => classifyAttribute(name).kind), ["Attribute", "Attribute", "Attribute", "Attribute", "Attribute", "Attribute", "Attribute"]);
  assert.deepEqual(["disabled", "checked", "hidden", "open", "selected"].map((name) => classifyAttribute(name).kind), ["BooleanProperty", "BooleanProperty", "BooleanProperty", "BooleanProperty", "BooleanProperty"]);
  assert.deepEqual(["href", "src", "action", "formaction", "xlink:href", "poster"].map((name) => classifyAttribute(name).kind), ["Url", "Url", "Url", "Url", "Url", "Url"]);
  assert.deepEqual(["p", "a", "button", "input", "svg", "li", "img", "form"].map(bindableElement), [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
});

// ---------------------------------------------------------------------------
// Diagnostics redaction
// ---------------------------------------------------------------------------

const SECRETS = ["SECRET-TOKEN-7f3", "SECRET-BODY-91c", "SECRET-QUERY-4d2", "SECRET-CLIP-0aa", "SECRET-URL-5e1", "SECRET-VIEW-b77"];

test("no diagnostic ever carries a header, body, query, clipboard text, projected URL or view value", async () => {
  const http = (id: string, timeoutMs = 1000): EffectRequest => ({
    kind: "Http", correlationId: id as CorrelationId, method: "POST", url: `/api/save?token=${SECRETS[2]}`, timeoutMs,
    headers: { authorization: `Bearer ${SECRETS[0]}` }, body: JSON.stringify({ password: SECRETS[1] }),
  });
  // A hostile fetch whose own errors echo the request: the kernel must not forward them.
  const hostileFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("hang")) return new Promise<Response>((_, reject) => { init?.signal?.addEventListener("abort", () => reject(new Error(`aborted ${url} ${JSON.stringify(init.headers)}`))); });
    if (url.includes("html")) return new Response(`<html>${SECRETS[1]}</html>`, { status: 500 });
    throw new TypeError(`fetch to ${url} with ${JSON.stringify(init?.headers)} and ${String(init?.body)} failed`);
  }) as typeof fetch;
  const events: DiagnosticEvent[] = [];
  const effects: readonly EffectRequest[] = [
    http("network"),
    { ...http("invalid"), url: `/html?token=${SECRETS[2]}` },
    { ...http("timeout", 5), url: `/hang?token=${SECRETS[2]}` },
    { kind: "Clipboard", correlationId: "clip" as CorrelationId, operation: "writeText", text: SECRETS[3] },
  ];
  const engine = scripted({ target: `javascript:${SECRETS[4]}`, label: "ok" }, [{ target: "/x", label: [{ id: "1", secret: SECRETS[5] }] }], effects);
  await withDom(`<a data-bind-href="target">x</a><p data-text="label"></p><button id="b" data-event="next">n</button>`, (document) =>
    withFetch(hostileFetch, () => withClipboard(async () => { throw new DOMException(`denied ${SECRETS[3]}`, "NotAllowedError"); }, async () => {
      await new BrowserKernel(engine.transport, document, { report: (event) => { events.push(event); } }).start();
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      document.getElementById("b")?.click();
      await flush();
    })));
  const logged = JSON.stringify(events);
  assert.ok(events.some((event) => event.kind === "BridgeError" && event.phase === "projection"), "the failure paths were exercised");
  assert.ok(events.some((event) => event.kind === "EffectTiming"), "the effects ran");
  for (const secret of SECRETS) assert.ok(!logged.includes(secret), `diagnostics leaked ${secret}: ${logged}`);
});
