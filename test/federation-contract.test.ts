// The federation wire protocol is a language-neutral contract (WI-0030):
// contract/federation.contract.json generates its TypeScript types and codec,
// and the F#, C# and Rust bindings. These pin that the host speaks it: what
// the host sends a module decodes strictly, and the decoders refuse what the
// contract does not allow.

import assert from "node:assert/strict";
import test from "node:test";
import { FEDERATION_PROTOCOL_VERSION, ModuleFederation, type ContractId, type FederatedModuleTransport, type FederationCorrelationId, type FederationEnvelope, type JsonValue, type ModuleDispatchResult, type ModuleId, type ModuleInitialization, type ModuleManifest } from "../dist/federation.js";
import { CONTRACT_IDENTITY, FEDERATION_PROTOCOL_VERSION as GENERATED_VERSION } from "../dist/federation/generated/federation.js";
import { decodeFederationEnvelope, decodeModuleDispatchResult, decodeModuleInitialization, decodeModuleManifest } from "../dist/federation/generated/federation.codec.js";

const id = (value: string): ModuleId => value as ModuleId;
const contract = (value: string): ContractId => value as ContractId;
const ping = contract("example.ping");
const pong = contract("example.pong");

const manifest = (module: ModuleId, accepts: readonly ContractId[], emits: readonly ContractId[]): ModuleManifest => ({
  id: module, version: "1.0.0", federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
  accepts: accepts.map((name) => ({ contract: name, minVersion: 1, maxVersion: 1 })),
  emits: emits.map((name) => ({ contract: name, minVersion: 1, maxVersion: 1 })),
  capabilitiesRequired: [], dependencies: [], routes: ["/ping"],
});

// Records everything the host hands it, and answers a ping with a pong.
const recordingModule = (own: ModuleManifest, seen: { initialization: unknown[]; envelopes: unknown[] }): FederatedModuleTransport => ({
  manifest: own,
  load: async () => {},
  initialize: async (context: ModuleInitialization) => { seen.initialization.push(JSON.parse(JSON.stringify(context))); },
  restore: async (_: JsonValue | null) => {},
  activate: async () => {},
  dispatch: async (envelope: FederationEnvelope): Promise<ModuleDispatchResult> => {
    seen.envelopes.push(JSON.parse(JSON.stringify(envelope)));
    return envelope.contract === ping
      ? { emitted: [{ protocolVersion: 1, source: own.id, target: envelope.source, correlationId: "reply-1" as FederationCorrelationId, causationId: envelope.correlationId, kind: "EffectResult", contract: pong, contractVersion: 1, capabilities: [], evidence: [], payload: { answered: true } }] }
      : { emitted: [] };
  },
  suspend: async () => {},
  snapshot: async () => null,
  unload: async () => {},
});

test("the federation protocol version and identity come from the contract", () => {
  assert.equal(FEDERATION_PROTOCOL_VERSION, GENERATED_VERSION);
  assert.equal(CONTRACT_IDENTITY.unit, "limen.federation");
  assert.match(CONTRACT_IDENTITY.fingerprint, /^sha256:[0-9a-f]{64}$/);
});

test("what the host sends a module decodes strictly as the contract's types", async () => {
  const seen = { initialization: [] as unknown[], envelopes: [] as unknown[] };
  const answering = manifest(id("answering"), [ping], [pong]);
  const asking = manifest(id("asking"), [pong], [ping]);
  const federation = new ModuleFederation([recordingModule(answering, seen), recordingModule(asking, { initialization: [], envelopes: [] })]);
  await federation.start(answering.id, null);
  await federation.start(asking.id, null);
  await federation.exchange({ protocolVersion: 1, source: asking.id, target: answering.id, correlationId: "ask-1" as FederationCorrelationId, kind: "Query", contract: ping, contractVersion: 1, capabilities: [], evidence: [], payload: { question: [1, "two", null] } });
  assert.equal(seen.initialization.length, 1);
  assert.deepEqual(seen.initialization.map((context) => decodeModuleInitialization(context).ok), [true]);
  assert.ok(seen.envelopes.length >= 1);
  assert.deepEqual(seen.envelopes.map((envelope) => decodeFederationEnvelope(envelope).ok), seen.envelopes.map(() => true));
  assert.equal(decodeModuleManifest(JSON.parse(JSON.stringify(answering))).ok, true);
});

test("the decoders refuse what the contract does not allow, and pass any JSON payload through", () => {
  const valid = { protocolVersion: 1, source: "a", correlationId: "c", kind: "DomainEvent", contract: "x", contractVersion: 2, capabilities: [], evidence: [], payload: { nested: [true, 1.5, null, "s"] } };
  const decoded = decodeFederationEnvelope(valid);
  assert.deepEqual(decoded, { ok: true, value: valid });
  assert.deepEqual(decodeFederationEnvelope({ ...valid, protocolVersion: 2 }), { ok: false, error: { path: "$.protocolVersion", expected: "1", found: "number" } });
  assert.deepEqual(decodeFederationEnvelope({ ...valid, kind: "Gossip" }), { ok: false, error: { path: "$.kind", expected: "one of TransitionRequest | TransitionAccepted | TransitionRejected | AdditionalInformationRequired | DomainEvent | Query | Projection | EffectRequest | EffectResult", found: "\"Gossip\"" } });
  assert.deepEqual(decodeFederationEnvelope({ ...valid, extra: 1 }), { ok: false, error: { path: "$.extra", expected: "no such field", found: "unexpected field" } });
  assert.equal(decodeFederationEnvelope({ ...valid, payload: undefined }).ok, false, "a payload is required");
  assert.deepEqual(decodeModuleDispatchResult({ emitted: [valid, { ...valid, contractVersion: 1.5 }] }), { ok: false, error: { path: "$.emitted[1].contractVersion", expected: "integer", found: "number" } });
});
