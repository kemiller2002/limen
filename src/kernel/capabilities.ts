// The generic seam for optional capability packs.
//
// Core knows that capabilities exist, that each has an identity, a version and
// a contract fingerprint, and that a negotiated one can execute a request and
// emit facts. It knows nothing about what any capability does. A pack supplies
// a provider built with `defineCapability`, whose only path from wire JSON to a
// typed request is the pack's own generated decoder.

import type { CapabilityOffer, CapabilityRejectedReason, CorrelationId } from "../protocol.js";

export type CapabilityDescriptor = CapabilityOffer;

// What a provider tells Core after running a request. `Completed.result` is the
// capability's own encoded outcome — including its own failure, cancelled and
// unknown variants. `Rejected` means the request never ran.
export type ProviderResult =
  | { readonly kind: "Completed"; readonly result: unknown }
  | { readonly kind: "Rejected"; readonly reason: CapabilityRejectedReason };

export type CapabilityRequestContext = {
  readonly correlationId: CorrelationId;
  // Aborted when the engine lists this correlation id in `cancellations`. The
  // provider reports its own Cancelled variant; Core never fabricates one.
  readonly signal: AbortSignal;
  readonly document: Document;
};

export type CapabilityHost<Fact> = {
  readonly document: Document;
  // Sends a CapabilityFact to the engine. Dropped unless the capability is
  // negotiated and the kernel is running.
  readonly emitFact: (fact: Fact) => void;
};

export interface CapabilityProvider {
  readonly descriptor: CapabilityDescriptor;
  // Called once, only if the engine selected this capability in its handshake.
  activate(host: CapabilityHost<unknown>): void;
  execute(request: unknown, context: CapabilityRequestContext): Promise<ProviderResult>;
}

// Structurally identical to every generated codec's Decoded<T>.
type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { readonly path: string; readonly expected: string; readonly found: string } };

// A pack's generated CAPABILITY_OFFER, whose id is a plain string literal.
export type CapabilityOfferLiteral = { readonly id: string; readonly version: number; readonly fingerprint: string };

// The one place a capability identity string becomes a CapabilityId.
const toDescriptor = (offer: CapabilityOfferLiteral): CapabilityDescriptor =>
  ({ id: offer.id as CapabilityDescriptor["id"], version: offer.version, fingerprint: offer.fingerprint });

export type CapabilityDefinition<Request, Result, Fact> = {
  readonly offer: CapabilityOfferLiteral;
  readonly decodeRequest: (value: unknown, path?: string) => Decoded<Request>;
  readonly execute: (request: Request, context: CapabilityRequestContext) => Promise<Result>;
  readonly activate?: (host: CapabilityHost<Fact>) => void;
};

// Builds a provider whose execute() is typed end to end: the untyped request is
// decoded with the generated decoder or rejected, and the typed result is what
// the pack's generated encoder shape says it is (JSON-serializable data).
export const defineCapability = <Request, Result, Fact = never>(definition: CapabilityDefinition<Request, Result, Fact>): CapabilityProvider => ({
  descriptor: toDescriptor(definition.offer),
  activate: (host) => definition.activate?.({ document: host.document, emitFact: (fact: Fact) => host.emitFact(fact) }),
  execute: async (request, context) => {
    const decoded = definition.decodeRequest(request, "$.request");
    return decoded.ok
      ? { kind: "Completed", result: await definition.execute(decoded.value, context) }
      : { kind: "Rejected", reason: "malformed-request" };
  },
});
