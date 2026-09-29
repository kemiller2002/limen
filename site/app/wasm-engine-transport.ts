import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
} from "../../dist/protocol.js";
import { decodeEngineToBrowserMessage } from "../../dist/generated/core.codec.js";

type DotnetRuntime = {
  getAssemblyExports(name: string): Promise<unknown>;
  getConfig(): { readonly mainAssemblyName: string };
};

type DotnetBuilder = {
  withDiagnosticTracing(enabled: boolean): DotnetBuilder;
  create(): Promise<DotnetRuntime>;
};

type Dispatch = (messageJson: string) => string;

// The .NET runtime is an untyped JavaScript module. Its shape is established
// by narrowing, not asserted: a runtime that does not look like this fails at
// start() with a message that says what was missing.
const hasFunction = (value: unknown, name: string): boolean =>
  typeof value === "object" && value !== null && typeof Reflect.get(value, name) === "function";

const dotnetBuilderOf = (module: unknown): DotnetBuilder | undefined => {
  const builder: unknown = typeof module === "object" && module !== null ? Reflect.get(module, "dotnet") : undefined;
  return hasFunction(builder, "withDiagnosticTracing") && hasFunction(builder, "create") ? builder as DotnetBuilder : undefined;
};

const dispatchOf = (exports: unknown): Dispatch | undefined => {
  const container: unknown = typeof exports === "object" && exports !== null ? Reflect.get(exports, "LimenSiteWasm") : undefined;
  const dispatch: unknown = typeof container === "object" && container !== null ? Reflect.get(container, "Dispatch") : undefined;
  return typeof dispatch === "function" ? (json: string) => String(Reflect.apply(dispatch, container, [json])) : undefined;
};

/**
 * Pure boundary mechanics for this site.
 *
 * Limen owns DOM/effects. F# owns the site's application state and decisions.
 * This transport knows only how to load the .NET WebAssembly runtime and move
 * one serialized Limen message across the boundary. What comes back is
 * untrusted JSON until the generated contract decoder has accepted it.
 */
export class WasmSiteTransport implements EngineTransport {
  #dispatch: Dispatch | null = null;

  async start(): Promise<void> {
    const moduleUrl = new URL("../../wasm/_framework/dotnet.js", import.meta.url).href;
    const builder = dotnetBuilderOf(await import(moduleUrl));
    if (builder === undefined) {
      throw new Error("dotnet.js did not export a .NET runtime builder. Rebuild the F# site WebAssembly application.");
    }
    const runtime = await builder.withDiagnosticTracing(false).create();
    const dispatch = dispatchOf(await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName));
    if (dispatch === undefined) {
      throw new Error("LimenSiteWasm.Dispatch export not found. Rebuild the F# site WebAssembly application.");
    }
    this.#dispatch = dispatch;
  }

  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    if (this.#dispatch === null) {
      throw new Error("WasmSiteTransport.dispatch() called before start().");
    }
    const decoded = decodeEngineToBrowserMessage(JSON.parse(this.#dispatch(JSON.stringify(message))) as unknown);
    if (!decoded.ok) {
      throw new Error(`The F# engine returned a message outside the Limen contract at ${decoded.error.path}: expected ${decoded.error.expected}, found ${decoded.error.found}.`);
    }
    return decoded.value;
  }
}
