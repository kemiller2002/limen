import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { JSDOM } from "jsdom";

const SITE = new URL("../dist-site/", import.meta.url);
const built = existsSync(new URL("index.html", SITE));

async function pages(): Promise<readonly string[]> {
  const entries = await readdir(SITE);
  return entries.filter((name) => name.endsWith(".html")).sort();
}

const load = async (name: string): Promise<Document> =>
  new JSDOM(await readFile(new URL(name, SITE), "utf8")).window.document;

async function source(name: string): Promise<string> {
  return readFile(new URL(name, import.meta.url), "utf8");
}

function topLevelBindings(document: Document): {
  scalars: Set<string>;
  conditions: Set<string>;
  lists: Set<string>;
} {
  const scalars = new Set<string>();
  const conditions = new Set<string>();
  const lists = new Set<string>();

  for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
    const text = el.getAttribute("data-text");
    if (text) scalars.add(text);

    const iff = el.getAttribute("data-if");
    if (iff) conditions.add(iff);

    const each = el.getAttribute("data-each");
    if (each) lists.add(each);

    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-bind-")) scalars.add(attr.value);
    }
  }

  return { scalars, conditions, lists };
}

function fsharpProjectionKeys(engine: string): Set<string> {
  const projection = engine.slice(engine.indexOf("let project state"));
  return new Set(
    Array.from(projection.matchAll(/"([^"]+)",\s+V(?:String|Number|Bool|Items)/g), (match) => match[1] ?? ""),
  );
}

function fsharpEventNames(engine: string): Set<string> {
  const start = engine.indexOf("let eventToCommand");
  const end = engine.indexOf("let private deploymentEffect", start);
  const vocabulary = engine.slice(start, end);

  return new Set(
    Array.from(vocabulary.matchAll(/\|\s+"([^"]+)"\s+->/g), (match) => match[1] ?? ""),
  );
}

function markupEvents(html: string): Set<string> {
  return new Set(
    Array.from(html.matchAll(/data-event="([^"]+)"/g), (match) => match[1] ?? ""),
  );
}

test("the site builds every expected page", { skip: built ? false : "run `npm run build:site` first" }, async () => {
  assert.deepEqual(await pages(), [
    "agents.html", "architecture.html", "demos.html", "docs.html", "evidence.html", "federation.html", "index.html",
  ]);
});

test("every page has one h1, a nav current marker, and a skip-link target", { skip: built ? false : "not built" }, async () => {
  for (const name of await pages()) {
    const document = await load(name);
    assert.equal(document.querySelectorAll("h1").length, 1, `${name}: exactly one h1`);
    assert.equal(document.querySelectorAll('nav a[aria-current="page"]').length, 1, `${name}: nav current`);
    assert.ok(document.querySelector("#main-content"), `${name}: skip target`);
    assert.equal(document.querySelector("a.skip-link")?.getAttribute("href"), "#main-content", `${name}: skip link`);
  }
});

test("the build injects the real package version", { skip: built ? false : "not built" }, async () => {
  const pkg = JSON.parse(await source("../package.json")) as { version: string };
  const document = await load("index.html");
  assert.match(document.querySelector(".footer-note")?.textContent ?? "", new RegExp(`Limen ${pkg.version.replace(/\./g, "\\.")}`));
});

test("application pages load Limen plus the WASM transport; prose pages do not", { skip: built ? false : "not built" }, async () => {
  for (const name of ["index.html", "demos.html"]) {
    const document = await load(name);
    assert.equal(document.querySelectorAll('script[type="module"][src="./site/app/main.js"]').length, 1, `${name}: app script`);
  }

  const federation = await load("federation.html");
  assert.equal(
    federation.querySelectorAll('script[type="module"][src="./site/app/federation-proof.js"]').length,
    1,
    "federation.html: federation proof script",
  );
  assert.equal(federation.querySelectorAll('script[src*="main.js"]').length, 0, "federation.html: no main app script");

  for (const name of ["architecture.html", "evidence.html", "agents.html", "docs.html"]) {
    const document = await load(name);
    assert.equal(document.querySelectorAll('script[src*="main.js"]').length, 0, `${name}: prose page should not load app`);
  }
});

test("the deployed site contains a real WebAssembly runtime and no legacy TypeScript engine", { skip: built ? false : "not built" }, async () => {
  assert.ok(existsSync(new URL("wasm/_framework/dotnet.js", SITE)), "dotnet.js must be published");
  assert.ok(existsSync(new URL("site/app/wasm-engine-transport.js", SITE)), "WASM transport must be published");
  assert.ok(!existsSync(new URL("site/app/engine.js", SITE)), "TypeScript site engine must not be published");

  for (const path of ["wasm/_framework/", "federation/source/_framework/", "federation/target/_framework/"]) {
    const framework = await readdir(new URL(path, SITE), { recursive: true });
    assert.ok(framework.some((name) => String(name).endsWith(".wasm")), path + " must contain WebAssembly");
  }

  assert.ok(existsSync(new URL("site/app/federated-wasm-module-transport.js", SITE)), "federated transport must be published");
  assert.ok(existsSync(new URL("site/app/federation-proof.js", SITE)), "federation proof shell must be published");
});

