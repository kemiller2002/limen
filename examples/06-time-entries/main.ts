import { BrowserKernel } from "../../dist/kernel/browser-kernel.js";
import { createTimeEntriesTransport } from "./engine.js";

await new BrowserKernel(createTimeEntriesTransport(), document).start();
