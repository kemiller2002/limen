export const PROTOCOL_VERSION = 1 as const;

export type CorrelationId = string & { readonly __correlationId: unique symbol };

// `name` is a domain-chosen identifier (the value of a `data-event` attribute).
// The bridge does not know its meaning; only the engine's own event-to-command
// mapping interprets it, the same way it would interpret any other evidence.
export type SemanticEvent = {
  readonly kind: "Event";
  readonly name: string;
  readonly key?: string;
  readonly value?: string;
};

// The outcome shape for Http effects specifically — Storage has its own,
// StorageOutcome, since a synchronous local operation has different failure
// modes than a network request (no meaningful "dispatched but uncertain").
export type EffectOutcome =
  | { readonly kind: "Success"; readonly status: number; readonly body: unknown }
  // `status` is present exactly when a response was actually received — i.e.
  // for "invalid-response", never for "network"/"aborted". Without it, a 500
  // returning an HTML error page (retryable) is indistinguishable from a 200
  // returning malformed JSON (not retryable), which is a distinction only the
  // engine can act on. Optional rather than required so the absence carries
  // the meaning "nothing came back".
  | { readonly kind: "Failure"; readonly reason: "network" | "aborted" | "invalid-response"; readonly status?: number }
  | { readonly kind: "Cancelled" }
  | { readonly kind: "OutcomeUnknown"; readonly reason: "timeout-after-dispatch" };

// `value` carries the read value for "get" (null means the key was absent —
// that is a normal outcome, not a failure); for "set"/"remove" it is null
// and unused. A single localStorage call is effectively atomic, so unlike
// Http there is no meaningful "dispatched but uncertain" case.
export type StorageOutcome =
  | { readonly kind: "Success"; readonly value: string | null }
  | { readonly kind: "Failure"; readonly reason: "unavailable" | "quota-exceeded" };

export type EffectResult =
  | { readonly kind: "HttpResult"; readonly correlationId: CorrelationId; readonly outcome: EffectOutcome }
  | { readonly kind: "StorageResult"; readonly correlationId: CorrelationId; readonly outcome: StorageOutcome };

export type BrowserToEngineMessage =
  | { readonly kind: "Initialize"; readonly protocolVersion: typeof PROTOCOL_VERSION; readonly capabilities: readonly ["Http", "Storage"] }
  | { readonly kind: "Event"; readonly event: SemanticEvent }
  | { readonly kind: "EffectResult"; readonly result: EffectResult };

// A projection, not the engine's internal state: named values a view may bind
// to via data-text/data-bind-*, and named lists a view may repeat via
// data-each. The bridge resolves these generically; it never knows what a
// key like "statusText" or "customers" means.
export type ViewPrimitive = string | number | boolean;
export type ViewItem = { readonly [field: string]: ViewPrimitive };
export type ViewValue = ViewPrimitive | readonly ViewItem[];
export type ViewState = { readonly [key: string]: ViewValue };

export type HttpMethod = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";

export type HttpEffectRequest = {
  readonly kind: "Http";
  readonly correlationId: CorrelationId;
  readonly method: HttpMethod;
  readonly url: string;
  // Never surface these in a DiagnosticEvent — a header commonly carries a
  // credential (see docs/USAGE.md's secrets-handling note), and the kernel
  // must not become a place that logs one.
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string; // pre-serialized by the engine; the kernel never interprets it
  readonly timeoutMs: number;
};

export type StorageEffectRequest =
  | { readonly kind: "Storage"; readonly correlationId: CorrelationId; readonly operation: "get"; readonly key: string }
  | { readonly kind: "Storage"; readonly correlationId: CorrelationId; readonly operation: "set"; readonly key: string; readonly value: string }
  | { readonly kind: "Storage"; readonly correlationId: CorrelationId; readonly operation: "remove"; readonly key: string };

export type EffectRequest = HttpEffectRequest | StorageEffectRequest;

export type EngineToBrowserMessage = {
  readonly view: ViewState;
  readonly effects: readonly EffectRequest[];
  // Correlation IDs of previously requested effects the engine no longer
  // needs the result of. The kernel executes cancellation; only the engine
  // decides when an in-flight effect is no longer wanted.
  readonly cancellations: readonly CorrelationId[];
};

export interface EngineTransport {
  start(): Promise<void>;
  dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage>;
}
