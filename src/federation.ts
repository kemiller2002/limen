// The wire protocol is generated from contract/federation.contract.json
// (WI-0030), like every other boundary: F#, C# and Rust modules get the same
// types from the same file. A payload is the contract's JSON: unknown until
// the receiving module narrows it by the contract the envelope names.
import { FEDERATION_PROTOCOL_VERSION } from "./federation/generated/federation.js";
import { decodeModuleDispatchResult, decodeModuleManifest, type DecodeError } from "./federation/generated/federation.codec.js";
import type { ModuleId, ContractId, FederationCorrelationId, FederationMessageKind, ContractRange, ModuleManifest, ModulePeer, ModuleInitialization, FederationEnvelope, ModuleDispatchResult } from "./federation/generated/federation.js";

export { FEDERATION_PROTOCOL_VERSION };
export type { ModuleId, ContractId, FederationCorrelationId, FederationMessageKind, ContractRange, ModuleManifest, ModulePeer, ModuleInitialization, FederationEnvelope, ModuleDispatchResult };

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface FederatedModuleTransport {
  readonly manifest: ModuleManifest;
  load(): Promise<void>;
  initialize(context: ModuleInitialization): Promise<void>;
  restore(snapshot: JsonValue | null): Promise<void>;
  activate(): Promise<void>;
  dispatch(envelope: FederationEnvelope): Promise<ModuleDispatchResult>;
  suspend(): Promise<void>;
  snapshot(): Promise<JsonValue | null>;
  unload(): Promise<void>;
}

export type ModuleLifecycleState =
  | "Unloaded"
  | "Loaded"
  | "Initialized"
  | "Restored"
  | "Active"
  | "Suspended"
  | "Snapshotted"
  | "Faulted";

export type FederationOperation =
  | "load"
  | "initialize"
  | "restore"
  | "activate"
  | "dispatch"
  | "suspend"
  | "snapshot"
  | "unload";

export type FederationEnvelopeDiagnostic = {
  readonly source: ModuleId;
  readonly target?: ModuleId;
  readonly correlationId: FederationCorrelationId;
  readonly kind: FederationMessageKind;
  readonly contract: ContractId;
  readonly contractVersion: number;
};

export type FederationStartupBlock =
  | {
      readonly moduleId: ModuleId;
      readonly reason: "MissingDependency";
      readonly dependency: ModuleId;
    }
  | {
      readonly moduleId: ModuleId;
      readonly reason: "DependencyUnavailable";
      readonly dependency: ModuleId;
      readonly dependencyState: ModuleLifecycleState;
    }
  | {
      readonly moduleId: ModuleId;
      readonly reason: "MissingCapability";
      readonly capabilities: readonly string[];
    }
  | {
      readonly moduleId: ModuleId;
      readonly reason: "UnavailableState";
      readonly state: ModuleLifecycleState;
    };

export type FederationDiagnosticEvent =
  | {
      readonly kind: "ModuleFault";
      readonly moduleId: ModuleId;
      readonly operation: FederationOperation;
      readonly previousState: ModuleLifecycleState;
      readonly envelope?: FederationEnvelopeDiagnostic;
    }
  | {
      readonly kind: "ModuleStartupBlocked";
      readonly block: FederationStartupBlock;
    }
  | {
      // reset() took a faulted module back to Unloaded, at a caller's request.
      readonly kind: "ModuleReset";
      readonly moduleId: ModuleId;
      readonly unloaded: boolean;
    };

export interface FederationDiagnosticsSink {
  report(event: FederationDiagnosticEvent): void;
}

export const noopFederationDiagnostics: FederationDiagnosticsSink = {
  report: () => {},
};

export type FederationStartReport = {
  readonly active: readonly ModuleId[];
  readonly faulted: readonly ModuleId[];
  readonly blocked: readonly FederationStartupBlock[];
};

export type FederationErrorCode =
  | "DuplicateModule"
  | "UnknownModule"
  | "ProtocolMismatch"
  | "InvalidManifest"
  | "MissingDependency"
  | "InactiveDependency"
  | "DependencyCycle"
  | "DependencyInUse"
  | "MissingCapability"
  | "IllegalLifecycleTransition"
  | "InactiveModule"
  | "ContractNotEmitted"
  | "ContractNotAccepted"
  | "TargetRequired"
  | "InvalidEnvelopeSource"
  | "InvalidEnvelope"
  | "DeliveryLimitExceeded"
  | "TransportFailure";

