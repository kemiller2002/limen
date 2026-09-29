/// The engine's half of the Limen handshake — the same rule as
/// src/guest/handshake.ts and every other guest language:
///
///   no offer (a pre-1.1 kernel)        -> Rejected HandshakeMissing
///   other protocol major / older minor -> Rejected ProtocolUnsupported
///   other core contract                -> Rejected ContractMismatch
///   a required capability not offered  -> Rejected CapabilityUnavailable
///   otherwise                          -> Accepted, selecting the required
///                                         capabilities plus offered optional ones
module Limen.Guest.Handshake

open Limen.Contract.Core

type Requirements =
    { Protocol: ProtocolRevision
      Contract: ContractIdentity
      Required: CapabilityOffer list
      Optional: CapabilityOffer list }

/// The requirements of an engine that uses no optional capability, pinned to
/// the core contract this binding was generated from.
let coreOnly : Requirements =
    { Protocol = { Major = Contract.ProtocolVersion; Minor = Contract.ProtocolMinor }
      Contract = { Unit = Contract.Unit; Version = Contract.Version; Fingerprint = Contract.Fingerprint }
      Required = []
      Optional = [] }

let answer (offer: HostHandshake option) (engine: Requirements) : EngineHandshake =
    match offer with
    | None -> EngineHandshake.Rejected HandshakeRejection.HandshakeMissing
    | Some offer when offer.Protocol.Major <> engine.Protocol.Major || offer.Protocol.Minor < engine.Protocol.Minor ->
        EngineHandshake.Rejected(HandshakeRejection.ProtocolUnsupported offer.Protocol)
    | Some offer when offer.Contract <> engine.Contract ->
        EngineHandshake.Rejected(HandshakeRejection.ContractMismatch(engine.Contract, offer.Contract))
    | Some offer ->
        let offered (wanted: CapabilityOffer) = offer.Capabilities |> List.contains wanted
        match engine.Required |> List.tryFind (offered >> not) with
        | Some missing -> EngineHandshake.Rejected(HandshakeRejection.CapabilityUnavailable(missing.Id, missing.Version))
        | None -> EngineHandshake.Accepted(engine.Protocol, engine.Contract, engine.Required @ (engine.Optional |> List.filter offered))
