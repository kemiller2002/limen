export const PROTOCOL_VERSION = 1 as const;

export type CorrelationId = string & { readonly __correlationId: unique symbol };

// What the kernel *implements*, announced once in `Initialize`. It is not a
// statement about what this particular browser will permit at the moment the
// effect runs: a clipboard write can still be denied, `localStorage` can still
// be unavailable in a private window. Permission and availability are reported
// per effect, in that effect's own outcome — never here. See
// docs/07-effects-and-browser-interop.md § Capabilities are not permissions.
export type Capability = "Http" | "Storage" | "Clipboard" | "Navigation";

// `name` is a domain-chosen identifier (the value of a `data-event` attribute).
// The bridge does not know its meaning; only the engine's own event-to-command
// mapping interprets it, the same way it would interpret any other evidence.
export type SemanticEvent = {
  readonly kind: "Event";
  readonly name: string;
  readonly key?: string;
  readonly value?: string;
};

// The browser's current URL, split mechanically by the kernel. Splitting is
// browser mechanism; deciding that `/invoices/42` names an invoice screen is
// application meaning, so the kernel never parses further than this.
//
// `origin` was left out at first, on the reasoning that an engine able to read
// it would be tempted to branch on it. That reasoning did not survive contact
// with the obvious use case: composing a shareable link to the current screen —
// which is Navigation and Clipboard used together, and the main reason both
// capabilities exist. Without the origin an engine can only build a relative
// path, and a relative path is not a link anyone can share. The alternative,
// reading `window.location.origin` in the composition root and handing it to
// the engine, smuggles a browser value across the boundary through a side
// channel, which is strictly worse. Branching on the origin remains a bad idea;
// it is not one the protocol needs to prevent, and the kernel enforces
// same-origin navigation regardless of what the engine believes.
export type BrowserLocation = {
  readonly origin: string; // "https://example.com" — scheme, host and port, no trailing slash
  readonly path: string;   // "/invoices/42"        — always begins with "/"
  readonly query: string;  // "?tab=history" or ""  — leading "?" included
  readonly hash: string;   // "#totals" or ""       — leading "#" included
};

// The outcome shape for Http effects specifically — Storage, Clipboard and
// Navigation each have their own, since their failure modes genuinely differ.
// A single shared outcome type would force every caller to handle variants
// that cannot occur.
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

// A clipboard write either happened or it did not — there is no partial write
// and nothing to read back, so Success carries no payload. The three failures
// are distinguished because an engine responds to them differently: "denied"
// is usually recoverable by asking the user to click again (browsers require
// a recent user gesture), "unavailable" is not recoverable at all in this
// browser, and "unknown" is worth reporting but not worth explaining.
export type ClipboardOutcome =
  | { readonly kind: "Success" }
  | { readonly kind: "Failure"; readonly reason: "denied" | "unavailable" | "unknown" };

// "Dispatched" is not a weaker Success — it is a different fact. `push` and
// `replace` change the URL synchronously, so the kernel can report where the
// browser ended up. `back` and `forward` only *ask* the browser to move; the
// move itself arrives later, as a LocationChanged message, and may not arrive
// at all if there was no history entry to move to. Reporting those as
// Success with a location would be a lie the engine could not detect.
export type NavigationOutcome =
  | { readonly kind: "Success"; readonly location: BrowserLocation }
  | { readonly kind: "Dispatched" }
  | { readonly kind: "Failure"; readonly reason: "unavailable" | "not-same-origin" };

export type EffectResult =
  | { readonly kind: "HttpResult"; readonly correlationId: CorrelationId; readonly outcome: EffectOutcome }
  | { readonly kind: "StorageResult"; readonly correlationId: CorrelationId; readonly outcome: StorageOutcome }
  | { readonly kind: "ClipboardResult"; readonly correlationId: CorrelationId; readonly outcome: ClipboardOutcome }
  | { readonly kind: "NavigationResult"; readonly correlationId: CorrelationId; readonly outcome: NavigationOutcome };

export type BrowserToEngineMessage =
  // `location` is the URL the page was loaded at. It is delivered once, at
  // startup, so an engine that routes can choose its first state from the
  // address bar rather than defaulting and then correcting itself.
  | { readonly kind: "Initialize"; readonly protocolVersion: typeof PROTOCOL_VERSION; readonly capabilities: readonly Capability[]; readonly location: BrowserLocation }
  | { readonly kind: "Event"; readonly event: SemanticEvent }
  | { readonly kind: "EffectResult"; readonly result: EffectResult }
  // The browser moved through history on its own — Back, Forward, or a
  // gesture that does the same thing. It is not an EffectResult because no
  // effect was requested: nothing correlates it. An engine that ignores this
  // message still compiles and still works; it simply will not react to the
  // Back button.
  | { readonly kind: "LocationChanged"; readonly location: BrowserLocation };

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

// Write-only, deliberately. Reading the clipboard would let any engine pull
// whatever the user last copied — a password, an address — across the
// boundary on its own initiative, and no example in this repository needs it.
// `text` is treated like an Http header: never surfaced in a DiagnosticEvent.
export type ClipboardEffectRequest = {
  readonly kind: "Clipboard";
  readonly correlationId: CorrelationId;
  readonly operation: "writeText";
  readonly text: string;
};

// `url` is same-origin and root-relative ("/invoices/42?tab=history"). The
// kernel rejects anything else rather than navigating: a cross-origin URL
// would leave the application entirely, which is a decision no projection
// should be able to make by accident. Leaving the site is what an ordinary
// <a href> is for.
export type NavigationEffectRequest =
  | { readonly kind: "Navigation"; readonly correlationId: CorrelationId; readonly operation: "push"; readonly url: string }
  | { readonly kind: "Navigation"; readonly correlationId: CorrelationId; readonly operation: "replace"; readonly url: string }
  | { readonly kind: "Navigation"; readonly correlationId: CorrelationId; readonly operation: "back" }
  | { readonly kind: "Navigation"; readonly correlationId: CorrelationId; readonly operation: "forward" };

export type EffectRequest = HttpEffectRequest | StorageEffectRequest | ClipboardEffectRequest | NavigationEffectRequest;

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
