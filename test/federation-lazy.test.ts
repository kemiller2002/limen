// Route/workflow-driven lazy federation loading (kemiller2002/limen#33,
// LCP-024): a route or workflow asks for a module, its dependencies start
// first, failures stay isolated, a released module is restored from its
// snapshot deterministically, and nothing is retried unless asked — including
// through the real kernel, where the engine loads on LocationChanged.

import assert from "node:assert/strict";
import test from "node:test";
import {
  FEDERATION_PROTOCOL_VERSION, ModuleFederation, createLazyFederation, routeMatches,
  type FederatedModuleTransport, type FederationDiagnosticEvent, type JsonValue, type ModuleId, type ModuleManifest,
} from "../dist/federation.js";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { BrowserToEngineMessage, EngineTransport } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const id = (value: string): ModuleId => value as ModuleId;
const manifest = (moduleId: string, routes: readonly string[], dependencies: readonly string[] = []): ModuleManifest => ({
  id: id(moduleId), version: "1.0.0", federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
  accepts: [], emits: [], capabilitiesRequired: [], dependencies: dependencies.map(id), routes,
});

type Module = FederatedModuleTransport & { readonly log: string[]; failActivate: boolean; state: JsonValue | null };

const module = (moduleId: string, routes: readonly string[], dependencies: readonly string[] = [], journal: string[] = []): Module => {
  const log: string[] = [];
  const record = (step: string): void => { log.push(step); journal.push(`${moduleId}:${step}`); };
  const self: Module = {
    manifest: manifest(moduleId, routes, dependencies), log, failActivate: false, state: null,
    load: async () => record("load"),
    initialize: async () => record("initialize"),
    restore: async (snapshot) => { self.state = snapshot; record(`restore ${JSON.stringify(snapshot)}`); },
    activate: async () => { record("activate"); if (self.failActivate) throw new Error("activation failed: secret"); },
    dispatch: async () => ({ emitted: [] }),
    suspend: async () => record("suspend"),
    snapshot: async () => { record("snapshot"); return self.state ?? { visits: 1 }; },
    unload: async () => record("unload"),
  };
  return self;
};

test("routes match exactly, or as a prefix ending in /*", () => {
  assert.deepEqual([["/orders", "/orders"], ["/orders/*", "/orders"], ["/orders/*", "/orders/42"], ["/orders/*", "/ordersx"], ["/orders", "/orders/42"]].map(([route, path]) => routeMatches(route ?? "", path ?? "")), [true, true, true, false, false]);
});

test("nothing loads at startup; a route loads its module, dependencies first, in order", async () => {
  const journal: string[] = [];
  const auth = module("auth", [], [], journal);
  const orders = module("orders", ["/orders/*"], ["auth"], journal);
  const reports = module("reports", ["/reports"], [], journal);
  const lazy = createLazyFederation(new ModuleFederation([orders, auth, reports]));
  assert.deepEqual([lazy.status(id("orders")), lazy.status(id("auth"))], ["idle", "idle"]);
  const outcomes = await lazy.forRoute("/orders/42");
  assert.deepEqual(outcomes, [{ kind: "Ready", moduleId: id("orders") }]);
  assert.deepEqual(journal.filter((line) => line.endsWith("activate")), ["auth:activate", "orders:activate"]);
  assert.equal(journal.indexOf("auth:activate") < journal.indexOf("orders:load"), true, "the dependency is active before the dependent loads");
  assert.deepEqual(reports.log, [], "an unrelated module stays unloaded");
  assert.deepEqual(await lazy.forRoute("/nowhere"), []);
});

test("concurrent requests share one load; a ready module is not started twice", async () => {
  const orders = module("orders", ["/orders"]);
  const lazy = createLazyFederation(new ModuleFederation([orders]));
  const [first, second] = await Promise.all([lazy.ensure(id("orders")), lazy.ensure(id("orders"))]);
  assert.deepEqual([first, second], [{ kind: "Ready", moduleId: id("orders") }, { kind: "Ready", moduleId: id("orders") }]);
  assert.deepEqual(await lazy.ensure(id("orders")), { kind: "Ready", moduleId: id("orders") });
  assert.equal(orders.log.filter((step) => step === "load").length, 1);
});

