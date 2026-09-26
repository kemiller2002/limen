import assert from "node:assert/strict";
import test from "node:test";
import {
  FEDERATION_PROTOCOL_VERSION,
  FederationError,
  ModuleFederation,
  type ContractId,
  type FederatedModuleTransport,
  type FederationCorrelationId,
  type FederationDiagnosticEvent,
  type FederationEnvelope,
  type JsonValue,
  type ModuleDispatchResult,
  type ModuleId,
  type ModuleInitialization,
  type ModuleManifest,
} from "../src/federation.ts";

const moduleId = (value: string): ModuleId => value as ModuleId;
const contractId = (value: string): ContractId => value as ContractId;
const correlationId = (value: string): FederationCorrelationId =>
  value as FederationCorrelationId;

const requestContract = contractId("example.transition.request");
const acceptedContract = contractId("example.transition.accepted");
const eventContract = contractId("example.domain.changed");
const pingContract = contractId("example.ping");

const manifest = (
  id: ModuleId,
  accepts: readonly { readonly contract: ContractId; readonly minVersion: number; readonly maxVersion: number }[],
  emits: readonly { readonly contract: ContractId; readonly minVersion: number; readonly maxVersion: number }[],
  dependencies: readonly ModuleId[] = [],
): ModuleManifest => ({
  id,
  version: "1.0.0",
  federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
  accepts,
  emits,
  capabilitiesRequired: [],
  dependencies,
  routes: [],
});

class FakeModule implements FederatedModuleTransport {
  readonly manifest: ModuleManifest;
  readonly log: string[] = [];
  readonly received: FederationEnvelope[] = [];
  snapshotValue: JsonValue | null = { version: 1 };
  reply: (envelope: FederationEnvelope) => readonly FederationEnvelope[] = () => [];

  constructor(manifest: ModuleManifest) {
    this.manifest = manifest;
  }

  async load(): Promise<void> {
    this.log.push("load");
  }

  async initialize(context: ModuleInitialization): Promise<void> {
    assert.equal(context.moduleId, this.manifest.id);
    assert.equal(context.federationProtocolVersion, FEDERATION_PROTOCOL_VERSION);
    this.log.push("initialize");
  }

  async restore(snapshot: JsonValue | null): Promise<void> {
    this.snapshotValue = snapshot;
    this.log.push("restore");
  }

  async activate(): Promise<void> {
    this.log.push("activate");
  }

  async dispatch(envelope: FederationEnvelope): Promise<ModuleDispatchResult> {
    this.received.push(envelope);
    return { emitted: this.reply(envelope) };
  }

  async suspend(): Promise<void> {
    this.log.push("suspend");
  }

  async snapshot(): Promise<JsonValue | null> {
    this.log.push("snapshot");
    return this.snapshotValue;
  }

  async unload(): Promise<void> {
    this.log.push("unload");
  }
}

const envelope = (
  source: ModuleId,
  target: ModuleId | undefined,
  kind: FederationEnvelope["kind"],
  contract: ContractId,
  version = 1,
): FederationEnvelope => {
  const base = {
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    source,
    correlationId: correlationId("corr-1"),
    kind,
    contract,
    contractVersion: version,
    capabilities: [],
    evidence: [],
    payload: { value: "test" },
  } as const;
  return target === undefined ? base : { ...base, target };
};

test("a module follows the explicit load to unload lifecycle", async () => {
  const id = moduleId("module-a");
  const transport = new FakeModule(manifest(id, [], []));
  const federation = new ModuleFederation([transport]);

  await federation.start(id, { restored: true });
  assert.equal(federation.state(id), "Active");
  assert.deepEqual(transport.log, ["load", "initialize", "restore", "activate"]);

  const saved = await federation.stop(id);
  assert.deepEqual(saved, { restored: true });
  assert.equal(federation.state(id), "Unloaded");
  assert.deepEqual(transport.log, [
    "load",
    "initialize",
    "restore",
    "activate",
    "suspend",
    "snapshot",
    "unload",
  ]);
});

test("illegal lifecycle transitions are rejected before module code runs", async () => {
  const id = moduleId("module-a");
  const transport = new FakeModule(manifest(id, [], []));
  const federation = new ModuleFederation([transport]);

  await assert.rejects(
    federation.suspend(id),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "IllegalLifecycleTransition",
  );
  assert.deepEqual(transport.log, []);
});