export class FederationError extends Error {
  readonly code: FederationErrorCode;
  readonly cause?: unknown;

  constructor(code: FederationErrorCode, message: string, cause?: unknown) {
    super(message);
    this.code = code;
    this.cause = cause;
    this.name = "FederationError";
  }
}

type ModuleEntry = {
  readonly transport: FederatedModuleTransport;
  state: ModuleLifecycleState;
};

export type FederationOptions = {
  readonly availableCapabilities?: readonly string[];
  readonly maxDeliveries?: number;
  readonly diagnostics?: FederationDiagnosticsSink;
};

export type ExchangeResult = {
  readonly transcript: readonly FederationEnvelope[];
};

const isPositiveInteger = (value: number): boolean =>
  Number.isInteger(value) && value > 0;

const supportsContract = (
  ranges: readonly ContractRange[],
  contract: ContractId,
  version: number,
): boolean =>
  ranges.some(
    (range) =>
      range.contract === contract &&
      version >= range.minVersion &&
      version <= range.maxVersion,
  );

// Where a module's output left the federation contract (WI-0141).
const outsideContract = (what: string, error: DecodeError): string =>
  what + " is outside the federation contract at " + error.path + ": expected " + error.expected + ", found " + error.found;

const assertManifest = (manifest: ModuleManifest): void => {
  if (manifest.federationProtocolVersion !== FEDERATION_PROTOCOL_VERSION) {
    throw new FederationError(
      "ProtocolMismatch",
      "module " + manifest.id + " uses federation protocol " +
        manifest.federationProtocolVersion + ", expected " +
        FEDERATION_PROTOCOL_VERSION,
    );
  }

  // A manifest is the module's own claim; decoded strictly, like any wire data.
  const decoded = decodeModuleManifest(manifest);
  if (!decoded.ok) {
    throw new FederationError("InvalidManifest", outsideContract("module manifest", decoded.error));
  }

  if (!manifest.id || !manifest.version) {
    throw new FederationError(
      "InvalidManifest",
      "module manifest requires a non-empty id and version",
    );
  }

  for (const range of [...manifest.accepts, ...manifest.emits]) {
    if (
      !range.contract ||
      !isPositiveInteger(range.minVersion) ||
      !isPositiveInteger(range.maxVersion) ||
      range.minVersion > range.maxVersion
    ) {
      throw new FederationError(
        "InvalidManifest",
        "module " + manifest.id + " has an invalid contract range",
      );
    }
  }
};

export class ModuleFederation {
  readonly #modules = new Map<ModuleId, ModuleEntry>();
  readonly #availableCapabilities: ReadonlySet<string>;
  readonly #maxDeliveries: number;
  readonly #diagnostics: FederationDiagnosticsSink;

