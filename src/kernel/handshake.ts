// Host-side handshake verification: a pure function from what the host offered
// and what the engine answered to a verdict. No DOM, no I/O, no policy beyond
// equality — the engine chooses what it uses; the host only checks that the
// choice is something it offered, exactly.
//
// See research/decisions/DF-LIMEN-2026-0001 for the state model.

import { decodeEngineHandshake, type DecodeError } from "../generated/core.handshake.codec.js";
import type { CapabilityId, CapabilityOffer, ContractIdentity, HandshakeRejection, HostHandshake, ProtocolRevision } from "../protocol.js";

export type Negotiation =
  // The engine accepted, speaks `protocol` (never newer than the host's), and
  // selected exactly these capabilities.
  | { readonly kind: "Negotiated"; readonly protocol: ProtocolRevision; readonly capabilities: readonly CapabilityOffer[] }
  // The engine predates protocol 1.1 and sent no handshake. It may use the four
  // built-in effects and nothing else.
  | { readonly kind: "Legacy" };

// Why normal traffic must not begin. Every member is a compatibility fact about
// the host/engine pair — never an effect outcome, never OutcomeUnknown.
export type Incompatibility =
  | { readonly kind: "engine-rejected"; readonly rejection: HandshakeRejection }
  | { readonly kind: "handshake-required" }
  | { readonly kind: "malformed-handshake"; readonly error: DecodeError }
  | { readonly kind: "protocol-mismatch"; readonly host: ProtocolRevision; readonly engine: ProtocolRevision }
  | { readonly kind: "contract-mismatch"; readonly host: ContractIdentity; readonly engine: ContractIdentity }
  | { readonly kind: "capability-not-offered"; readonly selected: CapabilityOffer }
  | { readonly kind: "capability-mismatch"; readonly offered: CapabilityOffer; readonly selected: CapabilityOffer }
  | { readonly kind: "duplicate-capability"; readonly id: CapabilityId };

export type HandshakeVerdict =
  | { readonly kind: "Compatible"; readonly negotiation: Negotiation }
  | { readonly kind: "Incompatible"; readonly reason: Incompatibility };

const compatible = (negotiation: Negotiation): HandshakeVerdict => ({ kind: "Compatible", negotiation });
const incompatible = (reason: Incompatibility): HandshakeVerdict => ({ kind: "Incompatible", reason });

const sameContract = (left: ContractIdentity, right: ContractIdentity): boolean =>
  left.unit === right.unit && left.version === right.version && left.fingerprint === right.fingerprint;

// The engine may speak an older minor revision of the same major, never a newer
// one: the host cannot honour features it does not implement.
const protocolAccepted = (host: ProtocolRevision, engine: ProtocolRevision): boolean =>
  host.major === engine.major && engine.minor <= host.minor;

const selectionProblem = (offers: readonly CapabilityOffer[], selected: readonly CapabilityOffer[]): Incompatibility | undefined => {
  const duplicate = selected.find((capability, index) => selected.findIndex((other) => other.id === capability.id) !== index);
  if (duplicate !== undefined) return { kind: "duplicate-capability", id: duplicate.id };
  return selected.reduce<Incompatibility | undefined>((problem, capability) => {
    if (problem !== undefined) return problem;
    const offered = offers.find((offer) => offer.id === capability.id);
    if (offered === undefined) return { kind: "capability-not-offered", selected: capability };
    return offered.version === capability.version && offered.fingerprint === capability.fingerprint
      ? undefined
      : { kind: "capability-mismatch", offered, selected: capability };
  }, undefined);
};

export const verifyHandshake = (offer: HostHandshake, answer: unknown, requireHandshake: boolean): HandshakeVerdict => {
  if (answer === undefined) return requireHandshake ? incompatible({ kind: "handshake-required" }) : compatible({ kind: "Legacy" });
  const decoded = decodeEngineHandshake(answer, "$.handshake");
  if (!decoded.ok) return incompatible({ kind: "malformed-handshake", error: decoded.error });
  const handshake = decoded.value;
  switch (handshake.kind) {
    case "Rejected":
      return incompatible({ kind: "engine-rejected", rejection: handshake.reason });
    case "Accepted": {
      if (!protocolAccepted(offer.protocol, handshake.protocol)) return incompatible({ kind: "protocol-mismatch", host: offer.protocol, engine: handshake.protocol });
      if (!sameContract(offer.contract, handshake.contract)) return incompatible({ kind: "contract-mismatch", host: offer.contract, engine: handshake.contract });
      const problem = selectionProblem(offer.capabilities, handshake.capabilities);
      return problem === undefined ? compatible({ kind: "Negotiated", protocol: handshake.protocol, capabilities: handshake.capabilities }) : incompatible(problem);
    }
  }
};
