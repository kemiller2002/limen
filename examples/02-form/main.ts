import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createFormTransport } from "./engine.js";

await new BrowserKernel(createFormTransport(), document).start();
