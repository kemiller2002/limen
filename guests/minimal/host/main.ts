// Composition root for the minimal engine page: chooses which WebAssembly
// engine to run and hands it to the kernel. No application decision here —
// the three engines implement conformance/sessions/minimal-engine.md.

import { BrowserKernel } from "../../../dist/kernel/browser-kernel.js";
import type { DiagnosticEvent } from "../../../dist/kernel/diagnostics.js";
import type { EngineTransport } from "../../../dist/protocol.js";
import { DotnetWasmTransport } from "../../../dist/hosts/dotnet-wasm-transport.js";
import { RawWasmTransport } from "../../../dist/hosts/raw-wasm-transport.js";

const engine = new URLSearchParams(window.location.search).get("engine") ?? "fsharp";

const transports: Readonly<Record<string, () => EngineTransport>> = {
  fsharp: () => new DotnetWasmTransport({ loadRuntime: () => import("./fsharp/_framework/dotnet.js"), exportPath: ["LimenMinimal", "Dispatch"] }),
  csharp: () => new DotnetWasmTransport({ loadRuntime: () => import("./csharp/_framework/dotnet.js"), exportPath: ["LimenMinimal", "Dispatch"] }),
  rust: () => new RawWasmTransport({ loadModule: () => fetch(new URL("./rust/limen_minimal.wasm", import.meta.url)) }),
};

const diagnostics: DiagnosticEvent[] = [];
Reflect.set(window, "limenDiagnostics", diagnostics);
const label = document.getElementById("engine");
if (label !== null) label.textContent = engine;

const transport = transports[engine];
if (transport === undefined) throw new Error(`Unknown engine "${engine}"`);
await new BrowserKernel(transport(), document, { report: (event) => { diagnostics.push(event); } }, { requireHandshake: true }).start();
