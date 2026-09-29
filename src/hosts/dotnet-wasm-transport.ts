// An optional host adapter: runs a Limen engine compiled to .NET WebAssembly
// (F#, C#, or any .NET language) behind one [JSExport] method that takes and
// returns a serialized Limen message.
//
// Mechanism only. The composition root supplies how to load dotnet.js (so this
// module contains no computed import) and which export to call. What comes
// back is untrusted JSON until the generated contract decoder accepts it.

import { decodeEngineToBrowserMessage } from "../generated/core.codec.js";
import type { BrowserToEngineMessage, EngineToBrowserMessage, EngineTransport } from "../protocol.js";

export type DotnetWasmOptions = {
  // () => import("./wasm/_framework/dotnet.js") — resolved by the caller.
  readonly loadRuntime: () => Promise<unknown>;
  // The [JSExport] path, e.g. ["LimenMinimal", "Dispatch"].
  readonly exportPath: readonly string[];
};

type Dispatch = (messageJson: string) => string;

const property = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;

const call = (target: unknown, name: string, args: readonly unknown[]): unknown => {
  const method = property(target, name);
  if (typeof method !== "function") throw new Error(`The .NET runtime has no ${name}(); rebuild the WebAssembly engine.`);
  return Reflect.apply(method, target, args);
};

export const decodeEngineResponse = (json: string, engine: string): EngineToBrowserMessage => {
  const decoded = decodeEngineToBrowserMessage(JSON.parse(json) as unknown);
  if (!decoded.ok) throw new Error(`${engine} returned a message outside the Limen contract at ${decoded.error.path}: expected ${decoded.error.expected}, found ${decoded.error.found}.`);
  return decoded.value;
};

export class DotnetWasmTransport implements EngineTransport {
  readonly #options: DotnetWasmOptions;
  #dispatch: Dispatch | null = null;

  constructor(options: DotnetWasmOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    const builder = property(await this.#options.loadRuntime(), "dotnet");
    const traced = call(builder, "withDiagnosticTracing", [false]);
    const runtime = await call(traced, "create", []);
    const config = call(runtime, "getConfig", []);
    const exports = await call(runtime, "getAssemblyExports", [property(config, "mainAssemblyName")]);
    const container = this.#options.exportPath.slice(0, -1).reduce<unknown>((value, name) => property(value, name), exports);
    const name = this.#options.exportPath.at(-1) ?? "";
    const method = property(container, name);
    if (typeof method !== "function") throw new Error(`The .NET engine does not export ${this.#options.exportPath.join(".")}.`);
    this.#dispatch = (json) => String(Reflect.apply(method, container, [json]));
  }

  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    if (this.#dispatch === null) throw new Error("DotnetWasmTransport.dispatch() called before start().");
    return decodeEngineResponse(this.#dispatch(JSON.stringify(message)), "The .NET WebAssembly engine");
  }
}
