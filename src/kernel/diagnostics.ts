import type { CorrelationId } from "../protocol.js";

// What the bridge reports about its own mechanism — never about domain
// meaning. A thrown error here means the bridge/transport/DOM integration
// failed, not that any application rule was violated.
export type DiagnosticEvent =
  | { readonly kind: "BridgeError"; readonly phase: "dispatch" | "binding" | "projection" | "effect"; readonly detail: string }
  | { readonly kind: "EffectTiming"; readonly correlationId: CorrelationId; readonly durationMs: number };

export interface DiagnosticsSink {
  report(event: DiagnosticEvent): void;
}

export const noopDiagnostics: DiagnosticsSink = { report(): void {} };
