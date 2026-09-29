// Composition root inside the dedicated worker (kemiller2002/limen#41): the
// same three engines as main.ts, built here instead, off the main thread.
// ?engine= picks one; "broken" is a deliberately missing engine, so the page
// can prove a worker that cannot start is an explicit fault.

import type { EngineTransport } from "../../../dist/protocol.js";
import { DotnetWasmTransport } from "../../../dist/hosts/dotnet-wasm-transport.js";
import { RawWasmTransport } from "../../../dist/hosts/raw-wasm-transport.js";
import { serveEngine } from "../../../dist/hosts/worker-engine.js";

const engine = new URLSearchParams(self.location.search).get("engine") ?? "fsharp";

const transports: Readonly<Record<string, () => EngineTransport>> = {
  fsharp: () => new DotnetWasmTransport({ loadRuntime: () => import("./fsharp/_framework/dotnet.js"), exportPath: ["LimenMinimal", "Dispatch"] }),
  csharp: () => new DotnetWasmTransport({ loadRuntime: () => import("./csharp/_framework/dotnet.js"), exportPath: ["LimenMinimal", "Dispatch"] }),
  rust: () => new RawWasmTransport({ loadModule: () => fetch(new URL("./rust/limen_minimal.wasm", import.meta.url)) }),
  broken: () => new RawWasmTransport({ loadModule: () => fetch(new URL("./rust/missing.wasm", import.meta.url)) }),
};

serveEngine(self, () => {
  const transport = transports[engine];
  if (transport === undefined) throw new Error(`Unknown engine "${engine}"`);
  return transport();
});
