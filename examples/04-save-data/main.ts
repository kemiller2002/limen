import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createSaveTransport } from "./engine.js";

await new BrowserKernel(createSaveTransport(), document).start();
