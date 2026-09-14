import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createCounterTransport } from "./engine.js";

await new BrowserKernel(createCounterTransport(), document).start();
