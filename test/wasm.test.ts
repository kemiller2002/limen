// The F# engine, on WebAssembly, driven through the real BrowserKernel.
//
// Two things are proved here, and neither was provable before this engine
// existed:
//
//   1. The protocol survives a round trip through a codec. docs/17 said
//      plainly that "nothing currently proves the protocol survives a round
//      trip through a codec" — the types made it likely, which is not the same
//      as having tested it. Every assertion below crosses JSON in both
//      directions through real WebAssembly.
//
//   2. The two engines agree. Shipping a TypeScript fallback alongside an F#
//      engine is exactly the Uncoordinated Duplication that SDE's
//      BOUNDARY-PRESERVATION warns about: one semantic decision, two
//      implementations, nothing requiring them to match. This file is the
//      mechanism that requires it.
//
// The module is hosted by Node, not a browser. `dotnet.js` supports both, so
// this runs in the ordinary suite; real-browser behaviour is verified
// separately against Chromium.
import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { existsSync } from "node:fs";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { BrowserToEngineMessage, EngineToBrowserMessage, EngineTransport, ViewState } from "../dist/protocol.js";
import { createSiteTransport } from "../site/app/engine.ts";
import { withDom } from "./dom-helpers.ts";

const BUNDLE = new URL("../site/wasm/_framework/dotnet.js", import.meta.url);
const built = existsSync(BUNDLE);

// A missing bundle must report as skipped, never as "0 tests" — a check that
// did not run must not look like one that passed.
if (!built) {
  test("the F# WebAssembly engine was not exercised", { skip: `no bundle at ${BUNDLE.pathname} — run \`npm run build:wasm\`` }, () => {});
}

type WasmModule = {
  readonly Dispatch: (message: string) => string;
  readonly Reset: () => void;
};

/**
 * Loads the module once for the whole file. Instantiating a .NET runtime is
 * the expensive part; the engine's own state is reset between tests instead.
 */
let loaded: Promise<WasmModule> | null = null;
function wasmModule(): Promise<WasmModule> {
  loaded ??= (async () => {
    const { dotnet } = (await import(BUNDLE.href)) as { dotnet: { create: () => Promise<{
      getAssemblyExports: (name: string) => Promise<{ Limen: { Host: { Interop: WasmModule } } }>;
      getConfig: () => { mainAssemblyName: string };
    }> } };
    const runtime = await dotnet.create();
    const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
    return exports.Limen.Host.Interop;
  })();
  return loaded;
}

