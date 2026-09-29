// The optional fatal-fallback host (kemiller2002/limen#50, LCP-032), against
// the issue's reference tests: start failure, dispatch failure, a malformed
// projection, explicit restart, repeated restart failure, redaction, a
// domain failure that must not trigger it, and federation's partial
// availability, unchanged. The same host is exercised in Chromium in
// test/browser/packs/core-fallback/.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { startWithFallback, type Health, type FallbackHost } from "../dist/hosts/fallback.js";
import { FEDERATION_PROTOCOL_VERSION, ModuleFederation, type FederatedModuleTransport, type ModuleId, type ModuleManifest } from "../dist/federation.js";
import type { BrowserToEngineMessage, EngineTransport, ViewState } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const SECRET = "card 4111-1111-1111-1111 for ada@example.test";

const PAGE = `<main id="app"><h1 data-text="title">Loading…</h1><button id="go" data-event="go">Go</button></main>`;

type Engine = { readonly transport: EngineTransport; readonly heard: string[] };

// An engine that behaves until told otherwise.
const engine = (behaviour: { failStart?: boolean; failInitialize?: boolean; failOn?: string; view?: (name: string) => ViewState } = {}): Engine => {
  const heard: string[] = [];
  return {
    heard,
    transport: {
      start: async () => { if (behaviour.failStart === true) throw new TypeError(`cannot load engine: ${SECRET}`); },
      dispatch: async (message: BrowserToEngineMessage) => {
        const name = message.kind === "Event" ? message.event.name : message.kind;
        heard.push(name);
        if (message.kind === "Initialize" && behaviour.failInitialize === true) throw new RangeError(`bad init ${SECRET}`);
        if (message.kind === "Event" && message.event.name === behaviour.failOn) throw new TypeError(`engine crashed on ${SECRET}`);
        return { view: behaviour.view?.(name) ?? { title: `after ${name}` }, effects: [], cancellations: [] };
      },
    },
  };
};

type Run = { readonly host: FallbackHost; readonly healths: Health[]; readonly document: Document; readonly reloads: number[] };

const withHost = async (engines: readonly Engine[], act: (run: Run) => Promise<void>, maxRestarts?: number): Promise<void> => {
  await withDom(PAGE, async (document) => {
    const healths: Health[] = [];
    const reloads: number[] = [];
    const queue = [...engines];
    const host = await startWithFallback({
      document,
      connect: (guard) => new BrowserKernel(guard((queue.shift() ?? engines.at(-1) ?? engine()).transport), document),
      onHealth: (health) => healths.push(health),
      reload: () => reloads.push(1),
      ...(maxRestarts !== undefined ? { maxRestarts } : {}),
    });
    await act({ host, healths, document, reloads });
  });
};

const surface = (document: Document): HTMLElement | null => document.querySelector("[data-limen-fallback]");
const texts = (document: Document): string => surface(document)?.textContent ?? "";

test("start failure: a deterministic fallback with a stable, redacted id; the page is covered, not silently dead", async () => {
  await withHost([engine({ failStart: true })], async ({ host, healths, document }) => {
    assert.deepEqual(host.health(), { kind: "unavailable", attempt: 1, id: "LIMEN-START-TypeError", phase: "start", restartable: true });
    assert.deepEqual(healths.map((health) => health.kind), ["starting", "unavailable"]);
    assert.equal(surface(document)?.getAttribute("role"), "alert");
    assert.match(texts(document), /Something went wrong.*Error ID: LIMEN-START-TypeError.*Try again.*Reload the page/);
    assert.equal(document.getElementById("app")?.hasAttribute("inert"), true, "the page under the surface cannot be operated");
    assert.equal(document.activeElement?.textContent, "Try again", "focus moves to the surface");
  });
});

test("an Initialize failure is its own phase", async () => {
  await withHost([engine({ failInitialize: true })], async ({ host }) => {
    assert.equal(host.health().kind === "unavailable" && host.health().id, "LIMEN-INITIALIZE-RangeError");
  });
});

test("a dispatch failure while running: the kernel stops, the last good view is preserved under the surface", async () => {
  const crashing = engine({ failOn: "go" });
  await withHost([crashing], async ({ host, document }) => {
    assert.equal(host.health().kind, "available");
    assert.equal(document.querySelector("h1")?.textContent, "after Initialize");
    document.getElementById("go")?.click();
    await sleep(10);
    assert.deepEqual(host.health(), { kind: "unavailable", attempt: 1, id: "LIMEN-DISPATCH-TypeError", phase: "dispatch", restartable: true });
    assert.equal(document.querySelector("h1")?.textContent, "after Initialize", "preserved, not blanked");
    document.getElementById("go")?.click();
    await sleep(10);
    assert.deepEqual(crashing.heard, ["Initialize", "go"], "nothing more reaches an engine whose state is unknown");
  });
});

test("a malformed projection is not a fatal fault: nothing is applied, and the host stays available", async () => {
  await withHost([engine({ view: (name) => (name === "go" ? { title: { not: "scalar" } as never } : { title: "fine" }) })], async ({ host, document }) => {
    document.getElementById("go")?.click();
    await sleep(10);
    assert.equal(document.querySelector("h1")?.textContent, "fine");
    assert.equal(host.health().kind, "available");
    assert.equal(surface(document), null);
  });
});

