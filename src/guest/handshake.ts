// The engine's half of the handshake, as a pure function. Any engine — this
// TypeScript reference, or a generated F#/C#/Rust guest implementing the same
// language-neutral rule — answers the host's offer the same way:
//
//   no offer at all            → Rejected(HandshakeMissing)   (a pre-1.1 kernel)
//   other protocol major       → Rejected(ProtocolUnsupported)
//   other core contract        → Rejected(ContractMismatch)
//   a required capability that was not offered at the same version and
//   fingerprint                → Rejected(CapabilityUnavailable)
//   otherwise                  → Accepted, selecting the required capabilities
//                                plus whichever optional ones were offered.
//
// It has no browser dependency and decides no application meaning; it lives
// outside src/engine/ because it is guest-side protocol support, not a domain.

import type { CapabilityOffer, ContractIdentity, EngineHandshake, HostHandshake, ProtocolRevision } from "../protocol.js";

export type EngineRequirements = {
  readonly protocol: ProtocolRevision;
  readonly contract: ContractIdentity;
  readonly required: readonly CapabilityOffer[];
  readonly optional: readonly CapabilityOffer[];
};

const sameOffer = (left: CapabilityOffer, right: CapabilityOffer): boolean =>
  left.id === right.id && left.version === right.version && left.fingerprint === right.fingerprint;

const sameContract = (left: ContractIdentity, right: ContractIdentity): boolean =>
  left.unit === right.unit && left.version === right.version && left.fingerprint === right.fingerprint;

export const answerHandshake = (offer: HostHandshake | undefined, engine: EngineRequirements): EngineHandshake => {
  if (offer === undefined) return { kind: "Rejected", reason: { kind: "HandshakeMissing" } };
  if (offer.protocol.major !== engine.protocol.major || offer.protocol.minor < engine.protocol.minor) {
    return { kind: "Rejected", reason: { kind: "ProtocolUnsupported", offered: offer.protocol } };
  }
  if (!sameContract(offer.contract, engine.contract)) {
    return { kind: "Rejected", reason: { kind: "ContractMismatch", expected: engine.contract, offered: offer.contract } };
  }
  const missing = engine.required.find((required) => !offer.capabilities.some((offered) => sameOffer(offered, required)));
  if (missing !== undefined) return { kind: "Rejected", reason: { kind: "CapabilityUnavailable", id: missing.id, version: missing.version } };
  const optional = engine.optional.filter((wanted) => offer.capabilities.some((offered) => sameOffer(offered, wanted)));
  return { kind: "Accepted", protocol: engine.protocol, contract: engine.contract, capabilities: [...engine.required, ...optional] };
};
