import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createClipboardTransport } from "./engine.js";

await new BrowserKernel(createClipboardTransport(), document).start();
