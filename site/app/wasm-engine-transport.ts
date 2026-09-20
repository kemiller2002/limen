import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
} from "../../dist/protocol.js";

type DotnetConfig = { readonly mainAssemblyName: string };

type DotnetRuntime = {
  getAssemblyExports(name: string): Promise<unknown>;
  getConfig(): DotnetConfig;
};

type DotnetBuilder = {
  withDiagnosticTracing(enabled: boolean): DotnetBuilder;
  create(): Promise<DotnetRuntime>;
};

type DotnetModule = {
  readonly dotnet: DotnetBuilder;
};

type SiteExports = {
  readonly LimenSiteWasm?: {
    readonly Dispatch?: (messageJson: string) => string;
  };
};

/**
 * Pure boundary mechanics for this site.
 *
 * Limen owns DOM/effects. F# owns the site's application state and decisions.
 * This transport knows only how to load the .NET WebAssembly runtime and move
 * one serialized Limen message across the boundary.
 */
export class WasmSiteTransport implements EngineTransport {
  #dispatch: ((messageJson: string) => string) | null = null;

  async start(): Promise<void> {
    const moduleUrl = new URL("../../wasm/_framework/dotnet.js", import.meta.url).href;
    const loaded = await import(moduleUrl) as unknown as DotnetModule;
    const runtime = await loaded.dotnet.withDiagnosticTracing(false).create();
    const config = runtime.getConfig();
    const exports = await runtime.getAssemblyExports(config.mainAssemblyName) as SiteExports;
    const dispatch = exports.LimenSiteWasm?.Dispatch;

    if (dispatch === undefined) {
      throw new Error("LimenSiteWasm.Dispatch export not found. Rebuild the F# site WebAssembly application.");
    }

    this.#dispatch = dispatch;
  }

  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    if (this.#dispatch === null) {
      throw new Error("WasmSiteTransport.dispatch() called before start().");
    }

    const json = this.#dispatch(JSON.stringify(message));
    return JSON.parse(json) as EngineToBrowserMessage;
  }
}
