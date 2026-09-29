// The minimal F#, C# and Rust WebAssembly consumers use Limen Core without
// optional subsystems (kemiller2002/limen#59). `npm run smoke:guests` proves
// they work in Chromium; this proves what they are built from:
//
//   - their host page (guests/minimal/host) loads Core and the WASM host
//     adapters that run an engine, and nothing else: no federation, no
//     reference engine, no capability pack, no tooling;
//   - it registers no capability pack with the kernel;
//   - no minimal engine requests an optional capability — each treats a
//     capability result or fact as unexpected.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, normalize, relative } from "node:path";
import test from "node:test";
import { moduleClosure, parseCoreManifest } from "../tools/guardrails/core.ts";
import { parseLayerMap, placementOf } from "../tools/guardrails/layers.ts";

const ROOT = join(import.meta.dirname, "..");
const manifest = parseCoreManifest(JSON.parse(await readFile(join(ROOT, "architecture/core.json"), "utf8")) as unknown);
const map = parseLayerMap(JSON.parse(await readFile(join(ROOT, "architecture/layers.json"), "utf8")) as unknown);
const HOST = "guests/minimal/host";

// The host imports the emitted package (../../../dist/x.js); follow it into
// the source it is emitted from (src/x.ts), so this needs no build.
const resolve = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const target = relative(ROOT, normalize(join(ROOT, dirname(from), specifier))).split("\\").join("/");
  return target.startsWith("dist/") ? target.replace(/^dist\//, "src/").replace(/\.js$/, ".ts") : target.replace(/\.js$/, ".ts");
};

const sources = new Map<string, string>();
const closureOf = async (entry: string): Promise<readonly string[]> => {
  const step = async (): Promise<readonly string[]> => {
    const closure = moduleClosure([entry], (path) => sources.get(path), resolve);
    const unread = closure.filter((path) => !sources.has(path));
    if (unread.length === 0) return closure;
    // A runtime the build places beside the host (_framework/dotnet.js) is not source: read as empty.
    await Promise.all(unread.map(async (path) => { sources.set(path, await readFile(join(ROOT, path), "utf8").catch(() => "")); }));
    return step();
  };
  return step();
};

for (const entry of [`${HOST}/main.ts`, `${HOST}/worker.ts`]) {
  test(`${entry} loads Core and the WASM host adapters only`, async () => {
    const library = (await closureOf(entry)).filter((path) => path.startsWith("src/"));
    const layers = [...new Set(library.map((path) => placementOf(map, path)?.layer.name ?? `(no layer: ${path})`))].sort();
    const allowed = new Set([...manifest.coreLayers, "host-adapter"]);
    assert.deepEqual(layers.filter((layer) => !allowed.has(layer)), [], library.join(", "));
    assert.ok(library.some((path) => path.startsWith("src/hosts/")), "the host adapter is the one optional layer, and it is used");
  });
}

test("the minimal host registers no capability pack", async () => {
  const main = await readFile(join(ROOT, HOST, "main.ts"), "utf8");
  assert.doesNotMatch(main, /capabilities\s*:/);
  assert.doesNotMatch(main, /\/capabilities\//);
});

test("no minimal engine requests an optional capability", async () => {
  const engines = [
    "guests/minimal/fsharp/Limen.Minimal.Engine/Engine.fs",
    "guests/minimal/csharp/Limen.Minimal.Engine/Engine.cs",
    "guests/minimal/rust/limen-minimal/src/lib.rs",
  ];
  for (const path of engines) {
    const source = await readFile(join(ROOT, path), "utf8");
    assert.doesNotMatch(source, /EffectRequest(\.|::)Capability\b|CapabilityEffectRequest\s*\(/, `${path} requests an optional capability`);
    assert.match(source, /unexpected (capability result|fact)/, `${path} no longer treats capability traffic as unexpected`);
  }
});
