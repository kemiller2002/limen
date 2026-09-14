// The site's entire application wiring. Four lines of behavior.
//
// Every interactive part of this website runs through this one kernel. There
// is no site framework, no router, no component runtime and no state library —
// the pages are static HTML, and the parts that *do* something are driven by
// the engine next door.
import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createSiteTransport } from "./engine.js";

// A visible diagnostics sink, because a site demonstrating an architecture
// should not hide its own bridge failures. Never logs effect headers or
// bodies — see docs/07-effects-and-browser-interop.md.
const diagnostics = {
  report(event: { kind: string; phase?: string; detail?: string; correlationId?: string; durationMs?: number }): void {
    if (event.kind === "BridgeError") console.error(`[limen:${event.phase}]`, event.detail);
    else console.debug(`[limen:effect] ${event.correlationId} ${event.durationMs?.toFixed(1)}ms`);
  },
};

await new BrowserKernel(createSiteTransport(), document, diagnostics).start();