/** The same transport the site uses, minus the browser-only module loading. */
async function wasmTransport(): Promise<EngineTransport> {
  const engine = await wasmModule();
  engine.Reset();
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      return JSON.parse(engine.Dispatch(JSON.stringify(message))) as EngineToBrowserMessage;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

describe("the F# engine on WebAssembly", { skip: built ? false : "the wasm bundle has not been built" }, () => {
  test("a message crosses into WebAssembly and a complete projection comes back", async () => {
    const transport = await wasmTransport();
    const reply = await transport.dispatch({ kind: "Initialize", protocolVersion: 1, capabilities: ["Http", "Storage"] });

    assert.equal(reply.view["counter"], 0);
    assert.equal(reply.view["resetDisabled"], true);
    assert.deepEqual(reply.effects, []);
    assert.deepEqual(reply.cancellations, []);
  });

  test("the unmodified kernel drives it, and cannot tell the difference", async () => {
    // The whole claim, in one test: this is the published BrowserKernel, not a
    // subclass and not a variant, bound to real markup, with an F# engine
    // behind it.
    await withDom(`<p data-text="counter"></p><button data-event="increment"></button>`, async (document) => {
      await new BrowserKernel(await wasmTransport(), document).start();
      assert.equal(document.querySelector("p")!.textContent, "0");

      document.querySelector("button")!.click();
      await flush();
      assert.equal(document.querySelector("p")!.textContent, "1");
    });
  });

  test("an effect requested by F# arrives in the shape the kernel executes", async () => {
    const transport = await wasmTransport();
    await transport.dispatch({ kind: "Initialize", protocolVersion: 1, capabilities: ["Http", "Storage"] });
    const reply = await transport.dispatch({ kind: "Event", event: { kind: "Event", name: "loadSuccess" } });

    assert.equal(reply.effects.length, 1);
    const effect = reply.effects[0]!;
    assert.equal(effect.kind, "Http");
    // Not a hand-checked shape: this is the type the kernel actually consumes.
    if (effect.kind !== "Http") throw new Error("unreachable");
    assert.equal(effect.method, "GET");
    assert.equal(effect.url, "./demo/customers.json");
    assert.ok(effect.timeoutMs > 0);
    assert.ok(effect.correlationId.length > 0);
  });

  test("an effect result crosses back in and is folded into state", async () => {
    const transport = await wasmTransport();
    const started = await transport.dispatch({ kind: "Event", event: { kind: "Event", name: "loadSuccess" } });
    const effect = started.effects[0]!;

    const reply = await transport.dispatch({
      kind: "EffectResult",
      result: { kind: "HttpResult", correlationId: effect.correlationId, outcome: { kind: "Success", status: 200, body: [1, 2, 3] } },
    });
    assert.equal(reply.view["loadState"], "Loaded");
    assert.equal(reply.view["loadMessage"], "Loaded 3 record(s).");
  });

  test("a malformed reply from the engine surfaces as a bridge error, not a frozen page", async () => {
    const engine = await wasmModule();
    engine.Reset();
    const broken: EngineTransport = {
      async start(): Promise<void> {},
      async dispatch(): Promise<EngineToBrowserMessage> {
        // What the engine does when it cannot decode a message: it throws, and
        // the kernel's own error boundary takes it from there.
        return JSON.parse(engine.Dispatch("{ not a message")) as EngineToBrowserMessage;
      },
    };
    const events: string[] = [];
    await withDom(`<p data-text="counter"></p>`, async (document) => {
      await new BrowserKernel(broken, document, { report: (event) => { events.push(event.kind); } }).start();
      assert.ok(events.includes("BridgeError"), "the kernel reported the failure");
      assert.equal(document.querySelector("p")!.textContent, "", "and left the DOM untouched");
    });
  });
});

// ---------------------------------------------------------------------------
// Agreement between the two engines
// ---------------------------------------------------------------------------

/** One sequence, exercising every demo the site has. */
const SCRIPT: readonly BrowserToEngineMessage[] = [
  { kind: "Initialize", protocolVersion: 1, capabilities: ["Http", "Storage", "Clipboard"] },
  { kind: "Event", event: { kind: "Event", name: "increment" } },
  { kind: "Event", event: { kind: "Event", name: "increment" } },
  { kind: "Event", event: { kind: "Event", name: "decrement" } },
  { kind: "Event", event: { kind: "Event", name: "toggleSaving" } },
  { kind: "Event", event: { kind: "Event", name: "toggleError" } },
  { kind: "Event", event: { kind: "Event", name: "advanceSave" } },
  { kind: "Event", event: { kind: "Event", name: "advanceSave" } },
  { kind: "Event", event: { kind: "Event", name: "failSave" } },
  { kind: "Event", event: { kind: "Event", name: "pick", key: "engine" } },
  { kind: "Event", event: { kind: "Event", name: "nextTask" } },
  { kind: "Event", event: { kind: "Event", name: "pick", key: "css" } },
  { kind: "Event", event: { kind: "Event", name: "notAnEvent" } },
];

/** Keys whose values are allowed to differ, with the reason stated. */
const NOT_COMPARED = new Set<string>([
  // The trace carries a correlation id minted independently by each engine,
  // and a sequence bound that each caps at its own limit. The *behaviour*
  // being compared is the projection the DOM binds, not the log of it.
  "trace",
  "traceCount",
  "hasTrace",
  "traceEmpty",
]);

const comparable = (view: ViewState): ViewState =>
  Object.fromEntries(Object.entries(view).filter(([key]) => !NOT_COMPARED.has(key)));

/**
 * One step's observable result: a projection, or a refusal.
 *
 * Refusing an unrecognized event is behaviour, not an accident, so it is
 * compared like any other. An engine that quietly ignored what the other
 * rejected would otherwise pass every assertion above while leaving a mistyped
 * `data-event` to do nothing at all on a deployed page.
 */
type Step = { readonly refused: true } | { readonly refused: false; readonly view: ViewState };

async function step(transport: EngineTransport, message: BrowserToEngineMessage): Promise<Step> {
  try {
    return { refused: false, view: comparable((await transport.dispatch(message)).view) };
  } catch {
    return { refused: true };
  }
}

describe("the F# and TypeScript engines agree", { skip: built ? false : "the wasm bundle has not been built" }, () => {
  test("every projected key matches, message for message", async () => {
    const wasm = await wasmTransport();
    const typescript = createSiteTransport();

    for (const [index, message] of SCRIPT.entries()) {
      const fromWasm = await step(wasm, message);
      const fromTypeScript = await step(typescript, message);

      // Two implementations of one semantic decision need a mechanism
      // requiring agreement. This is it: a drifting key fails here rather than
      // surfacing as a blank element on a deployed page.
      assert.deepEqual(
        fromWasm,
        fromTypeScript,
        `step ${index} (${message.kind}) produced different results`,
      );
    }
  });

  test("both refuse an unrecognized event, and neither is left changed by it", async () => {
    const wasm = await wasmTransport();
    const typescript = createSiteTransport();
    const bump: BrowserToEngineMessage = { kind: "Event", event: { kind: "Event", name: "increment" } };
    const typo: BrowserToEngineMessage = { kind: "Event", event: { kind: "Event", name: "incremnt" } };

    const before = await Promise.all([wasm.dispatch(bump), typescript.dispatch(bump)]);
    assert.equal(before[0].view["counter"], 1);

    for (const [name, transport] of [["F#", wasm], ["TypeScript", typescript]] as const) {
      await assert.rejects(
        () => transport.dispatch(typo),
        (error: Error) => {
          // The message has to name the event: it is the only thing that
          // leads whoever mistyped the attribute back to the attribute.
          assert.match(error.message, /incremnt/, `the ${name} engine named the event it refused`);
          return true;
        },
        `the ${name} engine refused the typo`,
      );
    }

    // A refusal is total. Nothing was half-applied before it was noticed, so
    // the next legitimate event continues from exactly where the first left
    // off — in both engines.
    const after = await Promise.all([wasm.dispatch(bump), typescript.dispatch(bump)]);
    assert.equal(after[0].view["counter"], 2);
    assert.equal(after[1].view["counter"], 2);
  });

  test("both project exactly the same set of keys", async () => {
    const wasm = await wasmTransport();
    const typescript = createSiteTransport();
    const message: BrowserToEngineMessage = { kind: "Initialize", protocolVersion: 1, capabilities: ["Http"] };

    const fromWasm = Object.keys((await wasm.dispatch(message)).view).sort();
    const fromTypeScript = Object.keys((await typescript.dispatch(message)).view).sort();

    // A key the markup binds but only one engine projects is a runtime throw
    // on the page that ships without it. That is how the `event` key in the
    // trace was found missing from the F# projection.
    assert.deepEqual(fromWasm, fromTypeScript);
  });

  test("both request the same effect for the same event", async () => {
    const wasm = await wasmTransport();
    const typescript = createSiteTransport();
    const message: BrowserToEngineMessage = { kind: "Event", event: { kind: "Event", name: "loadTimeout" } };

    const fromWasm = (await wasm.dispatch(message)).effects;
    const fromTypeScript = (await typescript.dispatch(message)).effects;

    assert.equal(fromWasm.length, fromTypeScript.length);
    // Correlation ids are each engine's own; everything else must match.
    const shape = (effects: typeof fromWasm) =>
      effects.map((effect) => ({ ...effect, correlationId: "<minted>" }));
    assert.deepEqual(shape(fromWasm), shape(fromTypeScript));
  });
});
