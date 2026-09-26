export const FEDERATION_PROTOCOL_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type ModuleId = string & { readonly __moduleId: unique symbol };
export type ContractId = string & { readonly __contractId: unique symbol };
export type FederationCorrelationId = string & {
  readonly __federationCorrelationId: unique symbol;
};

export type FederationMessageKind =
  | "TransitionRequest"
  | "TransitionAccepted"
  | "TransitionRejected"
  | "AdditionalInformationRequired"
  | "DomainEvent"
  | "Query"
  | "Projection"
  | "EffectRequest"
  | "EffectResult";

export type ContractRange = {
  readonly contract: ContractId;
  readonly minVersion: number;
  readonly maxVersion: number;
};

export type ModuleManifest = {
  readonly id: ModuleId;
  readonly version: string;
  readonly federationProtocolVersion: typeof FEDERATION_PROTOCOL_VERSION;
  readonly accepts: readonly ContractRange[];
  readonly emits: readonly ContractRange[];
  readonly capabilitiesRequired: readonly string[];
  readonly dependencies: readonly ModuleId[];
  readonly routes: readonly string[];
};

export type FederationEnvelope = {
  readonly protocolVersion: typeof FEDERATION_PROTOCOL_VERSION;
  readonly source: ModuleId;
  readonly target?: ModuleId;
  readonly correlationId: FederationCorrelationId;
  readonly causationId?: FederationCorrelationId;
  readonly idempotencyKey?: string;
  readonly kind: FederationMessageKind;
  readonly contract: ContractId;
  readonly contractVersion: number;
  readonly expectedStateVersion?: number;
  readonly capabilities: readonly string[];
  readonly evidence: readonly string[];
  readonly payload: JsonValue;
};

export type ModulePeer = {
  readonly id: ModuleId;
  readonly version: string;
  readonly accepts: readonly ContractRange[];
  readonly emits: readonly ContractRange[];
  readonly routes: readonly string[];
};

export type ModuleInitialization = {
  readonly federationProtocolVersion: typeof FEDERATION_PROTOCOL_VERSION;
  readonly moduleId: ModuleId;
  readonly peers: readonly ModulePeer[];
  readonly availableCapabilities: readonly string[];
};

export type ModuleDispatchResult = {
  readonly emitted: readonly FederationEnvelope[];
};

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

const assertManifest = (manifest: ModuleManifest): void => {
  if (manifest.federationProtocolVersion !== FEDERATION_PROTOCOL_VERSION) {
    throw new FederationError(
      "ProtocolMismatch",
      "module " + manifest.id + " uses federation protocol " +
        manifest.federationProtocolVersion + ", expected " +
        FEDERATION_PROTOCOL_VERSION,
    );
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
        if (entry.state === "Faulted") {
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

    const result = await this.#invokeTransport(
      targetId,
      "dispatch",
      () => target.transport.dispatch(envelope),
      envelope,
    );
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
