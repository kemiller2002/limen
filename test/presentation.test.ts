// Resource hints and view transitions (kemiller2002/limen#34, LCP-025/026).
// jsdom has no View Transition API, which is the Unsupported fallback; a
// scripted startViewTransition drives the pack's own sequence (Ready, then
// the next projection, then TransitionFinished) and the skipped and
// transition-types paths. The real API is proven in Chromium
// (test/browser/packs/presentation/).

import assert from "node:assert/strict";
import test from "node:test";
import { PRESENTATION_CAPABILITY, decodePresentationFact, decodePresentationResult, presentationCapability, type PresentationFact, type PresentationRequest, type PresentationResult } from "../dist/capabilities/presentation/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CorrelationId } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

type Harness = { readonly ask: (request: PresentationRequest) => Promise<PresentationResult>; readonly facts: PresentationFact[]; readonly document: Document };

const withPack = async (act: (harness: Harness) => Promise<void>, prepare: (document: Document) => void = () => {}): Promise<void> => {
  await withDom(`<p id="screen">list</p>`, async (document) => {
    prepare(document);
    const facts: PresentationFact[] = [];
    const provider = presentationCapability();
    provider.activate({ document, emitFact: (fact) => { const decoded = decodePresentationFact(fact); assert.ok(decoded.ok); facts.push(decoded.value); } });
    const ask = async (request: PresentationRequest): Promise<PresentationResult> => {
      const answer = await provider.execute(request, { correlationId: "p" as CorrelationId, signal: new AbortController().signal, document });
      const decoded = answer.kind === "Completed" ? decodePresentationResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true);
      return decoded.value;
    };
    await act({ ask, facts, document });
  });
};

// A scripted View Transition API: calls update, then settles finished.
type Calls = { argument?: unknown };
const scriptTransitions = (calls: Calls, skip = false) => (document: Document): void => {
  Reflect.set(document, "startViewTransition", (argument: unknown) => {
    calls.argument = argument;
    const update = typeof argument === "function" ? argument as () => Promise<void> : (argument as { update: () => Promise<void> }).update;
    const updateCallbackDone = Promise.resolve().then(() => update());
    const finished = updateCallbackDone.then(() => (skip ? Promise.reject(new Error("skipped")) : undefined));
    finished.catch(() => {});
    return { updateCallbackDone, finished };
  });
};

test("without the View Transition API, prepareTransition is Unsupported and the engine simply renders", async () => {
  await withPack(async ({ ask, facts }) => {
    assert.deepEqual(await ask({ operation: "prepareTransition", label: "open", timeoutMs: 100 }), { kind: "Unsupported" });
    assert.deepEqual(await ask({ operation: "prepareTransition", label: "Bad Label", timeoutMs: 100 }), { kind: "InvalidRequest", problem: "label must be a lower-case CSS identifier" });
    assert.deepEqual(await ask({ operation: "prepareTransition", label: "open", timeoutMs: 0 }), { kind: "InvalidRequest", problem: "timeoutMs must be 1 to 10000" });
    assert.deepEqual(facts, []);
  });
});

test("Ready once the old view is captured; the next change to the page completes it; the label is on the root only meanwhile", async () => {
  const calls: Calls = {};
  await withPack(async ({ ask, facts, document }) => {
    assert.deepEqual(await ask({ operation: "prepareTransition", label: "open-detail", timeoutMs: 1000 }), { kind: "Ready" });
    assert.equal(document.documentElement.getAttribute("data-view-transition"), "open-detail");
    assert.deepEqual(await ask({ operation: "prepareTransition", label: "other", timeoutMs: 1000 }), { kind: "Busy" });
    const screen = document.getElementById("screen");
    assert.ok(screen !== null);
    screen.textContent = "detail";
    await sleep(10);
    assert.deepEqual(facts, [{ kind: "TransitionFinished", label: "open-detail", outcome: "finished" }]);
    assert.equal(document.documentElement.getAttribute("data-view-transition"), null);
    assert.equal(typeof calls.argument, "function", "without transition types, the plain callback form is used");
  }, scriptTransitions(calls));
});