  constructor(
    transports: readonly FederatedModuleTransport[] = [],
    options: FederationOptions = {},
  ) {
    this.#availableCapabilities = new Set(options.availableCapabilities ?? []);
    this.#maxDeliveries = options.maxDeliveries ?? 256;
    this.#diagnostics = options.diagnostics ?? noopFederationDiagnostics;

    if (!isPositiveInteger(this.#maxDeliveries)) {
      throw new FederationError(
        "InvalidManifest",
        "maxDeliveries must be a positive integer",
      );
    }

    for (const transport of transports) this.register(transport);
  }

  register(transport: FederatedModuleTransport): void {
    assertManifest(transport.manifest);
    if (this.#modules.has(transport.manifest.id)) {
      throw new FederationError(
        "DuplicateModule",
        "module " + transport.manifest.id + " is already registered",
      );
    }
    this.#modules.set(transport.manifest.id, {
      transport,
      state: "Unloaded",
    });
  }

  manifests(): readonly ModuleManifest[] {
    return [...this.#modules.values()].map((entry) => entry.transport.manifest);
  }

  state(moduleId: ModuleId): ModuleLifecycleState {
    return this.#entry(moduleId).state;
  }

  async start(
    moduleId: ModuleId,
    snapshot: JsonValue | null = null,
  ): Promise<void> {
    const entry = this.#entry(moduleId);
    this.#requireState(entry, moduleId, "Unloaded");

    for (const dependency of entry.transport.manifest.dependencies) {
      const dependencyEntry = this.#modules.get(dependency);
      if (!dependencyEntry) {
        throw new FederationError(
          "MissingDependency",
          "module " + moduleId + " requires unregistered module " + dependency,
        );
      }
      if (dependencyEntry.state !== "Active") {
        throw new FederationError(
          "InactiveDependency",
          "module " + moduleId + " requires active module " + dependency +
            " but it is " + dependencyEntry.state,
        );
      }
    }

    const missingCapabilities = this.#missingCapabilities(entry);
    if (missingCapabilities.length > 0) {
      throw new FederationError(
        "MissingCapability",
        "module " + moduleId + " requires unavailable capabilities: " +
          missingCapabilities.join(", "),
      );
    }

    await this.#invokeTransport(moduleId, "load", () => entry.transport.load());
    entry.state = "Loaded";

    await this.#invokeTransport(moduleId, "initialize", () => entry.transport.initialize({
      federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
      moduleId,
      peers: this.manifests()
        .filter((manifest) => manifest.id !== moduleId)
        .map((manifest) => ({
          id: manifest.id,
          version: manifest.version,
          accepts: manifest.accepts,
          emits: manifest.emits,
          routes: manifest.routes,
        })),
      availableCapabilities: [...this.#availableCapabilities],
    }));
    entry.state = "Initialized";

    await this.#invokeTransport(
      moduleId,
      "restore",
      () => entry.transport.restore(snapshot),
    );
    entry.state = "Restored";

    await this.#invokeTransport(
      moduleId,
      "activate",
      () => entry.transport.activate(),
    );
    entry.state = "Active";
  }

  async startAll(
    snapshots: ReadonlyMap<ModuleId, JsonValue | null> = new Map(),
  ): Promise<void> {
    const visiting = new Set<ModuleId>();

    const startWithDependencies = async (moduleId: ModuleId): Promise<void> => {
      const entry = this.#entry(moduleId);
      if (entry.state === "Active") return;
      if (visiting.has(moduleId)) {
        throw new FederationError(
          "DependencyCycle",
          "dependency cycle detected at module " + moduleId,
        );
      }

      visiting.add(moduleId);
      for (const dependency of entry.transport.manifest.dependencies) {
        if (!this.#modules.has(dependency)) {
          throw new FederationError(
            "MissingDependency",
            "module " + moduleId +
              " requires unregistered module " + dependency,
          );
        }
        await startWithDependencies(dependency);
      }
      visiting.delete(moduleId);

      await this.start(moduleId, snapshots.get(moduleId) ?? null);
    };

    for (const moduleId of this.#modules.keys()) {
      await startWithDependencies(moduleId);
    }
  }


  async startAvailable(
    snapshots: ReadonlyMap<ModuleId, JsonValue | null> = new Map(),
  ): Promise<FederationStartReport> {
    const active: ModuleId[] = [];
    const faulted: ModuleId[] = [];
    const blocked: FederationStartupBlock[] = [];
    const outcomes = new Map<ModuleId, "Active" | "Faulted" | "Blocked">();
    const visiting = new Set<ModuleId>();

    const addBlocked = (block: FederationStartupBlock): void => {
      outcomes.set(block.moduleId, "Blocked");
      blocked.push(block);
      this.#report({ kind: "ModuleStartupBlocked", block });
    };

    const attempt = async (moduleId: ModuleId): Promise<void> => {
      const existing = outcomes.get(moduleId);
      if (existing !== undefined) return;

      const entry = this.#entry(moduleId);

      if (entry.state === "Active") {
        outcomes.set(moduleId, "Active");
        active.push(moduleId);
        return;
      }

      if (entry.state === "Faulted") {
        outcomes.set(moduleId, "Faulted");
        faulted.push(moduleId);
        return;
      }

      if (entry.state !== "Unloaded") {
        addBlocked({
          moduleId,
          reason: "UnavailableState",
          state: entry.state,
        });
        return;
      }

      if (visiting.has(moduleId)) {
        throw new FederationError(
          "DependencyCycle",
          "dependency cycle detected at module " + moduleId,
        );
      }

      visiting.add(moduleId);

      for (const dependency of entry.transport.manifest.dependencies) {
        const dependencyEntry = this.#modules.get(dependency);
        if (!dependencyEntry) {
          visiting.delete(moduleId);
          addBlocked({
            moduleId,
            reason: "MissingDependency",
            dependency,
          });
          return;
        }

        await attempt(dependency);

        if (outcomes.get(dependency) !== "Active") {
          visiting.delete(moduleId);
          addBlocked({
            moduleId,
            reason: "DependencyUnavailable",
            dependency,
            dependencyState: dependencyEntry.state,
          });
          return;
        }
      }

      const missingCapabilities = this.#missingCapabilities(entry);
      if (missingCapabilities.length > 0) {
        visiting.delete(moduleId);
        addBlocked({
          moduleId,
          reason: "MissingCapability",
          capabilities: missingCapabilities,
        });
        return;
      }

      visiting.delete(moduleId);

      try {
        await this.start(moduleId, snapshots.get(moduleId) ?? null);
        outcomes.set(moduleId, "Active");
        active.push(moduleId);
      } catch (error) {
        if (this.state(moduleId) === "Faulted") {
          outcomes.set(moduleId, "Faulted");
          faulted.push(moduleId);
          return;
        }
        throw error;
      }
    };

    for (const moduleId of this.#modules.keys()) {
      await attempt(moduleId);
    }

    return { active, faulted, blocked };
  }

  async suspend(moduleId: ModuleId): Promise<void> {
    const entry = this.#entry(moduleId);
    this.#requireState(entry, moduleId, "Active");
    await this.#invokeTransport(
      moduleId,
      "suspend",
      () => entry.transport.suspend(),
    );
    entry.state = "Suspended";
  }

  async snapshot(moduleId: ModuleId): Promise<JsonValue | null> {
    const entry = this.#entry(moduleId);
    this.#requireState(entry, moduleId, "Suspended");
    const snapshot = await this.#invokeTransport(
      moduleId,
      "snapshot",
      () => entry.transport.snapshot(),
    );
    entry.state = "Snapshotted";
    return snapshot;
  }

  async unload(moduleId: ModuleId): Promise<void> {
    const entry = this.#entry(moduleId);
    this.#requireState(entry, moduleId, "Snapshotted");
    await this.#invokeTransport(
      moduleId,
      "unload",
      () => entry.transport.unload(),
    );
    entry.state = "Unloaded";
  }

  // The only way out of Faulted, and only when a caller asks: the runtime never
  // retries on its own. The module's own unload is attempted once, and a
  // failure there is reported, not thrown — the module was already broken.
  async reset(moduleId: ModuleId): Promise<void> {
    const entry = this.#entry(moduleId);
    this.#requireState(entry, moduleId, "Faulted");
    const unloaded = await entry.transport.unload().then(() => true, () => false);
    entry.state = "Unloaded";
    this.#report({ kind: "ModuleReset", moduleId, unloaded });
  }

  async stop(moduleId: ModuleId): Promise<JsonValue | null> {
    const activeDependent = [...this.#modules.entries()].find(
      ([candidateId, candidate]) =>
        candidateId !== moduleId &&
        candidate.state === "Active" &&
        candidate.transport.manifest.dependencies.includes(moduleId),
    );
    if (activeDependent) {
      throw new FederationError(
        "DependencyInUse",
        "module " + moduleId + " cannot stop while dependent module " +
          activeDependent[0] + " is active",
      );
    }

    await this.suspend(moduleId);
    const snapshot = await this.snapshot(moduleId);
    await this.unload(moduleId);
    return snapshot;
  }

  async exchange(
    initial: FederationEnvelope,
    options: { readonly maxDeliveries?: number } = {},
  ): Promise<ExchangeResult> {
    const maxDeliveries = options.maxDeliveries ?? this.#maxDeliveries;
    if (!isPositiveInteger(maxDeliveries)) {
      throw new FederationError(
        "DeliveryLimitExceeded",
        "maxDeliveries must be a positive integer",
      );
    }

    const queue: FederationEnvelope[] = [initial];
    const transcript: FederationEnvelope[] = [];

    while (queue.length > 0) {
      if (transcript.length >= maxDeliveries) {
        throw new FederationError(
          "DeliveryLimitExceeded",
          "federation exchange exceeded " + maxDeliveries +
            " deliveries; possible message cycle",
        );
      }

      const envelope = queue.shift();
      if (!envelope) break;

      this.#assertEnvelopeSource(envelope);

      if (envelope.target !== undefined) {
        transcript.push(envelope);
        const emitted = await this.#deliver(envelope, envelope.target);
        queue.push(...emitted);
        continue;
      }

      if (envelope.kind !== "DomainEvent") {
        throw new FederationError(
          "TargetRequired",
          envelope.kind + " requires an explicit target module",
        );
      }

      const targets = this.#activeAcceptors(
        envelope.contract,
        envelope.contractVersion,
        envelope.source,
      );

      for (const target of targets) {
        if (transcript.length >= maxDeliveries) {
          throw new FederationError(
            "DeliveryLimitExceeded",
            "federation exchange exceeded " + maxDeliveries +
              " deliveries; possible message cycle",
          );
        }
        const delivery: FederationEnvelope = { ...envelope, target };
        transcript.push(delivery);
        const emitted = await this.#deliver(delivery, target);
        queue.push(...emitted);
      }
    }

    return { transcript };
  }


  #missingCapabilities(entry: ModuleEntry): readonly string[] {
    return entry.transport.manifest.capabilitiesRequired.filter(
      (capability) => !this.#availableCapabilities.has(capability),
    );
  }

  #report(event: FederationDiagnosticEvent): void {
    try {
      this.#diagnostics.report(event);
    } catch {
      // Diagnostics must never become federation control flow.
    }
  }

  #envelopeDiagnostic(
    envelope: FederationEnvelope,
  ): FederationEnvelopeDiagnostic {
    const base = {
      source: envelope.source,
      correlationId: envelope.correlationId,
      kind: envelope.kind,
      contract: envelope.contract,
      contractVersion: envelope.contractVersion,
    } as const;
    return envelope.target === undefined
      ? base
      : { ...base, target: envelope.target };
  }

  async #invokeTransport<T>(
    moduleId: ModuleId,
    operation: FederationOperation,
    action: () => Promise<T>,
    envelope?: FederationEnvelope,
  ): Promise<T> {
    const entry = this.#entry(moduleId);
    const previousState = entry.state;

    try {
      return await action();
    } catch (error) {
      entry.state = "Faulted";
      this.#report({
        kind: "ModuleFault",
        moduleId,
        operation,
        previousState,
        ...(envelope === undefined
          ? {}
          : { envelope: this.#envelopeDiagnostic(envelope) }),
      });
      throw new FederationError(
        "TransportFailure",
        "module " + moduleId + " failed during " + operation,
        error,
      );
    }
  }

  #entry(moduleId: ModuleId): ModuleEntry {
    const entry = this.#modules.get(moduleId);
    if (!entry) {
      throw new FederationError(
        "UnknownModule",
        "module " + moduleId + " is not registered",
      );
    }
    return entry;
  }

  #requireState(
    entry: ModuleEntry,
    moduleId: ModuleId,
    required: ModuleLifecycleState,
  ): void {
    if (entry.state !== required) {
      throw new FederationError(
        "IllegalLifecycleTransition",
        "module " + moduleId + " must be " + required +
          " but is " + entry.state,
      );
    }
  }

  #assertEnvelopeSource(envelope: FederationEnvelope): void {
    if (envelope.protocolVersion !== FEDERATION_PROTOCOL_VERSION) {
      throw new FederationError(
        "ProtocolMismatch",
        "envelope uses federation protocol " + envelope.protocolVersion +
          ", expected " + FEDERATION_PROTOCOL_VERSION,
      );
    }
    if (!isPositiveInteger(envelope.contractVersion)) {
      throw new FederationError(
        "InvalidManifest",
        "contractVersion must be a positive integer",
      );
    }

    const source = this.#entry(envelope.source);
    if (source.state !== "Active") {
      throw new FederationError(
        "InactiveModule",
        "source module " + envelope.source + " is not active",
      );
    }
    if (
      !supportsContract(
        source.transport.manifest.emits,
        envelope.contract,
        envelope.contractVersion,
      )
    ) {
      throw new FederationError(
        "ContractNotEmitted",
        "module " + envelope.source + " does not emit " + envelope.contract +
          "@" + envelope.contractVersion,
      );
    }
  }

  async #deliver(
    envelope: FederationEnvelope,
    targetId: ModuleId,
  ): Promise<readonly FederationEnvelope[]> {
    const target = this.#entry(targetId);
    if (target.state !== "Active") {
      throw new FederationError(
        "InactiveModule",
        "target module " + targetId + " is not active",
      );
    }

    if (
      !supportsContract(
        target.transport.manifest.accepts,
        envelope.contract,
        envelope.contractVersion,
      )
    ) {
      throw new FederationError(
        "ContractNotAccepted",
        "module " + targetId + " does not accept " + envelope.contract +
          "@" + envelope.contractVersion,
      );
    }

    const returned = await this.#invokeTransport(
      targetId,
      "dispatch",
      () => target.transport.dispatch(envelope),
      envelope,
    );
    // What a module returns is untrusted output, decoded strictly before any
    // of it is routed. A wrong protocol version is still ProtocolMismatch.
    const decoded = decodeModuleDispatchResult(returned);
    if (!decoded.ok) {
      throw new FederationError(
        decoded.error.path.endsWith(".protocolVersion") ? "ProtocolMismatch" : "InvalidEnvelope",
        outsideContract("output of module " + targetId, decoded.error),
      );
    }
    const result = decoded.value;
    for (const emitted of result.emitted) {
      if (emitted.source !== targetId) {
        throw new FederationError(
          "InvalidEnvelopeSource",
          "module " + targetId + " attempted to emit as " + emitted.source,
        );
      }
      this.#assertEnvelopeSource(emitted);
    }
    return result.emitted;
  }

  #activeAcceptors(
    contract: ContractId,
    version: number,
    source: ModuleId,
  ): readonly ModuleId[] {
    const result: ModuleId[] = [];
    for (const [moduleId, entry] of this.#modules.entries()) {
      if (
        moduleId !== source &&
        entry.state === "Active" &&
        supportsContract(entry.transport.manifest.accepts, contract, version)
      ) {
        result.push(moduleId);
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Lazy, route- or workflow-driven loading (kemiller2002/limen#33, LCP-024)
// ---------------------------------------------------------------------------
//
// Drives the lifecycle above on demand instead of at startup. A route or a
// workflow asks for a module; its dependencies start first, in order; a
// failure stays with the module that failed (and blocks only its
// dependents); a released module keeps its snapshot and is restored from it,
// deterministically, the next time it is needed. Nothing is retried unless
// the caller asks with retry(). What a route means, and when to load, stay
// the caller's — typically an engine reacting to LocationChanged.

export type LazyOutcome =
  | { readonly kind: "Ready"; readonly moduleId: ModuleId }
  | { readonly kind: "Faulted"; readonly moduleId: ModuleId }
  | { readonly kind: "Blocked"; readonly moduleId: ModuleId; readonly dependency: ModuleId }
  | { readonly kind: "Unknown"; readonly moduleId: ModuleId };

export type LazyStatus = "idle" | "loading" | "ready" | "faulted" | "released" | "unavailable";

export type LazyRelease =
  | { readonly kind: "Released"; readonly moduleId: ModuleId }
  | { readonly kind: "InUse"; readonly moduleId: ModuleId }
  | { readonly kind: "NotReady"; readonly moduleId: ModuleId };

export type LazyFederation = {
  readonly status: (moduleId: ModuleId) => LazyStatus;
  readonly ensure: (moduleId: ModuleId) => Promise<LazyOutcome>;
  readonly forRoute: (path: string) => Promise<readonly LazyOutcome[]>;
  readonly release: (moduleId: ModuleId) => Promise<LazyRelease>;
  readonly retry: (moduleId: ModuleId) => Promise<LazyOutcome>;
};

// A manifest route matches a path exactly, or as a prefix when it ends in
// "/*" ("/orders/*" matches "/orders" and "/orders/42").
export const routeMatches = (route: string, path: string): boolean => {
  if (!route.endsWith("/*")) return route === path;
  const prefix = route.slice(0, -2);
  return path === prefix || path.startsWith(prefix + "/");
};

export const createLazyFederation = (federation: ModuleFederation): LazyFederation => {
  // The controller's own cells: loads in flight (so concurrent requests share
  // one), and snapshots kept by release() for the next start.
  const inFlight = new Map<ModuleId, Promise<LazyOutcome>>();
  const snapshots = new Map<ModuleId, JsonValue | null>();
  const manifestOf = (moduleId: ModuleId): ModuleManifest | undefined =>
    federation.manifests().find((manifest) => manifest.id === moduleId);

  const status = (moduleId: ModuleId): LazyStatus => {
    if (manifestOf(moduleId) === undefined) return "unavailable";
    if (inFlight.has(moduleId)) return "loading";
    switch (federation.state(moduleId)) {
      case "Active": return "ready";
      case "Faulted": return "faulted";
      case "Unloaded": return snapshots.has(moduleId) ? "released" : "idle";
      // Mid-lifecycle (stopping, or started outside this controller).
      case "Loaded":
      case "Initialized":
      case "Restored":
      case "Suspended":
      case "Snapshotted": return "unavailable";
    }
  };

  const load = async (moduleId: ModuleId, manifest: ModuleManifest): Promise<LazyOutcome> => {
    // Dependencies first, one after another, in manifest order.
    const blocking = await manifest.dependencies.reduce<Promise<ModuleId | undefined>>(async (earlier, dependency) => {
      const found = await earlier;
      if (found !== undefined) return found;
      const outcome = await ensure(dependency);
      return outcome.kind === "Ready" ? undefined : dependency;
    }, Promise.resolve(undefined));
    if (blocking !== undefined) return { kind: "Blocked", moduleId, dependency: blocking };
    try {
      await federation.start(moduleId, snapshots.get(moduleId) ?? null);
      snapshots.delete(moduleId);
      return { kind: "Ready", moduleId };
    } catch {
      return federation.state(moduleId) === "Faulted" ? { kind: "Faulted", moduleId } : { kind: "Unknown", moduleId };
    }
  };

  const ensure = (moduleId: ModuleId): Promise<LazyOutcome> => {
    const manifest = manifestOf(moduleId);
    if (manifest === undefined) return Promise.resolve({ kind: "Blocked", moduleId, dependency: moduleId });
    const pending = inFlight.get(moduleId);
    if (pending !== undefined) return pending;
    switch (federation.state(moduleId)) {
      case "Active": return Promise.resolve({ kind: "Ready", moduleId });
      // Never retried here: only retry() does that.
      case "Faulted": return Promise.resolve({ kind: "Faulted", moduleId });
      case "Unloaded": {
        const started = load(moduleId, manifest).finally(() => inFlight.delete(moduleId));
        inFlight.set(moduleId, started);
        return started;
      }
      // Mid-lifecycle outside this controller: not ours to drive.
      case "Loaded":
      case "Initialized":
      case "Restored":
      case "Suspended":
      case "Snapshotted": return Promise.resolve({ kind: "Unknown", moduleId });
    }
  };

  return {
    status,
    ensure,
    forRoute: (path) => {
      const wanted = federation.manifests().filter((manifest) => manifest.routes.some((route) => routeMatches(route, path)));
      return wanted.reduce<Promise<readonly LazyOutcome[]>>(async (done, manifest) => [...(await done), await ensure(manifest.id)], Promise.resolve([]));
    },
    release: async (moduleId) => {
      if (manifestOf(moduleId) === undefined || federation.state(moduleId) !== "Active") return { kind: "NotReady", moduleId };
      try {
        snapshots.set(moduleId, await federation.stop(moduleId));
        return { kind: "Released", moduleId };
      } catch (error) {
        if (error instanceof FederationError && error.code === "DependencyInUse") return { kind: "InUse", moduleId };
        throw error;
      }
    },
    retry: async (moduleId) => {
      if (manifestOf(moduleId) === undefined || federation.state(moduleId) !== "Faulted") return ensure(moduleId);
      await federation.reset(moduleId);
      return ensure(moduleId);
    },
  };
};
