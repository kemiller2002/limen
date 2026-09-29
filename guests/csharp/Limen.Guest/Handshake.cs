// The engine's half of the Limen handshake — the same rule as
// src/guest/handshake.ts and every other guest language:
//
//   no offer (a pre-1.1 kernel)        -> Rejected HandshakeMissing
//   other protocol major / older minor -> Rejected ProtocolUnsupported
//   other core contract                -> Rejected ContractMismatch
//   a required capability not offered  -> Rejected CapabilityUnavailable
//   otherwise                          -> Accepted, selecting the required
//                                         capabilities plus offered optional ones

using System.Collections.Generic;
using System.Linq;
using Limen.Contract.Core;

namespace Limen.Guest;

public sealed record Requirements(ProtocolRevision Protocol, ContractIdentity Contract, IReadOnlyList<CapabilityOffer> Required, IReadOnlyList<CapabilityOffer> Optional)
{
    /// <summary>An engine that uses no optional capability, pinned to the core contract this binding was generated from.</summary>
    public static Requirements CoreOnly { get; } = new(
        new ProtocolRevision(global::Limen.Contract.Core.Contract.ProtocolVersion, global::Limen.Contract.Core.Contract.ProtocolMinor),
        new ContractIdentity(global::Limen.Contract.Core.Contract.Unit, global::Limen.Contract.Core.Contract.Version, global::Limen.Contract.Core.Contract.Fingerprint),
        new CapabilityOffer[0],
        new CapabilityOffer[0]);
}

public static class Handshake
{
    public static EngineHandshake Answer(HostHandshake? offer, Requirements engine)
    {
        if (offer is null) return new EngineHandshake.Rejected(new HandshakeRejection.HandshakeMissing());
        if (offer.Protocol.Major != engine.Protocol.Major || offer.Protocol.Minor < engine.Protocol.Minor)
            return new EngineHandshake.Rejected(new HandshakeRejection.ProtocolUnsupported(offer.Protocol));
        if (offer.Contract != engine.Contract)
            return new EngineHandshake.Rejected(new HandshakeRejection.ContractMismatch(engine.Contract, offer.Contract));
        var missing = engine.Required.FirstOrDefault(required => !offer.Capabilities.Contains(required));
        if (missing is not null)
            return new EngineHandshake.Rejected(new HandshakeRejection.CapabilityUnavailable(missing.Id, missing.Version));
        return new EngineHandshake.Accepted(engine.Protocol, engine.Contract, engine.Required.Concat(engine.Optional.Where(offer.Capabilities.Contains)).ToArray());
    }
}
