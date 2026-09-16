// The site's entire application wiring.
//
// Every interactive part of this website runs through one kernel. There is no
// site framework, no router, no component runtime and no state library — the
// pages are static HTML, and the parts that *do* something are driven by an
// engine that is not written in JavaScript.
//
// The engine is F#, compiled to WebAssembly. The kernel below is the same
// `BrowserKernel` the package publishes, unmodified and unaware: it is handed
// a different `EngineTransport` and behaves identically, because the contract
// between them was always plain, serializable data. That is the claim
// docs/17-wasm-migration.md made, and this file is where it is cashed.
import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import type { EngineTransport } from "../../dist/protocol.js";
import { createSiteTransport } from "./engine.js";
import { createWasmTransport } from "./wasm-transport.js";

// A visible diagnostics sink, because a site demonstrating an architecture
// should not hide its own bridge failures. Never logs effect headers, bodies,
// or clipboard contents — see docs/07-effects-and-browser-interop.md.
const diagnostics = {
  report(event: { kind: string; phase?: string; detail?: string; correlationId?: string; durationMs?: number }): void {
    if (event.kind === "BridgeError") console.error(`[limen:${event.phase}]`, event.detail);
    else console.debug(`[limen:effect] ${event.correlationId} ${event.durationMs?.toFixed(1)}ms`);
  },
};

/**
 * Chooses an engine, preferring the F# one.
 *
 * The fallback is not decoration. The wasm bundle is a few megabytes, and a
 * slow network, a blocked request, or a browser without the right WebAssembly
 * features are all real. A site whose every demo dies in those cases would be
 * a poor advertisement for an architecture whose whole argument is that
 * failure should be handled rather than assumed away.
 *
 * Two engines implementing one contract is exactly the duplication SDE warns
 * about, so there is a mechanism requiring them to agree:
 * `test/engine-agreement.test.ts` drives both through the same event sequence
 * and asserts identical projections.
 */
async function chooseEngine(): Promise<{ transport: EngineTransport; engine: string; detail: string }> {
  // Resolved here, against the page, because this file is composition and is
  // allowed to know where the page is — `wasm-transport.ts` is not. `./wasm`
  // relative to the document works both at a domain root and under a GitHub
  // Pages project path.
  const wasm = createWasmTransport({ bundleUrl: new URL("./wasm", document.baseURI).href });
  try {
    await wasm.start();
    return { transport: startedOnce(wasm), engine: "fsharp-wasm", detail: "F# on WebAssembly" };
  } catch (error) {
    console.warn("[limen] the F# WebAssembly engine did not load; falling back to TypeScript.", error);
    return { transport: createSiteTransport(), engine: "typescript", detail: "TypeScript (wasm unavailable)" };
  }
}

/**
 * Wraps an already-started transport so the kernel's own `start()` call does
 * not instantiate the module a second time. The kernel calls `start()` exactly
 * once; loading here rather than there lets the fallback decision happen
 * before anything is bound to the DOM.
 */
function startedOnce(transport: EngineTransport): EngineTransport {
  return {
    async start(): Promise<void> {},
    dispatch: (message) => transport.dispatch(message),
  };
}

const chosen = await chooseEngine();

// Tell the visitor what is actually running. An architecture claim nobody can
// see is a claim nobody can check.
for (const element of document.querySelectorAll<HTMLElement>("[data-engine-name]")) {
  element.textContent = chosen.detail;
  element.setAttribute("data-engine", chosen.engine);
}

await new BrowserKernel(chosen.transport, document, {
  diagnostics,
  clipboard: { enabled: true },
}).start();
