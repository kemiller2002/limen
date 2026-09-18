import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createRoutingTransport } from "./engine.js";

await new BrowserKernel(createRoutingTransport(), document).start();
