// The synthetic engine, in the page or in a worker (?host=worker), behind the
// same serialized boundary: in the page each message is stringified, parsed and
// decoded with the generated decoder exactly as an in-process WebAssembly
// transport does, so the two differ only in where the engine runs.
import { WorkerTransport } from "../../../dist/hosts/worker-transport.js";
import { decodeEngineResponse } from "../../../dist/hosts/dotnet-wasm-transport.js";
import { createSyntheticEngine } from "./engine.js";

const inWorker = new URLSearchParams(location.search).get("host") === "worker";
const inPage = () => {
  const engine = createSyntheticEngine();
  return {
    start: () => engine.start(),
    dispatch: async (message) => decodeEngineResponse(JSON.stringify(await engine.dispatch(JSON.parse(JSON.stringify(message)))), "the synthetic engine"),
  };
};
const transport = inWorker ? new WorkerTransport({ createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }) }) : inPage();
await transport.start();
window.benchTransport = transport;
window.benchReady = true;
