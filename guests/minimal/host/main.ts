// Composition root for the minimal engine page: chooses which WebAssembly
// engine to run and hands it to the kernel. No application decision here —
// the three engines implement conformance/sessions/minimal-engine.md.
// ?host=worker runs the same engine in a dedicated worker (worker.ts) behind
// WorkerTransport; the kernel and the page are identical either way.

import { BrowserKernel } from "../../../dist/kernel/browser-kernel.js";
import type { DiagnosticEvent } from "../../../dist/kernel/diagnostics.js";
import type { EngineTransport } from "../../../dist/protocol.js";
import { DotnetWasmTransport } from "../../../dist/hosts/dotnet-wasm-transport.js";
import { RawWasmTransport } from "../../../dist/hosts/raw-wasm-transport.js";
import { WorkerTransport } from "../../../dist/hosts/worker-transport.js";

const query = new URLSearchParams(window.location.search);
const engine = query.get("engine") ?? "fsharp";
const inWorker = query.get("host") === "worker";

const transports: Readonly<Record<string, () => EngineTransport>> = {
  fsharp: () => new DotnetWasmTransport({ loadRuntime: () => import("./fsharp/_framework/dotnet.js"), exportPath: ["LimenMinimal", "Dispatch"] }),
  csharp: () => new DotnetWasmTransport({ loadRuntime: () => import("./csharp/_framework/dotnet.js"), exportPath: ["LimenMinimal", "Dispatch"] }),
  rust: () => new RawWasmTransport({ loadModule: () => fetch(new URL("./rust/limen_minimal.wasm", import.meta.url)) }),
};

const diagnostics: DiagnosticEvent[] = [];
Reflect.set(window, "limenDiagnostics", diagnostics);
const label = document.getElementById("engine");
if (label !== null) label.textContent = engine;

const inProcess = transports[engine];
const transport = inWorker
  ? new WorkerTransport({ createWorker: () => new Worker(new URL(`./worker.js?engine=${encodeURIComponent(engine)}`, import.meta.url), { type: "module" }) })
  : inProcess?.();
if (transport === undefined) throw new Error(`Unknown engine "${engine}"`);
// The smoke test terminates the worker through this to prove the fault path.
Reflect.set(window, "limenTransport", transport);
if (label !== null) label.textContent = inWorker ? `${engine}, in a worker` : engine;
// A start that fails (a worker that cannot load its engine, say) is reported
// through diagnostics as a BridgeError naming the fault, never thrown here.
await new BrowserKernel(transport, document, { report: (event) => { diagnostics.push(event); } }, { requireHandshake: true }).start();
// Startup is measured to here (scripts/bench-worker.ts).
performance.mark("limen-ready");
