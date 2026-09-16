import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createMultiScreenTransport } from "./engine.js";

await new BrowserKernel(createMultiScreenTransport(), document).start();
