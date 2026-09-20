import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { WasmSiteTransport } from "./wasm-engine-transport.js";

const diagnostics = {
  report(event: { kind: string; phase?: string; detail?: string; correlationId?: string; durationMs?: number }): void {
    if (event.kind === "BridgeError") {
      console.error(`[limen:${event.phase}]`, event.detail);
    } else {
      console.debug(`[limen:effect] ${event.correlationId} ${event.durationMs?.toFixed(1)}ms`);
    }
  },
};

await new BrowserKernel(new WasmSiteTransport(), document, diagnostics).start();