test("a transition request crosses modules only through declared versioned contracts", async () => {
  const a = moduleId("module-a");
  const b = moduleId("module-b");
  const moduleA = new FakeModule(
    manifest(
      a,
      [{ contract: acceptedContract, minVersion: 1, maxVersion: 1 }],
      [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
    ),
  );
  const moduleB = new FakeModule(
    manifest(
      b,
      [{ contract: requestContract, minVersion: 1, maxVersion: 2 }],
      [{ contract: acceptedContract, minVersion: 1, maxVersion: 1 }],
    ),
  );

  moduleB.reply = (request) => [
    {
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      source: b,
      target: a,
      correlationId: request.correlationId,
      causationId: request.correlationId,
      kind: "TransitionAccepted",
      contract: acceptedContract,
      contractVersion: 1,
      expectedStateVersion: 8,
      capabilities: [],
      evidence: ["EV-123"],
      payload: { stateVersion: 9 },
    },
  ];

  const federation = new ModuleFederation([moduleA, moduleB]);
  await federation.startAll();

  const result = await federation.exchange(
    envelope(a, b, "TransitionRequest", requestContract),
  );

  assert.equal(result.transcript.length, 2);
  assert.equal(moduleB.received.length, 1);
  assert.equal(moduleA.received.length, 1);
  assert.equal(moduleA.received[0]?.kind, "TransitionAccepted");
});

test("an unsupported contract version is rejected before the target sees it", async () => {
  const a = moduleId("module-a");
  const b = moduleId("module-b");
  const moduleA = new FakeModule(
    manifest(a, [], [{ contract: requestContract, minVersion: 1, maxVersion: 3 }]),
  );
  const moduleB = new FakeModule(
    manifest(b, [{ contract: requestContract, minVersion: 1, maxVersion: 2 }], []),
  );
  const federation = new ModuleFederation([moduleA, moduleB]);
  await federation.startAll();

  await assert.rejects(
    federation.exchange(
      envelope(a, b, "TransitionRequest", requestContract, 3),
    ),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "ContractNotAccepted",
  );
  assert.equal(moduleB.received.length, 0);
});

test("a module cannot emit an envelope under another module identity", async () => {
  const a = moduleId("module-a");
  const b = moduleId("module-b");
  const moduleA = new FakeModule(
    manifest(
      a,
      [{ contract: acceptedContract, minVersion: 1, maxVersion: 1 }],
      [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
    ),
  );
  const moduleB = new FakeModule(
    manifest(
      b,
      [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
      [{ contract: acceptedContract, minVersion: 1, maxVersion: 1 }],
    ),
  );
  moduleB.reply = (request) => [
    {
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      source: a,
      target: a,
      correlationId: request.correlationId,
      kind: "TransitionAccepted",
      contract: acceptedContract,
      contractVersion: 1,
      capabilities: [],
      evidence: [],
      payload: {},
    },
  ];

  const federation = new ModuleFederation([moduleA, moduleB]);
  await federation.startAll();

  await assert.rejects(
    federation.exchange(
      envelope(a, b, "TransitionRequest", requestContract),
    ),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "InvalidEnvelopeSource",
  );
});

test("untargeted domain events fan out only to active compatible modules", async () => {
  const source = moduleId("source");
  const listenerA = moduleId("listener-a");
  const listenerB = moduleId("listener-b");
  const ignored = moduleId("ignored");

  const sourceModule = new FakeModule(
    manifest(source, [], [{ contract: eventContract, minVersion: 1, maxVersion: 1 }]),
  );
  const first = new FakeModule(
    manifest(listenerA, [{ contract: eventContract, minVersion: 1, maxVersion: 1 }], []),
  );
  const second = new FakeModule(
    manifest(listenerB, [{ contract: eventContract, minVersion: 1, maxVersion: 1 }], []),
  );
  const third = new FakeModule(manifest(ignored, [], []));

  const federation = new ModuleFederation([
    sourceModule,
    first,
    second,
    third,
  ]);
  await federation.startAll();

  const result = await federation.exchange(
    envelope(source, undefined, "DomainEvent", eventContract),
  );

  assert.equal(result.transcript.length, 2);
  assert.equal(first.received.length, 1);
  assert.equal(second.received.length, 1);
  assert.equal(third.received.length, 0);
});

test("commands and queries require an explicit target", async () => {
  const a = moduleId("module-a");
  const moduleA = new FakeModule(
    manifest(a, [], [{ contract: requestContract, minVersion: 1, maxVersion: 1 }]),
  );
  const federation = new ModuleFederation([moduleA]);
  await federation.start(a);

  await assert.rejects(
    federation.exchange(
      envelope(a, undefined, "TransitionRequest", requestContract),
    ),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "TargetRequired",
  );
});

test("module dependencies and required capabilities are checked before loading", async () => {
  const a = moduleId("module-a");
  const missing = moduleId("missing");
  const requiresDependency = new FakeModule(manifest(a, [], [], [missing]));
  const dependencyFederation = new ModuleFederation([requiresDependency]);

  await assert.rejects(
    dependencyFederation.start(a),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "MissingDependency",
  );
  assert.deepEqual(requiresDependency.log, []);

  const capableId = moduleId("capable");
  const capableManifest: ModuleManifest = {
    ...manifest(capableId, [], []),
    capabilitiesRequired: ["storage.write"],
  };
  const capable = new FakeModule(capableManifest);
  const capabilityFederation = new ModuleFederation([capable]);

  await assert.rejects(
    capabilityFederation.start(capableId),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "MissingCapability",
  );
  assert.deepEqual(capable.log, []);
});

test("startAll activates dependencies before dependents even when registered later", async () => {
  const dependencyId = moduleId("dependency");
  const dependentId = moduleId("dependent");
  const order: string[] = [];

  class OrderedModule extends FakeModule {
    override async activate(): Promise<void> {
      order.push(String(this.manifest.id));
      await super.activate();
    }
  }

  const dependent = new OrderedModule(
    manifest(dependentId, [], [], [dependencyId]),
  );
  const dependency = new OrderedModule(manifest(dependencyId, [], []));
  const federation = new ModuleFederation([dependent, dependency]);

  await federation.startAll();

  assert.deepEqual(order, ["dependency", "dependent"]);
  assert.equal(federation.state(dependencyId), "Active");
  assert.equal(federation.state(dependentId), "Active");
});

test("starting a dependent directly requires its dependency to already be active", async () => {
  const dependencyId = moduleId("dependency");
  const dependentId = moduleId("dependent");
  const dependent = new FakeModule(
    manifest(dependentId, [], [], [dependencyId]),
  );
  const dependency = new FakeModule(manifest(dependencyId, [], []));
  const federation = new ModuleFederation([dependent, dependency]);

  await assert.rejects(
    federation.start(dependentId),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "InactiveDependency",
  );

  await federation.start(dependencyId);
  await federation.start(dependentId);
  assert.equal(federation.state(dependentId), "Active");
});

test("dependency cycles are rejected deterministically", async () => {
  const a = moduleId("module-a");
  const b = moduleId("module-b");
  const moduleA = new FakeModule(manifest(a, [], [], [b]));
  const moduleB = new FakeModule(manifest(b, [], [], [a]));
  const federation = new ModuleFederation([moduleA, moduleB]);

  await assert.rejects(
    federation.startAll(),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "DependencyCycle",
  );
  assert.deepEqual(moduleA.log, []);
  assert.deepEqual(moduleB.log, []);
});

test("an active dependency cannot unload before its dependent", async () => {
  const dependencyId = moduleId("dependency");
  const dependentId = moduleId("dependent");
  const dependent = new FakeModule(
    manifest(dependentId, [], [], [dependencyId]),
  );
  const dependency = new FakeModule(manifest(dependencyId, [], []));
  const federation = new ModuleFederation([dependent, dependency]);

  await federation.startAll();

  await assert.rejects(
    federation.stop(dependencyId),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "DependencyInUse",
  );

  await federation.stop(dependentId);
  await federation.stop(dependencyId);
  assert.equal(federation.state(dependencyId), "Unloaded");
});

test("a delivery limit stops cyclic module chatter deterministically", async () => {
  const a = moduleId("module-a");
  const b = moduleId("module-b");
  const ranges = [{ contract: pingContract, minVersion: 1, maxVersion: 1 }];
  const moduleA = new FakeModule(manifest(a, ranges, ranges));
  const moduleB = new FakeModule(manifest(b, ranges, ranges));

  moduleA.reply = (message) => [
    {
      ...message,
      source: a,
      target: b,
      causationId: message.correlationId,
    },
  ];
  moduleB.reply = (message) => [
    {
      ...message,
      source: b,
      target: a,
      causationId: message.correlationId,
    },
  ];

  const federation = new ModuleFederation(
    [moduleA, moduleB],
    { maxDeliveries: 3 },
  );
  await federation.startAll();

  await assert.rejects(
    federation.exchange(envelope(a, b, "DomainEvent", pingContract)),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "DeliveryLimitExceeded",
  );
});


test("a transport failure faults the module and reports safe mechanical diagnostics", async () => {
  const id = moduleId("failing");
  class FailingModule extends FakeModule {
    override async load(): Promise<void> {
      this.log.push("load");
      throw new Error("secret-domain-payload");
    }
  }

  const events: FederationDiagnosticEvent[] = [];
  const failing = new FailingModule(manifest(id, [], []));
  const federation = new ModuleFederation([failing], {
    diagnostics: { report: (event) => events.push(event) },
  });

  await assert.rejects(
    federation.start(id),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "TransportFailure" &&
      error.cause instanceof Error &&
      error.cause.message === "secret-domain-payload",
  );

  assert.equal(federation.state(id), "Faulted");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    kind: "ModuleFault",
    moduleId: id,
    operation: "load",
    previousState: "Unloaded",
  });
  assert.ok(!JSON.stringify(events[0]).includes("secret-domain-payload"));
});

test("isolated startup continues independent modules and blocks dependents of a faulted module", async () => {
  const dependencyId = moduleId("dependency");
  const dependentId = moduleId("dependent");
  const independentId = moduleId("independent");

  class FailingDependency extends FakeModule {
    override async activate(): Promise<void> {
      this.log.push("activate");
      throw new Error("activation failed");
    }
  }

  const dependency = new FailingDependency(manifest(dependencyId, [], []));
  const dependent = new FakeModule(
    manifest(dependentId, [], [], [dependencyId]),
  );
  const independent = new FakeModule(manifest(independentId, [], []));
  const events: FederationDiagnosticEvent[] = [];

  const federation = new ModuleFederation(
    [dependent, dependency, independent],
    { diagnostics: { report: (event) => events.push(event) } },
  );

  const report = await federation.startAvailable();

  assert.deepEqual(report.active, [independentId]);
  assert.deepEqual(report.faulted, [dependencyId]);
  assert.deepEqual(report.blocked, [
    {
      moduleId: dependentId,
      reason: "DependencyUnavailable",
      dependency: dependencyId,
      dependencyState: "Faulted",
    },
  ]);

  assert.equal(federation.state(dependencyId), "Faulted");
  assert.equal(federation.state(dependentId), "Unloaded");
  assert.equal(federation.state(independentId), "Active");
  assert.equal(
    events.filter((event) => event.kind === "ModuleFault").length,
    1,
  );
  assert.equal(
    events.filter((event) => event.kind === "ModuleStartupBlocked").length,
    1,
  );
});

test("isolated startup reports missing capabilities without preventing unrelated startup", async () => {
  const blockedId = moduleId("blocked");
  const independentId = moduleId("independent");
  const blockedManifest: ModuleManifest = {
    ...manifest(blockedId, [], []),
    capabilitiesRequired: ["storage.write"],
  };
  const blocked = new FakeModule(blockedManifest);
  const independent = new FakeModule(manifest(independentId, [], []));
  const federation = new ModuleFederation([blocked, independent]);

  const report = await federation.startAvailable();

  assert.deepEqual(report.active, [independentId]);
  assert.deepEqual(report.faulted, []);
  assert.deepEqual(report.blocked, [
    {
      moduleId: blockedId,
      reason: "MissingCapability",
      capabilities: ["storage.write"],
    },
  ]);
  assert.deepEqual(blocked.log, []);
});

test("a dispatch fault isolates the target while healthy modules remain usable", async () => {
  const sourceId = moduleId("source");
  const brokenId = moduleId("broken");
  const healthyId = moduleId("healthy");

  const source = new FakeModule(
    manifest(
      sourceId,
      [],
      [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
    ),
  );

  class BrokenDispatch extends FakeModule {
    override async dispatch(
      envelope: FederationEnvelope,
    ): Promise<ModuleDispatchResult> {
      this.received.push(envelope);
      throw new Error("dispatch exploded");
    }
  }

  const broken = new BrokenDispatch(
    manifest(
      brokenId,
      [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
      [],
    ),
  );
  const healthy = new FakeModule(
    manifest(
      healthyId,
      [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
      [],
    ),
  );

  const federation = new ModuleFederation([source, broken, healthy]);
  await federation.startAll();

  await assert.rejects(
    federation.exchange(
      envelope(sourceId, brokenId, "TransitionRequest", requestContract),
    ),
    (error: unknown) =>
      error instanceof FederationError && error.code === "TransportFailure",
  );

  assert.equal(federation.state(brokenId), "Faulted");
  assert.equal(federation.state(sourceId), "Active");
  assert.equal(federation.state(healthyId), "Active");

  const result = await federation.exchange(
    envelope(sourceId, healthyId, "TransitionRequest", requestContract),
  );
  assert.equal(result.transcript.length, 1);
  assert.equal(healthy.received.length, 1);
});

test("diagnostic sink failures never replace the federation failure", async () => {
  const id = moduleId("failing");
  class FailingModule extends FakeModule {
    override async load(): Promise<void> {
      throw new Error("transport failed");
    }
  }

  const federation = new ModuleFederation(
    [new FailingModule(manifest(id, [], []))],
    {
      diagnostics: {
        report: () => {
          throw new Error("diagnostics failed");
        },
      },
    },
  );

  await assert.rejects(
    federation.start(id),
    (error: unknown) =>
      error instanceof FederationError &&
      error.code === "TransportFailure" &&
      error.cause instanceof Error &&
      error.cause.message === "transport failed",
  );
  assert.equal(federation.state(id), "Faulted");
});