test("a domain failure is engine state: the engine projects it, and the fatal path is never taken", async () => {
  await withHost([engine({ view: (name) => ({ title: name === "go" ? "Payment declined — try another card" : "Pay" }) })], async ({ host, healths, document }) => {
    document.getElementById("go")?.click();
    await sleep(10);
    assert.equal(document.querySelector("h1")?.textContent, "Payment declined — try another card");
    assert.deepEqual(healths.map((health) => health.kind), ["starting", "available"]);
  });
});

test("explicit restart: the page's pre-start DOM is restored and a fresh kernel runs a fresh engine", async () => {
  const second = engine();
  await withHost([engine({ failStart: true }), second], async ({ host, healths, document }) => {
    document.querySelector<HTMLButtonElement>(".limen-fallback-restart")?.click();
    await sleep(20);
    assert.deepEqual(host.health(), { kind: "available", attempt: 2 });
    assert.deepEqual(healths.map((health) => health.kind), ["starting", "unavailable", "starting", "available"]);
    assert.equal(surface(document), null);
    assert.equal(document.getElementById("app")?.hasAttribute("inert"), false);
    document.getElementById("go")?.click();
    await sleep(10);
    assert.equal(document.querySelector("h1")?.textContent, "after go");
    assert.deepEqual(second.heard, ["Initialize", "go"]);
  });
});

test("repeated restart failure is bounded: after maxRestarts, only Reload is offered, and restart() does nothing", async () => {
  await withHost([engine({ failStart: true })], async ({ host, healths, document, reloads }) => {
    await host.restart();
    const last = await host.restart();
    assert.deepEqual(last, { kind: "unavailable", attempt: 3, id: "LIMEN-START-TypeError", phase: "start", restartable: false });
    assert.equal(document.querySelector(".limen-fallback-restart"), null);
    assert.match(texts(document), /Trying again did not help/);
    assert.deepEqual(await host.restart(), last);
    assert.equal(healths.filter((health) => health.kind === "starting").length, 3);
    document.querySelector<HTMLButtonElement>(".limen-fallback-reload")?.click();
    assert.deepEqual(reloads, [1]);
    assert.equal(document.querySelectorAll("[data-limen-fallback]").length, 1, "one surface, never stacked");
  }, 2);
});

test("redaction: no id, surface text or health event carries the exception's message", async () => {
  for (const failing of [engine({ failStart: true }), engine({ failInitialize: true })]) {
    await withHost([failing], async ({ healths, document }) => {
      assert.ok(!JSON.stringify(healths).includes("4111") && !texts(document).includes("4111") && !texts(document).includes("ada@"));
    });
  }
  // A hostile error name is not trusted either.
  await withDom(PAGE, async (document) => {
    const host = await startWithFallback({
      document,
      connect: (guard) => new BrowserKernel(guard({ start: async () => { throw Object.assign(new Error("x"), { name: `Evil ${SECRET}` }); }, dispatch: async () => ({ view: {}, effects: [], cancellations: [] }) }), document),
    });
    assert.equal(host.health().kind === "unavailable" && host.health().id, "LIMEN-START-Error");
  });
});

test("an incompatible engine and a refused binding are fatal too, each with its own id", async () => {
  await withDom(PAGE, async (document) => {
    const host = await startWithFallback({ document, connect: (guard) => new BrowserKernel(guard(engine().transport), document, undefined, { requireHandshake: true }) });
    assert.equal(host.health().kind === "unavailable" && host.health().id, "LIMEN-INCOMPATIBLE-Incompatible");
  });
  await withDom(`<a data-bind-onclick="x">x</a>`, async (document) => {
    const host = await startWithFallback({ document, connect: (guard) => new BrowserKernel(guard(engine().transport), document) });
    assert.equal(host.health().kind === "unavailable" && host.health().id, "LIMEN-BINDING-BindingError");
  });
});

test("federation: a faulted module under startAvailable stays isolated inside the engine; the host is not involved", async () => {
  const id = (value: string): ModuleId => value as ModuleId;
  const manifestOf = (moduleId: ModuleId): ModuleManifest => ({ id: moduleId, version: "1.0.0", federationProtocolVersion: FEDERATION_PROTOCOL_VERSION, accepts: [], emits: [], capabilitiesRequired: [], dependencies: [], routes: [] });
  const module = (moduleId: ModuleId, failActivate: boolean): FederatedModuleTransport => ({
    manifest: manifestOf(moduleId),
    load: async () => {}, initialize: async () => {}, restore: async () => {},
    activate: async () => { if (failActivate) throw new Error("module failed"); },
    dispatch: async () => ({ emitted: [] }), suspend: async () => {}, snapshot: async () => null, unload: async () => {},
  });
  const federation = new ModuleFederation([module(id("orders"), false), module(id("recommendations"), true)]);
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message) => {
      if (message.kind !== "Initialize") return { view: { title: "ok" }, effects: [], cancellations: [] };
      const report = await federation.startAvailable();
      return { view: { title: `active ${report.active.join()}; faulted ${report.faulted.join()}` }, effects: [], cancellations: [] };
    },
  };
  await withDom(PAGE, async (document) => {
    const host = await startWithFallback({ document, connect: (guard) => new BrowserKernel(guard(transport), document) });
    assert.equal(host.health().kind, "available");
    assert.equal(document.querySelector("h1")?.textContent, "active orders; faulted recommendations");
  });
});
