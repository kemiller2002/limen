// The composition root: the kernel, the adapters capability with this page's
// one registered adapter, and the focus capability. No chart logic here.
import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { adaptersCapability } from "../../dist/capabilities/adapters/index.js";
import { focusCapability } from "../../dist/capabilities/focus/index.js";
import { createCanvasTransport } from "./engine.js";
import { scatterAdapter } from "./scatter-adapter.js";

await new BrowserKernel(createCanvasTransport(), document, undefined, {
  capabilities: [adaptersCapability({ adapters: [scatterAdapter()] }), focusCapability()],
  requireHandshake: true,
}).start();

// The real-browser checks (scripts/smoke-packs.ts) run only when asked for.
if (new URLSearchParams(window.location.search).has("check")) await import("./checks.js");