test("a failed dependency faults alone and blocks only its dependents; an independent module stays active", async () => {
  const events: FederationDiagnosticEvent[] = [];
  const auth = module("auth", []);
  auth.failActivate = true;
  const orders = module("orders", ["/orders"], ["auth"]);
  const reports = module("reports", ["/reports"]);
  const lazy = createLazyFederation(new ModuleFederation([auth, orders, reports], { diagnostics: { report: (event) => events.push(event) } }));
  assert.deepEqual(await lazy.forRoute("/reports"), [{ kind: "Ready", moduleId: id("reports") }]);
  assert.deepEqual(await lazy.forRoute("/orders"), [{ kind: "Blocked", moduleId: id("orders"), dependency: id("auth") }]);
  assert.deepEqual([lazy.status(id("auth")), lazy.status(id("orders")), lazy.status(id("reports"))], ["faulted", "idle", "ready"]);
  assert.deepEqual(orders.log, [], "a blocked module never loads");
  assert.ok(!JSON.stringify(events).includes("secret"));
});

test("a faulted module is never retried by asking again; only retry() resets and starts it", async () => {
  const flaky = module("flaky", ["/flaky"]);
  flaky.failActivate = true;
  const lazy = createLazyFederation(new ModuleFederation([flaky]));
  assert.deepEqual(await lazy.ensure(id("flaky")), { kind: "Faulted", moduleId: id("flaky") });
  assert.deepEqual(await lazy.forRoute("/flaky"), [{ kind: "Faulted", moduleId: id("flaky") }]);
  assert.equal(flaky.log.filter((step) => step === "activate").length, 1, "asking again did not retry");
  flaky.failActivate = false;
  assert.deepEqual(await lazy.retry(id("flaky")), { kind: "Ready", moduleId: id("flaky") });
  assert.deepEqual(flaky.log, ["load", "initialize", "restore null", "activate", "unload", "load", "initialize", "restore null", "activate"]);
});

test("release keeps the snapshot; the next load restores exactly it; a module in use by a dependent is not released", async () => {
  const auth = module("auth", []);
  const orders = module("orders", ["/orders"], ["auth"]);
  const lazy = createLazyFederation(new ModuleFederation([auth, orders]));
  await lazy.forRoute("/orders");
  orders.state = { draft: "order 7", step: 2 };
  assert.deepEqual(await lazy.release(id("auth")), { kind: "InUse", moduleId: id("auth") });
  assert.deepEqual(await lazy.release(id("orders")), { kind: "Released", moduleId: id("orders") });
  assert.equal(lazy.status(id("orders")), "released");
  orders.state = null;
  assert.deepEqual(await lazy.forRoute("/orders"), [{ kind: "Ready", moduleId: id("orders") }]);
  assert.deepEqual(orders.state, { draft: "order 7", step: 2 }, "restored from its own snapshot");
  assert.deepEqual(await lazy.release(id("orders")), { kind: "Released", moduleId: id("orders") });
  await lazy.ensure(id("orders"));
  assert.deepEqual(orders.log.filter((step) => step.startsWith("restore")), ["restore null", "restore {\"draft\":\"order 7\",\"step\":2}", "restore {\"draft\":\"order 7\",\"step\":2}"], "deterministic: the same snapshot restores the same state");
  assert.deepEqual(await lazy.release(id("nope")), { kind: "NotReady", moduleId: id("nope") });
});

test("through the real kernel: an engine loads a route's module when LocationChanged arrives", async () => {
  const orders = module("orders", ["/orders/*"]);
  const lazy = createLazyFederation(new ModuleFederation([orders]));
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      const path = message.kind === "Initialize" || message.kind === "LocationChanged" ? message.location.path : undefined;
      const outcomes = path === undefined ? [] : await lazy.forRoute(path);
      return { view: { loaded: outcomes.map((outcome) => `${outcome.moduleId}:${outcome.kind}`).join() || "none" }, effects: [], cancellations: [] };
    },
  };
  await withDom(`<p id="loaded" data-text="loaded"></p>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal(document.getElementById("loaded")?.textContent, "none", "nothing loads for the start route");
    const window = document.defaultView;
    assert.ok(window !== null);
    window.history.pushState(null, "", "/orders/42");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.equal(document.getElementById("loaded")?.textContent, "orders:Ready");
    assert.equal(lazy.status(id("orders")), "ready");
  });
});
