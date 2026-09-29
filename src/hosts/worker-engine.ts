// The worker half of the optional worker host (kemiller2002/limen#41,
// LCP-035). A worker's composition root builds whichever engine transport it
// runs — .NET WebAssembly, raw WebAssembly, TypeScript — and hands it here:
//
//   import { serveEngine } from "…/hosts/worker-engine.js";
//   serveEngine(self, () => new RawWasmTransport({ loadModule: () => fetch("./engine.wasm") }));
//
// Messages from the page are the serialized BrowserToEngine JSON; each is
// decoded with the generated contract decoder before the engine sees it, and
// answered in arrival order with the engine's serialized reply. A message
// outside the contract, or an engine that throws, is reported as failed; the
// page's WorkerTransport then treats the engine as faulted.
//
// Mechanism only: no DOM exists here, and nothing here knows what a message
// means.

import { decodeBrowserToEngineMessage } from "../generated/core.codec.js";
import type { EngineTransport } from "../protocol.js";

// The parts of a dedicated worker's global scope used here.
export type EngineWorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  postMessage(message: unknown): void;
};

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);

const errorName = (error: unknown): string => {
  const name = field(error, "name");
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "Error";
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const serveEngine = (scope: EngineWorkerScope, createTransport: () => EngineTransport): void => {
  const engine: { transport?: EngineTransport } = {};
  // One engine, one thread: requests are answered strictly in arrival order.
  const queue = { tail: Promise.resolve() };
  const inOrder = (work: () => Promise<void>): void => { queue.tail = queue.tail.then(work, work); };

  const start = async (): Promise<void> => {
    try {
      const transport = createTransport();
      await transport.start();
      engine.transport = transport;
      scope.postMessage({ kind: "started" });
    } catch (error) {
      scope.postMessage({ kind: "failed", name: errorName(error) });
    }
  };

  const dispatch = async (id: number, text: string): Promise<void> => {
    const transport = engine.transport;
    const decoded = decodeBrowserToEngineMessage(parse(text));
    if (transport === undefined || !decoded.ok) {
      scope.postMessage({ kind: "failed", id, name: transport === undefined ? "NotStarted" : "MalformedMessage" });
      return;
    }
    try {
      scope.postMessage({ kind: "reply", id, message: JSON.stringify(await transport.dispatch(decoded.value)) });
    } catch (error) {
      scope.postMessage({ kind: "failed", id, name: errorName(error) });
    }
  };

  scope.addEventListener("message", (event) => {
    const data: unknown = event.data;
    const kind = field(data, "kind");
    const id = field(data, "id");
    const message = field(data, "message");
    if (kind === "start") inOrder(start);
    else if (kind === "dispatch" && typeof id === "number" && typeof message === "string") inOrder(() => dispatch(id, message));
  });
};
