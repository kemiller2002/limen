// The Limen wire contract, as the TypeScript host sees it.
//
// Every wire type below is GENERATED from the language-neutral source of truth,
// contract/core.contract.json, by tools/contract-gen. This file only re-exports
// them under their long-standing public names; it must never declare a wire
// shape of its own (see research/decisions/DF-LIMEN-2026-0001). To change the
// protocol, change the contract and run `npm run contract:generate`.
//
// Rationale that used to live in comments here now lives with the contract
// (each type's `doc`) and in docs/07-effects-and-browser-interop.md, docs/routing.md
// and docs/clipboard.md. In brief:
//
// - Capabilities announced in Initialize say what the kernel implements, never
//   what the browser will permit; permission is reported per effect.
// - Http has four outcomes; OutcomeUnknown is never Failure.
// - Storage, Clipboard and Navigation each have their own outcome type, so no
//   caller handles a variant that cannot occur.
// - BrowserLocation carries `origin` so an engine can compose a shareable link
//   without a side channel; the kernel enforces same-origin navigation anyway.
// - Clipboard is write-only (LCP-019, intentional non-parity).

import type { BrowserToEngineMessage, EngineToBrowserMessage } from "./generated/core.js";

export {
  CONTRACT_IDENTITY as CORE_CONTRACT_IDENTITY,
  PROTOCOL_MINOR,
  PROTOCOL_VERSION,
} from "./generated/core.js";

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
  HandshakeRejection,
  HostHandshake,
  HttpEffectRequest,
  HttpFailureReason,
  HttpMethod,
  NavigationEffectRequest,
  NavigationFailureReason,
  NavigationOutcome,
  ProtocolRevision,
  SemanticEvent,
  StorageEffectRequest,
  StorageFailureReason,
  StorageOutcome,
  ViewItem,
  ViewPrimitive,
  ViewState,
  ViewValue,
} from "./generated/core.js";

// Not a wire type: the in-process seam between the kernel and whatever runs
// the engine (a TypeScript object, a WebAssembly module, a worker).
export interface EngineTransport {
  start(): Promise<void>;
  dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage>;
}
