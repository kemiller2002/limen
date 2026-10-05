// The root entrypoint teaches Core only (kemiller2002/limen#61).
//
// examples/minimal is the minimal root consumer: it ships in the package,
// imports nothing but the package root, and is installed and built from a
// packed tarball by `npm run check:clean-room`. Here its transitive graph is
// proven Core-only, it is run against the real kernel, and the optional
// surfaces the root no longer exports are proven reachable — and working —
// through their explicit subpaths, imported by package name exactly as a
// consumer would.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import test from "node:test";
import { exportTargets, moduleClosure, parseCoreManifest, emittedPath } from "../tools/guardrails/core.ts";
import { exampleBody, withDom } from "./dom-helpers.ts";

const ROOT = join(import.meta.dirname, "..");
const PACKAGE = "@echelon-foundry/limen";
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(join(ROOT, path), "utf8")) as unknown;
const manifest = parseCoreManifest(await json("architecture/core.json"));
const targets = exportTargets(await json("package.json"));

const LEGACY = ["ModuleFederation", "createLazyFederation", "routeMatches", "FederationError", "FEDERATION_PROTOCOL_VERSION", "noopFederationDiagnostics", "ReferenceEngine", "project", "DirectTypeScriptTransport"];

// Resolve like a consumer: the package name through package.json exports,
// relative specifiers against the importing file.
const resolveAsConsumer = (from: string, specifier: string): string | undefined => {
  if (specifier === PACKAGE || specifier.startsWith(`${PACKAGE}/`)) {
    const target = targets[`.${specifier.slice(PACKAGE.length)}`];
    return target === undefined ? undefined : target;
  }
  return specifier.startsWith(".") ? relative(ROOT, normalize(join(ROOT, dirname(from), specifier))) : undefined;
};

const sources = new Map<string, string>();
const readAll = async (entry: string): Promise<readonly string[]> => {
  // The closure is computed synchronously over what has been read; read until
  // it stops growing.
  const step = async (): Promise<readonly string[]> => {
    const closure = moduleClosure([entry], (path) => sources.get(path), resolveAsConsumer);
    const unread = closure.filter((path) => !sources.has(path));
    if (unread.length === 0) return closure;
    await Promise.all(unread.map(async (path) => { sources.set(path, await readFile(join(ROOT, path), "utf8").catch(() => "")); }));
    return step();
  };
  return step();
};

test("the minimal root consumer's transitive graph is Core only", async () => {
  const closure = await readAll("examples/minimal/main.js");
  const core = new Set([...manifest.files.map((file) => emittedPath(file.path)), "dist/index.js"]);
  const application = closure.filter((path) => path.startsWith("examples/minimal/"));
  const library = closure.filter((path) => !path.startsWith("examples/minimal/"));
  assert.deepEqual(application, ["examples/minimal/engine.js", "examples/minimal/main.js"]);
  assert.ok(library.includes("dist/index.js") && library.includes("dist/kernel/browser-kernel.js"), library.join(", "));
  assert.deepEqual(library.filter((path) => !core.has(path)), []);
  // Named explicitly, because these are what #61 removed.
  for (const optional of ["dist/federation.js", "dist/engine/", "dist/capabilities/", "dist/capability-support/", "dist/hosts/", "dist/renderer/", "dist/tooling/"]) {
    assert.ok(!library.some((path) => path.startsWith(optional)), `the minimal consumer loads ${optional}`);
  }
});

test("the root entrypoint no longer exports federation or the reference engine", async () => {
  const root = await import(PACKAGE) as Record<string, unknown>;
  for (const name of LEGACY) assert.equal(root[name], undefined, `root still exports ${name}`);
  assert.equal(typeof root.BrowserKernel, "function");
  assert.equal(typeof root.defineCapability, "function");
  assert.equal(typeof root.verifyHandshake, "function");
  assert.equal(typeof root.answerHandshake, "function");
});

test("the minimal consumer's counter works through the root entrypoint alone", async () => {
  const { BrowserKernel } = await import(PACKAGE) as typeof import("../dist/index.js");
  const { createCounterTransport } = await import("../examples/minimal/engine.js") as { createCounterTransport: () => import("../dist/protocol.js").EngineTransport };
  await withDom(await exampleBody("minimal"), async (document) => {
    await new BrowserKernel(createCounterTransport(), document).start();
    const add = document.querySelector<HTMLButtonElement>('[data-event="increment"]');
    const reset = document.querySelector<HTMLButtonElement>('[data-event="reset"]');
    const count = document.querySelector('[data-text="count"]');
    assert.equal(count?.textContent, "0");
    assert.equal(reset?.disabled, true);
    add?.click();
    add?.click();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    assert.equal(count?.textContent, "2");
    assert.equal(reset?.disabled, false);
  });
});

test("federation works through its explicit ./federation import", async () => {
  const federation = await import(`${PACKAGE}/federation`) as typeof import("../dist/federation.js");
  const id = "counter" as import("../dist/federation.js").ModuleId;
  const log: string[] = [];
  const transport: import("../dist/federation.js").FederatedModuleTransport = {
    manifest: { id, version: "1.0.0", federationProtocolVersion: federation.FEDERATION_PROTOCOL_VERSION, accepts: [], emits: [], capabilitiesRequired: [], dependencies: [], routes: [] },
    load: async () => { log.push("load"); },
    initialize: async () => { log.push("initialize"); },
    restore: async () => { log.push("restore"); },
    activate: async () => { log.push("activate"); },
    dispatch: async () => ({ emitted: [] }),
    suspend: async () => { log.push("suspend"); },
    snapshot: async () => null,
    unload: async () => { log.push("unload"); },
  };
  const host = new federation.ModuleFederation([transport]);
  await host.start(id);
  assert.equal(host.state(id), "Active");
  assert.deepEqual(log, ["load", "initialize", "restore", "activate"]);
  assert.equal(typeof federation.createLazyFederation, "function");
});

test("the reference engine works through its explicit ./reference-engine import", async () => {
  const reference = await import(`${PACKAGE}/reference-engine`) as typeof import("../dist/engine/index.js");
  const transport = new reference.DirectTypeScriptTransport();
  await transport.start();
  const location = { origin: "https://example.test", path: "/", query: "", hash: "" };
  const first = await transport.dispatch({ kind: "Initialize", protocolVersion: 1, capabilities: ["Http"], location });
  assert.equal(typeof first.view, "object");
  assert.equal(typeof reference.ReferenceEngine, "function");
  assert.equal(typeof reference.project, "function");
  assert.deepEqual(reference.project(reference.initialState()), first.view);
});