test("browser-side site code contains mechanics, not release or policy decisions", async () => {
  const main = await source("../site/app/main.ts");
  const transport = await source("../site/app/wasm-engine-transport.ts");
  const browserCode = main + "\n" + transport;

  for (const forbidden of [
    "ApproveRelease",
    "ReconciliationRequired",
    "TestsPassed",
    "StartPolicyA",
    "placementTasks",
    "releaseObligations",
  ]) {
    assert.ok(!browserCode.includes(forbidden), `browser-side site code leaked application concept: ${forbidden}`);
  }

  assert.match(main, /BrowserKernel/);
  assert.match(main, /WasmSiteTransport/);
  assert.match(transport, /JSON\.stringify\(message\)/);
  assert.match(transport, /JSON\.parse\(json\)/);
});

test("every top-level binding is projected by the F# engine", { skip: built ? false : "not built" }, async () => {
  const engine = await source("../site/fsharp/Limen.Site.Engine/Engine.fs");
  const projected = fsharpProjectionKeys(engine);

  for (const name of ["index.html", "demos.html"]) {
    const document = await load(name);
    const { scalars, conditions, lists } = topLevelBindings(document);

    for (const key of [...scalars, ...conditions, ...lists]) {
      assert.ok(projected.has(key), `${name}: binding "${key}" is not projected by the F# engine`);
    }
  }
});

test("every markup event is in the F# engine command vocabulary", { skip: built ? false : "not built" }, async () => {
  const engine = await source("../site/fsharp/Limen.Site.Engine/Engine.fs");
  const known = fsharpEventNames(engine);

  for (const name of ["index.html", "demos.html"]) {
    const html = await readFile(new URL(name, SITE), "utf8");
    for (const event of markupEvents(html)) {
      assert.ok(known.has(event), `${name}: data-event="${event}" is not handled by F# eventToCommand`);
    }
  }
});

test("the challenging demos are actually present", { skip: built ? false : "not built" }, async () => {
  const demos = await readFile(new URL("demos.html", SITE), "utf8");

  assert.match(demos, /Release gate \+ ambiguous deployment/);
  assert.match(demos, /Make stale evidence arrive last/);
  assert.match(demos, /Where does this decision belong/);
  assert.match(demos, /Protocol change/);

  const engine = await source("../site/fsharp/Limen.Site.Engine/Engine.fs");
  assert.match(engine, /ReconciliationRequired/);
  assert.match(engine, /StaleDiscarded/);
  assert.match(engine, /placementTasks/);
  assert.ok((engine.match(/Prompt =/g) ?? []).length >= 10, "placement challenge should contain at least ten tasks");
});


test("federation proof keeps domain transition meaning inside F#", async () => {
  const transport = await source("../site/app/federated-wasm-module-transport.ts");
  const shell = await source("../site/app/federation-proof.ts");
  const sourceEngine = await source("../site/fsharp/federation/Limen.Federation.Source.Engine/Federation.fs");
  const targetEngine = await source("../site/fsharp/federation/Limen.Federation.Target.Engine/Federation.fs");

  for (const forbidden of ["acceptedValue", "state-version-mismatch", "Value + 1", "AcceptedCount"]) {
    assert.ok(!transport.includes(forbidden), "generic transport leaked domain concept: " + forbidden);
    assert.ok(!shell.includes(forbidden), "federation shell leaked domain concept: " + forbidden);
  }

  assert.match(sourceEngine, /type AcceptedPayload/);
  assert.match(targetEngine, /type TransitionRequest/);
  assert.match(targetEngine, /request\.Value \+ 1/);
  assert.match(targetEngine, /ExpectedStateVersion <> state\.StateVersion/);
});

test("federation proof uses two independent F# engine and WASM projects", async () => {
  const sourceHost = await source("../site/fsharp/federation/Limen.Federation.Source.Wasm/Limen.Federation.Source.Wasm.csproj");
  const targetHost = await source("../site/fsharp/federation/Limen.Federation.Target.Wasm/Limen.Federation.Target.Wasm.csproj");

  assert.match(sourceHost, /Limen\.Federation\.Source\.Engine/);
  assert.ok(!sourceHost.includes("Limen.Federation.Target.Engine"));
  assert.match(targetHost, /Limen\.Federation\.Target\.Engine/);
  assert.ok(!targetHost.includes("Limen.Federation.Source.Engine"));

  const proof = await source("../site/app/federation-proof.ts");
  assert.match(proof, /source\.runtimeId === target\.runtimeId/);
  assert.match(proof, /ModuleFederation/);
});
