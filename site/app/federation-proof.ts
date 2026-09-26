import {
  FEDERATION_PROTOCOL_VERSION,
  ModuleFederation,
  type ContractId,
  type ModuleId,
  type ModuleManifest,
} from "../../dist/federation.js";
import { FSharpWasmFederatedModuleTransport } from "./federated-wasm-module-transport.js";

const sourceId = "limen.proof.source" as ModuleId;
const targetId = "limen.proof.target" as ModuleId;
const requestContract = "limen.proof.transition" as ContractId;
const resultContract = "limen.proof.transition.result" as ContractId;

const sourceManifest: ModuleManifest = {
  id: sourceId,
  version: "1.0.0",
  federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
  accepts: [{ contract: resultContract, minVersion: 1, maxVersion: 1 }],
  emits: [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
  capabilitiesRequired: [],
  dependencies: [targetId],
  routes: ["/federation/source"],
};

const targetManifest: ModuleManifest = {
  id: targetId,
  version: "1.0.0",
  federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
  accepts: [{ contract: requestContract, minVersion: 1, maxVersion: 1 }],
  emits: [{ contract: resultContract, minVersion: 1, maxVersion: 1 }],
  capabilitiesRequired: [],
  dependencies: [],
  routes: ["/federation/target"],
};

const source = new FSharpWasmFederatedModuleTransport(
  sourceManifest,
  new URL("../../federation/source/_framework/dotnet.js", import.meta.url),
  "LimenFederationSourceWasm",
);

const target = new FSharpWasmFederatedModuleTransport(
  targetManifest,
  new URL("../../federation/target/_framework/dotnet.js", import.meta.url),
  "LimenFederationTargetWasm",
);

const federation = new ModuleFederation([source, target]);

const setText = (id: string, text: string): void => {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
};

try {
  await federation.startAll();

  if (source.runtimeId === target.runtimeId) {
    throw new Error("The federation proof expected two independent .NET WebAssembly runtime IDs.");
  }

  const initial = source.invokeEnvelope("BeginTransition");
  const exchange = await federation.exchange(initial);

  await federation.suspend(sourceId);
  await federation.suspend(targetId);

  const sourceSnapshot = await federation.snapshot(sourceId);
  const targetSnapshot = await federation.snapshot(targetId);

  setText(
    "federation-proof-status",
    "Passed: two independent F# WebAssembly runtimes exchanged a versioned transition through Limen.",
  );
  setText(
    "federation-runtime-ids",
    "source runtime " + source.runtimeId + " · target runtime " + target.runtimeId,
  );
  setText("federation-transcript", JSON.stringify(exchange.transcript, null, 2));
  setText(
    "federation-snapshots",
    JSON.stringify({ source: sourceSnapshot, target: targetSnapshot }, null, 2),
  );

  document.documentElement.dataset.federationProof = "passed";
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  setText("federation-proof-status", "Failed: " + detail);
  document.documentElement.dataset.federationProof = "failed";
  throw error;
}
