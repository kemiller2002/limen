import type { CorrelationId } from "../protocol.js";
import type { HandshakeVerdict } from "./handshake.js";

// What the bridge reports about its own mechanism — never about domain
// meaning. A thrown error here means the bridge/transport/DOM integration
// failed, not that any application rule was violated.
//
// "protocol" covers traffic the kernel refused on compatibility grounds: a
// message before the handshake was verified or after it failed, or a
// handshake where none belongs. `Handshake` reports the verdict itself, once.
export type DiagnosticEvent =
  | { readonly kind: "BridgeError"; readonly phase: "dispatch" | "binding" | "projection" | "effect" | "protocol"; readonly detail: string }
  | { readonly kind: "EffectTiming"; readonly correlationId: CorrelationId; readonly durationMs: number }
  | { readonly kind: "Handshake"; readonly verdict: HandshakeVerdict };

export interface DiagnosticsSink {
  report(event: DiagnosticEvent): void;
}

export const noopDiagnostics: DiagnosticsSink = { report(): void {} };
