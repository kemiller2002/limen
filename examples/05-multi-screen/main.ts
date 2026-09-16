import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createMultiScreenTransport } from "./engine.js";

// The fourth argument opts this kernel into browser navigation. `historyEvent`
// is the name the kernel dispatches when the browser moves the user through
// session history — it is this application's vocabulary, matching the
// `case "urlChanged"` in engine.ts, exactly as a `data-event` attribute names
// an event in markup. Leave the argument off and the kernel never touches the
// URL, exactly as before.
await new BrowserKernel(
  createMultiScreenTransport(),
  document,
  undefined,
  { historyEvent: "urlChanged" },
).start();
