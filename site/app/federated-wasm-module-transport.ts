import type {
  FederatedModuleTransport,
  FederationEnvelope,
  JsonValue,
  ModuleDispatchResult,
  ModuleInitialization,
  ModuleManifest,
} from "../../dist/federation.js";

type DotnetConfig = { readonly mainAssemblyName: string };

type DotnetRuntime = {
  readonly runtimeId: number;
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

type FederatedExports = Readonly<Record<string, unknown>>;

const manifestProjection = (manifest: ModuleManifest): unknown => ({
  id: manifest.id,
  version: manifest.version,
  federationProtocolVersion: manifest.federationProtocolVersion,
  accepts: manifest.accepts.map((range) => ({
    contract: range.contract,
    minVersion: range.minVersion,
    maxVersion: range.maxVersion,
  })),
  emits: manifest.emits.map((range) => ({
    contract: range.contract,
    minVersion: range.minVersion,
    maxVersion: range.maxVersion,
  })),
  capabilitiesRequired: [...manifest.capabilitiesRequired],
  dependencies: [...manifest.dependencies],
  routes: [...manifest.routes],
});

/**
 * Semantically blind adapter from a Limen FederatedModuleTransport to one
 * independently-created .NET WebAssembly runtime.
 *
 * It knows lifecycle operation names and JSON. It does not know a module's
 * state, transition rules, payload fields, or the meaning of any contract.
 */
export class FSharpWasmFederatedModuleTransport implements FederatedModuleTransport {
  readonly manifest: ModuleManifest;
  readonly #moduleUrl: URL;
  readonly #exportContainer: string;
  #exports: FederatedExports | null = null;
  #runtimeId: number | null = null;

  constructor(manifest: ModuleManifest, moduleUrl: URL, exportContainer: string) {
    this.manifest = manifest;
    this.#moduleUrl = moduleUrl;
    this.#exportContainer = exportContainer;
  }

  get runtimeId(): number {
    if (this.#runtimeId === null) {
      throw new Error("F# WebAssembly module has not been loaded.");
    }
    return this.#runtimeId;
  }

  async load(): Promise<void> {
    const loaded = await import(this.#moduleUrl.href) as unknown as DotnetModule;
    const runtime = await loaded.dotnet.withDiagnosticTracing(false).create();
    const config = runtime.getConfig();
    const assemblyExports = await runtime.getAssemblyExports(config.mainAssemblyName);

    if (typeof assemblyExports !== "object" || assemblyExports === null) {
      throw new Error("The .NET WebAssembly runtime returned no assembly exports.");
    }

    const container = (assemblyExports as Record<string, unknown>)[this.#exportContainer];
    if (typeof container !== "object" || container === null) {
      throw new Error("Federated F# export container '" + this.#exportContainer + "' was not found.");
    }

    this.#exports = container as FederatedExports;
    this.#runtimeId = runtime.runtimeId;

    const actualManifest = JSON.parse(this.#call("Manifest")) as ModuleManifest;
    const actualProjection = manifestProjection(actualManifest);
    const expectedManifest = manifestProjection(this.manifest);
    if (JSON.stringify(actualProjection) !== JSON.stringify(expectedManifest)) {
      throw new Error(
        "F# module manifest disagrees with its declared federation manifest for " +
          this.manifest.id + ": exported=" + JSON.stringify(actualProjection) +
          " declared=" + JSON.stringify(expectedManifest),
      );
    }
  }

  async initialize(context: ModuleInitialization): Promise<void> {
    this.#call("Initialize", JSON.stringify(context));
  }

  async restore(snapshot: JsonValue | null): Promise<void> {
    this.#call("Restore", JSON.stringify(snapshot));
  }

  async activate(): Promise<void> {
    this.#call("Activate");
  }

  async dispatch(envelope: FederationEnvelope): Promise<ModuleDispatchResult> {
    const decoded = JSON.parse(
      this.#call("Dispatch", JSON.stringify(envelope)),
    ) as ModuleDispatchResult;

    if (!Array.isArray(decoded.emitted)) {
      throw new Error("Federated F# dispatch must return an emitted envelope array.");
    }

    return decoded;
  }

  async suspend(): Promise<void> {
    this.#call("Suspend");
  }

  async snapshot(): Promise<JsonValue | null> {
    return JSON.parse(this.#call("Snapshot")) as JsonValue | null;
  }

  async unload(): Promise<void> {
    this.#call("Unload");
    this.#exports = null;
  }

  invokeEnvelope(operation: string): FederationEnvelope {
    return JSON.parse(this.#call(operation)) as FederationEnvelope;
  }

  #call(name: string, argument?: string): string {
    if (this.#exports === null) {
      throw new Error("F# WebAssembly module operation '" + name + "' was called before load().");
    }

    const candidate = this.#exports[name];
    if (typeof candidate !== "function") {
      throw new Error("F# WebAssembly module does not export operation '" + name + "'.");
    }

    if (argument === undefined) {
      return (candidate as () => string)();
    }

    return (candidate as (value: string) => string)(argument);
  }
}
