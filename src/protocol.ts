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

// `history.pushState`/`replaceState` are synchronous, same-document and
// cannot partially apply, so — like Storage and unlike Http — there is no
// meaningful "dispatched but uncertain". `url` on Success is the resulting
// location in the *same* normalized form the kernel reports inbound, so an
// engine that records "where am I" never has to reconcile two spellings of
// the same place.
export type NavigationOutcome =
  | { readonly kind: "Success"; readonly url: string }
  // "unavailable": this kernel was not wired for navigation, so it did not
  // announce the capability and will not touch history.
  // "cross-origin": the kernel refuses to move the page off its own origin
  // however the engine spells the request. Same-document history entries are
  // same-origin by definition, and an engine must not be able to reach
  // through this effect to a different site.
  // "invalid-url": the string would not resolve against the current location.
  | { readonly kind: "Failure"; readonly reason: "unavailable" | "cross-origin" | "invalid-url" };

export type EffectResult =
  | { readonly kind: "HttpResult"; readonly correlationId: CorrelationId; readonly outcome: EffectOutcome }
  | { readonly kind: "StorageResult"; readonly correlationId: CorrelationId; readonly outcome: StorageOutcome }
  | { readonly kind: "NavigationResult"; readonly correlationId: CorrelationId; readonly outcome: NavigationOutcome };

// What the bridge can actually do, announced once at startup. "Navigation" is
// present only when the host wired it (see BrowserKernel's `navigation`
// argument), so an engine can tell whether URLs are available instead of
// assuming. Http and Storage are always present.
export type Capability = "Http" | "Storage" | "Navigation";

export type BrowserToEngineMessage =
  // `location` is the browser's location at page load, in the same normalized
  // form as every other URL that crosses this boundary. It is present exactly
  // when the Navigation capability is announced. It rides on Initialize
  // rather than arriving as a separate event so the engine can choose its
  // *initial* state from the URL — a route delivered one message later would
  // mean projecting the wrong screen first and then correcting it.
  | { readonly kind: "Initialize"; readonly protocolVersion: typeof PROTOCOL_VERSION; readonly capabilities: readonly Capability[]; readonly location?: string }
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

// The engine decides what a route means and when the application has moved;
// the kernel owns the mechanism. `url` is resolved against the current
// location, so a relative "/customers" or "#/customers" is the normal form —
// the kernel neither parses it for meaning nor invents one.
//
// "push" adds a history entry (the user can come back to where they were);
// "replace" rewrites the current one (correcting a URL that should never have
// been a stop on the back button). Which of the two a change deserves is a
// domain decision, so the engine makes it.
//
// There is deliberately no "back"/"forward" here. The browser's own buttons
// already reach the engine through the history event, and no feature has
// needed the engine to drive them; adding it before one does would be
// untested surface with nothing to validate the design against.
export type NavigationEffectRequest = {
  readonly kind: "Navigate";
  readonly correlationId: CorrelationId;
  readonly mode: "push" | "replace";
  readonly url: string;
};

export type EffectRequest = HttpEffectRequest | StorageEffectRequest | NavigationEffectRequest;

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