test("where transition types exist, the label is passed as the type", async () => {
  const calls: Calls = {};
  await withPack(async ({ ask, document }) => {
    await ask({ operation: "prepareTransition", label: "open-detail", timeoutMs: 20 });
    await sleep(40);
    assert.deepEqual((calls.argument as { types?: unknown }).types, ["open-detail"]);
    assert.equal(document.documentElement.getAttribute("data-view-transition"), null);
  }, (document) => {
    scriptTransitions(calls)(document);
    const view = document.defaultView;
    assert.ok(view !== null);
    Reflect.set(view, "ViewTransition", class { get types(): readonly string[] { return []; } });
  });
});

test("no change within timeoutMs ends the transition as timedOut; a browser that skips reports skipped", async () => {
  await withPack(async ({ ask, facts }) => {
    await ask({ operation: "prepareTransition", label: "slow", timeoutMs: 20 });
    await sleep(60);
    assert.deepEqual(facts, [{ kind: "TransitionFinished", label: "slow", outcome: "timedOut" }]);
  }, scriptTransitions({}));
  await withPack(async ({ ask, facts, document }) => {
    await ask({ operation: "prepareTransition", label: "hidden", timeoutMs: 1000 });
    const screen = document.getElementById("screen");
    assert.ok(screen !== null);
    screen.textContent = "x";
    await sleep(10);
    assert.deepEqual(facts, [{ kind: "TransitionFinished", label: "hidden", outcome: "skipped" }]);
  }, scriptTransitions({}, true));
});

test("hints: added once, AlreadyPresent for one the HTML has, refused by scheme, preload needs as", async () => {
  await withPack(async ({ ask, document }) => {
    assert.deepEqual(await ask({ operation: "hint", kind: "preconnect", href: "https://cdn.example.test/", crossOrigin: true }), { kind: "Added" });
    assert.deepEqual(await ask({ operation: "hint", kind: "preconnect", href: "https://cdn.example.test", crossOrigin: true }), { kind: "AlreadyPresent" });
    assert.deepEqual(await ask({ operation: "hint", kind: "prefetch", href: "/static.json", crossOrigin: false }), { kind: "AlreadyPresent" });
    assert.deepEqual(await ask({ operation: "hint", kind: "preload", href: "/font.woff2", as: "font", crossOrigin: true }), { kind: "Added" });
    assert.deepEqual(await ask({ operation: "hint", kind: "preload", href: "/x.js", crossOrigin: false }), { kind: "InvalidRequest", problem: "preload needs as" });
    assert.deepEqual(await ask({ operation: "hint", kind: "prefetch", href: "data:text/plain,x", crossOrigin: false }), { kind: "InvalidUrl", scheme: "data" });
    const links = Array.from(document.head.querySelectorAll("link"), (link) => `${link.rel} ${link.getAttribute("href") ?? ""} ${link.getAttribute("as") ?? ""} ${link.getAttribute("crossorigin") ?? "-"}`);
    assert.deepEqual(links, ["prefetch /static.json  -", "preconnect https://cdn.example.test/  anonymous", "preload http://localhost/font.woff2 font anonymous"]);
  }, (document) => {
    const link = document.createElement("link");
    link.rel = "prefetch";
    link.href = "/static.json";
    document.head.append(link);
    const view = document.defaultView;
    assert.ok(view !== null);
    // jsdom does not implement relList.supports for <link>; a browser does.
    Reflect.set(view.DOMTokenList.prototype, "supports", () => true);
  });
});

test("a rel the browser does not support is Unsupported", async () => {
  await withPack(async ({ ask }) => {
    assert.deepEqual(await ask({ operation: "hint", kind: "modulepreload", href: "/m.js", crossOrigin: false }), { kind: "Unsupported" });
  }, (document) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    Reflect.set(view.DOMTokenList.prototype, "supports", (token: string) => token !== "modulepreload");
  });
});

test("the presentation pack passes the shared provider conformance suite", async () => {
  assert.equal(PRESENTATION_CAPABILITY.id, "limen.presentation");
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await runProviderConformance(presentationCapability(), {
      document,
      decodeResult: decodePresentationResult,
      valid: [{ name: "prepare", payload: { operation: "prepareTransition", label: "a", timeoutMs: 10 } }],
      malformed: [
        { name: "unknown kind", payload: { operation: "hint", kind: "prerender", href: "/", crossOrigin: false } },
        { name: "no timeout", payload: { operation: "prepareTransition", label: "a" } },
      ],
      cancellable: { name: "prepare", payload: { operation: "prepareTransition", label: "a", timeoutMs: 10 } },
    }), []);
  });
});
