// Development trace and replay (LCP-029), as a transport decorator: nothing in
// Core changes, and an application that does not wrap its transport pays
// nothing. A trace records every message across the boundary, in order, with
// a timestamp from an injectable clock. It is a record of evidence, never a
// second state store: replay re-derives state by sending the recorded browser
// messages to a fresh engine.

import type { BrowserToEngineMessage, EffectRequest, EngineToBrowserMessage, EngineTransport } from "../protocol.js";

export type TraceEntry =
  | { readonly sequence: number; readonly at: number; readonly direction: "to-engine"; readonly message: BrowserToEngineMessage }
  | { readonly sequence: number; readonly at: number; readonly direction: "from-engine"; readonly message: EngineToBrowserMessage }
  | { readonly sequence: number; readonly at: number; readonly direction: "failed"; readonly error: string };

export type TraceOptions = {
  // false returns the inner transport itself: tracing is a no-op in production.
  readonly enabled?: boolean;
  readonly clock?: () => number;
};

export const tracingTransport = (inner: EngineTransport, record: (entry: TraceEntry) => void, options: TraceOptions = {}): EngineTransport => {
  if (options.enabled === false) return inner;
  const clock = options.clock ?? (() => performance.now());
  const counter = { next: 0 };
  const sequence = (): number => { counter.next += 1; return counter.next; };
  return {
    start: () => inner.start(),
    dispatch: async (message) => {
      record({ sequence: sequence(), at: clock(), direction: "to-engine", message });
      try {
        const response = await inner.dispatch(message);
        record({ sequence: sequence(), at: clock(), direction: "from-engine", message: response });
        return response;
      } catch (error) {
        record({ sequence: sequence(), at: clock(), direction: "failed", error: String(error) });
        throw error;
      }
    },
  };
};

// --- Redaction -------------------------------------------------------------

// What may carry a user's secret or data: request headers and bodies,
// response bodies, stored and read values, clipboard text, and the query and
// hash of a location. Their shape stays; their content becomes REDACTED. Names
// (event names, view keys, effect kinds) stay: they are the application's
// vocabulary, not the user's data. The view is redacted wholesale.
export const REDACTED = "[redacted]";

const redactEffect = (effect: EffectRequest): EffectRequest => {
  switch (effect.kind) {
    case "Http": return {
      ...effect,
      ...(effect.headers !== undefined ? { headers: Object.fromEntries(Object.keys(effect.headers).map((name) => [name, REDACTED])) } : {}),
      ...(effect.body !== undefined ? { body: REDACTED } : {}),
    };
    case "Storage": return effect.operation === "set" ? { ...effect, value: REDACTED } : effect;
    case "Clipboard": return { ...effect, text: REDACTED };
    case "Navigation": return effect;
    case "Capability": return { ...effect, request: REDACTED };
    default: return assertNever(effect);
  }
};

const assertNever = (value: never): never => { throw new Error(`Unhandled variant: ${JSON.stringify(value)}`); };

const redactLocation = <T extends { readonly query: string; readonly hash: string }>(location: T): T =>
  ({ ...location, query: location.query === "" ? "" : REDACTED, hash: location.hash === "" ? "" : REDACTED });

const redactToEngine = (message: BrowserToEngineMessage): BrowserToEngineMessage => {
  switch (message.kind) {
    case "Initialize": return { ...message, location: redactLocation(message.location) };
    case "Event": return message.event.value === undefined ? message : { ...message, event: { ...message.event, value: REDACTED } };
    case "LocationChanged": return { ...message, location: redactLocation(message.location) };
    case "CapabilityFact": return { ...message, fact: REDACTED };
    case "EffectResult": {
      const result = message.result;
      switch (result.kind) {
        case "HttpResult": return result.outcome.kind === "Success" ? { ...message, result: { ...result, outcome: { ...result.outcome, body: REDACTED } } } : message;
        case "StorageResult": return result.outcome.kind === "Success" && result.outcome.value !== null ? { ...message, result: { ...result, outcome: { ...result.outcome, value: REDACTED } } } : message;
        case "ClipboardResult": return message;
        case "NavigationResult": return result.outcome.kind === "Success" ? { ...message, result: { ...result, outcome: { ...result.outcome, location: redactLocation(result.outcome.location) } } } : message;
        case "CapabilityResult": return result.outcome.kind === "Completed" ? { ...message, result: { ...result, outcome: { ...result.outcome, result: REDACTED } } } : message;
        default: return assertNever(result);
      }
    }
    default: return assertNever(message);
  }
};

const redactFromEngine = (message: EngineToBrowserMessage): EngineToBrowserMessage =>
  ({ ...message, view: Object.fromEntries(Object.keys(message.view).map((key) => [key, REDACTED])), effects: message.effects.map(redactEffect) });

export const redact = (entry: TraceEntry): TraceEntry => {
  switch (entry.direction) {
    case "to-engine": return { ...entry, message: redactToEngine(entry.message) };
    case "from-engine": return { ...entry, message: redactFromEngine(entry.message) };
    case "failed": return { ...entry, error: REDACTED };
    default: return assertNever(entry);
  }
};

// JSON text, safe to attach to a bug report.
export const exportTrace = (entries: readonly TraceEntry[]): string => JSON.stringify(entries.map(redact), null, 2);

// --- Replay ----------------------------------------------------------------

export type ReplayDivergence = { readonly sequence: number; readonly recorded: EngineToBrowserMessage; readonly replayed: EngineToBrowserMessage };

export type ReplayResult = {
  readonly finalView: EngineToBrowserMessage["view"] | undefined;
  readonly divergences: readonly ReplayDivergence[];
};

const canonical = (value: unknown): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : typeof value === "object" && value !== null ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`).join(",")}}`
      : JSON.stringify(value);

// Sends every recorded browser message, in order, to a fresh engine and
// compares each response with the recorded one. For a deterministic engine a
// complete (unredacted) trace reproduces the final projection exactly.
export const replay = async (entries: readonly TraceEntry[], transport: EngineTransport): Promise<ReplayResult> => {
  await transport.start();
  const pairs = entries.flatMap((entry, index) => {
    const next = entries[index + 1];
    return entry.direction === "to-engine" && next?.direction === "from-engine" ? [{ sent: entry.message, recorded: next.message, sequence: next.sequence }] : [];
  });
  const outcomes = await pairs.reduce<Promise<readonly { readonly sequence: number; readonly recorded: EngineToBrowserMessage; readonly replayed: EngineToBrowserMessage }[]>>(
    async (previous, pair) => [...await previous, { sequence: pair.sequence, recorded: pair.recorded, replayed: await transport.dispatch(pair.sent) }],
    Promise.resolve([]),
  );
  return {
    finalView: outcomes.at(-1)?.replayed.view,
    divergences: outcomes.filter((outcome) => canonical(outcome.recorded) !== canonical(outcome.replayed)),
  };
};
