//! The engine's half of the Limen handshake — the same rule as
//! src/guest/handshake.ts and every other guest language:
//!
//! - no offer (a pre-1.1 kernel)        → Rejected(HandshakeMissing)
//! - other protocol major / older minor → Rejected(ProtocolUnsupported)
//! - other core contract                → Rejected(ContractMismatch)
//! - a required capability not offered  → Rejected(CapabilityUnavailable)
//! - otherwise                          → Accepted, selecting the required
//!   capabilities plus offered optional ones

#![forbid(unsafe_code)]
#![deny(warnings)]

use limen_contract::limen_core::{contract, CapabilityOffer, ContractIdentity, EngineHandshake, HandshakeRejection, HostHandshake, ProtocolRevision};

#[derive(Debug, Clone, PartialEq)]
pub struct Requirements {
    pub protocol: ProtocolRevision,
    pub contract: ContractIdentity,
    pub required: Vec<CapabilityOffer>,
    pub optional: Vec<CapabilityOffer>,
}

impl Requirements {
    /// An engine that uses no optional capability, pinned to the core
    /// contract this binding was generated from.
    pub fn core_only() -> Requirements {
        Requirements {
            protocol: ProtocolRevision { major: contract::PROTOCOL_VERSION, minor: contract::PROTOCOL_MINOR },
            contract: ContractIdentity { unit: contract::UNIT.to_string(), version: contract::VERSION, fingerprint: contract::FINGERPRINT.to_string() },
            required: Vec::new(),
            optional: Vec::new(),
        }
    }
}

pub fn answer(offer: Option<&HostHandshake>, engine: &Requirements) -> EngineHandshake {
    let Some(offer) = offer else {
        return EngineHandshake::Rejected { reason: HandshakeRejection::HandshakeMissing };
    };
    if offer.protocol.major != engine.protocol.major || offer.protocol.minor < engine.protocol.minor {
        return EngineHandshake::Rejected { reason: HandshakeRejection::ProtocolUnsupported { offered: offer.protocol.clone() } };
    }
    if offer.contract != engine.contract {
        return EngineHandshake::Rejected { reason: HandshakeRejection::ContractMismatch { expected: engine.contract.clone(), offered: offer.contract.clone() } };
    }
    let offered = |wanted: &CapabilityOffer| offer.capabilities.contains(wanted);
    if let Some(missing) = engine.required.iter().find(|required| !offered(required)) {
        return EngineHandshake::Rejected { reason: HandshakeRejection::CapabilityUnavailable { id: missing.id.clone(), version: missing.version } };
    }
    EngineHandshake::Accepted {
        protocol: engine.protocol.clone(),
        contract: engine.contract.clone(),
        capabilities: engine.required.iter().chain(engine.optional.iter().filter(|wanted| offered(wanted))).cloned().collect(),
    }
}
