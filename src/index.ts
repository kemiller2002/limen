// The root entrypoint teaches Limen Core only (kemiller2002/limen#59, #61):
// the browser kernel, the boundary messages, the four built-in effect
// families, the optional-capability seam, and compatibility. Every name here
// belongs to an approved export family in architecture/core.json, and nothing
// here loads an optional layer. Optional surfaces have their own subpaths:
//   ./federation          multi-engine composition
//   ./reference-engine    the TypeScript demonstration engine
//   ./capabilities/<name> optional capability packs
export { BrowserKernel } from "./kernel/browser-kernel.js";
export type { KernelOptions, KernelStatus } from "./kernel/browser-kernel.js";
export { defineCapability } from "./kernel/capabilities.js";
export type { CapabilityDefinition, CapabilityDescriptor, CapabilityHost, CapabilityProvider, CapabilityRequestContext, ProviderResult } from "./kernel/capabilities.js";
export { verifyHandshake } from "./kernel/handshake.js";
export type { HandshakeVerdict, Incompatibility, Negotiation } from "./kernel/handshake.js";
export { answerHandshake } from "./guest/handshake.js";
export type { EngineRequirements } from "./guest/handshake.js";
export type { DiagnosticEvent, DiagnosticsSink } from "./kernel/diagnostics.js";
export { CORE_CONTRACT_IDENTITY, PROTOCOL_MINOR, PROTOCOL_VERSION } from "./protocol.js";

export type {
  BrowserLocation,
  BrowserToEngineMessage,
  Capability,
  CapabilityEffectRequest,
  CapabilityId,
  CapabilityOffer,
  CapabilityOutcome,
  CapabilityRejectedReason,
  CapabilityUnsupportedReason,
  ClipboardEffectRequest,
  ClipboardFailureReason,
  ClipboardOutcome,
  ContractIdentity,
  CorrelationId,
  EffectOutcome,
  EffectRequest,
  EffectResult,
  EngineHandshake,
  EngineToBrowserMessage,
  EngineTransport,
  HandshakeRejection,
  HostHandshake,
  HttpEffectRequest,
  HttpFailureReason,
  HttpMethod,
  NavigationEffectRequest,
  NavigationFailureReason,
  NavigationOutcome,
  OutcomeUnknownReason,
  ProtocolRevision,
  SemanticEvent,
  StorageEffectRequest,
  StorageFailureReason,
  StorageOutcome,
  ViewItem,
  ViewPrimitive,
  ViewState,
  ViewValue,
} from "./protocol.js";
