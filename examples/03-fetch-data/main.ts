import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createFetchTransport } from "./engine.js";

await new BrowserKernel(createFetchTransport(), document).start();
