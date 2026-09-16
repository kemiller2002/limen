// An EngineTransport backed by a WebAssembly module.
//
// This is the whole of what changes when the engine stops being TypeScript.
// `BrowserKernel` is not modified, not subclassed, and not configured
// differently: it is handed a different `EngineTransport` and behaves
// identically, because the contract between them was always plain data.
//
// The two methods below are the two the interface has:
//
//   start()    load and instantiate the module — the place docs/17 predicted
//              a WASM transport would need, and which already existed because
//              `start()` is awaited and its rejection already handled.
//   dispatch() serialize the message, call into wasm, parse what comes back.
//
// Serialization is JSON. `src/protocol.ts` is already JSON-shaped by
// construction — "plain, JSON-serializable data only" — so the codec needed no
// protocol change at all. That claim had never been tested before this
// transport existed; now a round trip proves it on every page load.
import type { BrowserToEngineMessage, EngineToBrowserMessage, EngineTransport } from "../../dist/protocol.js";

/** The shape the .NET wasm runtime's own loader exposes. */
type DotnetExports = {
  readonly Limen: {
    readonly Host: {
      readonly Interop: {
        readonly Dispatch: (message: string) => string;
        readonly Reset: () => void;
      };
    };
  };
};

type DotnetHost = {
  create: () => Promise<{
    getAssemblyExports: (name: string) => Promise<DotnetExports>;
    getConfig: () => { mainAssemblyName: string };
  }>;
};

export type WasmTransportOptions = {
  /**
   * Absolute URL of the directory holding `_framework/dotnet.js`.
   *
   * Absolute, and resolved by the caller, for two reasons. The first is
   * architectural: resolving a URL against the current page needs
   * `document.baseURI`, and this file has no business touching the browser —
   * it is the far side of the bridge, not the near one. Composition knows
   * where the page is; a transport should not.
   *
   * The second is a bug this signature makes impossible. A dynamic `import()`
   * with a relative specifier resolves against *the importing module's* URL,
   * not the page's, so `./wasm` from `site/app/wasm-transport.js` asks for
   * `/site/app/wasm/…` and 404s. That happened, and the TypeScript fallback
   * then hid it behind a page that worked perfectly.
   */
  readonly bundleUrl: string;
};

/**
 * Creates a transport that runs the Limen site's engine as F# on WebAssembly.
 *
 * Nothing here interprets a message. It moves strings across a boundary, which
 * is the same job the kernel does on the other side.
 */
export function createWasmTransport(options: WasmTransportOptions): EngineTransport {
  let dispatchInto: ((message: string) => string) | null = null;

  return {
    async start(): Promise<void> {
      const bundle = options.bundleUrl.replace(/\/$/, "");
      // A dynamic import, because the module is emitted by the .NET build and
      // does not exist at TypeScript compile time.
      const loader = (await import(/* @vite-ignore */ `${bundle}/_framework/dotnet.js`)) as { dotnet: DotnetHost };
      const runtime = await loader.dotnet.create();
      const exports = await runtime.getAssemblyExports(runtime.getConfig().mainAssemblyName);
      const entry = exports?.Limen?.Host?.Interop?.Dispatch;
      if (typeof entry !== "function") {
        // Worth naming precisely. An empty exports object is what a pure-F#
        // module produces, because [JSExport] is a C# source generator — see
        // docs/26-fsharp-wasm-engine.md. Failing loudly here beats a page that
        // loads and then does nothing.
        throw new Error("the wasm module exposed no Limen.Host.Interop.Dispatch export");
      }
      dispatchInto = entry;
    },

    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (dispatchInto === null) throw new Error("dispatch() before start()");
      // A throw from the engine — a decode failure, a protocol violation —
      // propagates, and the kernel reports it as BridgeError { phase:
      // "dispatch" } without touching the DOM. That path already existed.
      const reply = dispatchInto(JSON.stringify(message));
      return JSON.parse(reply) as EngineToBrowserMessage;
    },
  };
}
