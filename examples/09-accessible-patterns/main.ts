// The composition root: the kernel plus the two generic capabilities the
// patterns need. No pattern logic lives here.
import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { focusCapability } from "../../dist/capabilities/focus/index.js";
import { eventsCapability } from "../../dist/capabilities/events/index.js";
import { createPatternsTransport } from "./engine.js";

await new BrowserKernel(createPatternsTransport(), document, undefined, { capabilities: [focusCapability(), eventsCapability()], requireHandshake: true }).start();

// The real-browser checks (scripts/smoke-packs.ts) run only when asked for.
if (new URLSearchParams(window.location.search).has("check")) await import("./checks.js");
