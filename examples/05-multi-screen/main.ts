import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createMultiScreenTransport } from "./engine.js";

// `navigation` opts this kernel into browser history. `historyEvent` is the
// name the kernel dispatches when the browser moves the user through session
// history; `linkEvent` is the name it dispatches when the user activates an
// eligible in-application link. Both are this application's vocabulary,
// matching the `case` arms in engine.ts, exactly as a `data-event` attribute
// names an event in markup.
//
// Omit `navigation` entirely and the kernel never touches the URL.
await new BrowserKernel(createMultiScreenTransport(), document, {
  navigation: { historyEvent: "urlChanged", linkEvent: "linkActivated" },
}).start();
