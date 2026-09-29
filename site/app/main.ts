import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import type { DiagnosticEvent, DiagnosticsSink } from "../../dist/kernel/diagnostics.js";
import { WasmSiteTransport } from "./wasm-engine-transport.js";

const diagnostics: DiagnosticsSink = {
  report(event: DiagnosticEvent): void {
    switch (event.kind) {
      case "BridgeError": console.error(`[limen:${event.phase}]`, event.detail); return;
      case "EffectTiming": console.debug(`[limen:effect] ${event.correlationId} ${event.durationMs.toFixed(1)}ms`); return;
      case "Handshake": console.debug("[limen:handshake]", event.verdict); return;
    }
  },
};

// The F# engine answers the contract-fingerprint handshake, so an engine built
// from a different contract is refused before anything reaches the page.
await new BrowserKernel(new WasmSiteTransport(), document, diagnostics, { requireHandshake: true }).start();
