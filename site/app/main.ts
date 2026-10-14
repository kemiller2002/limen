import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import type { DiagnosticEvent, DiagnosticsSink } from "../../dist/kernel/diagnostics.js";
import { WasmSiteTransport } from "./wasm-engine-transport.js";

const diagnostics: DiagnosticsSink = {
  report(event: DiagnosticEvent): void {
    switch (event.kind) {
      case "BridgeError": console.error(`[limen:${event.phase}]`, event.detail); return;
      case "EffectTiming": console.debug(`[limen:effect] ${event.correlationId} ${event.durationMs.toFixed(1)}ms`); return;
      case "Handshake": console.debug("[limen:handshake]", event.verdict); return;
      case "Hydration": console.debug(`[limen:hydration] ${event.binding}: adopted ${event.adopted}, removed ${event.discarded.length}`); return;
    }
  },
};

// Demonstrations ship inert: until the kernel and the F# engine have started
// there is nothing to answer a click, so their controls must not look usable
// (ULI-A01, ULI-A07). This is runtime readiness, not application state.
const demos = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("[data-requires-engine]"));

const markReady = (): void => {
  for (const demo of demos()) {
    demo.removeAttribute("inert");
    demo.setAttribute("aria-busy", "false");
    demo.querySelector<HTMLElement>("[data-engine-status]")?.setAttribute("hidden", "");
  }
};

const markUnavailable = (): void => {
  for (const demo of demos()) {
    demo.setAttribute("aria-busy", "false");
    const status = demo.querySelector<HTMLElement>("[data-engine-status]");
    if (status !== null) {
      status.dataset.state = "error";
      status.textContent = "The F# engine could not start, so this demonstration is unavailable. Reload the page to try again.";
    }
  }
};

// The F# engine answers the contract-fingerprint handshake, so an engine built
// from a different contract is refused before anything reaches the page.
// start() never rejects: a transport that cannot start, or an incompatible
// engine, leaves the kernel in a non-running status instead.
const kernel = new BrowserKernel(new WasmSiteTransport(), document, diagnostics, { requireHandshake: true });
await kernel.start();
if (kernel.status === "running") {
  markReady();
} else {
  markUnavailable();
}
