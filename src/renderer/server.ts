// Server and static rendering (kemiller2002/limen#38, LCP-022): the same
// engine that runs in the browser renders a route to semantic HTML.
//
//   1. The engine is initialized with the request's location, told the only
//      built-in capability here is Http (if the host gave the renderer a fetch),
//      and offered no optional capability: what is missing on the server is
//      absent in the protocol itself, before the engine asks.
//   2. Effects run until the engine has nothing more to ask, within a round and
//      time budget: Http through the host's fetch; Storage, Clipboard and
//      Navigation answered Failure { unavailable }; every capability request
//      Unsupported { not-negotiated }. Nothing is ever silently dropped.
//   3. The settled projection is applied to the page (head and body) with the
//      kernel's own binding rules, and written out.
//
// There is no second authority: the server's engine instance lives for one
// render and is discarded; the browser's engine starts from the same location
// and owns everything after. No BrowserKernel is involved.

import { CORE_CONTRACT_IDENTITY, PROTOCOL_MINOR, PROTOCOL_VERSION, type BrowserLocation, type BrowserToEngineMessage, type Capability, type EffectOutcome, type EffectRequest, type EffectResult, type EngineToBrowserMessage, type EngineTransport, type HostHandshake, type HttpEffectRequest, type ViewState } from "../protocol.js";
import { verifyHandshake, type Incompatibility } from "../kernel/handshake.js";
import { parse, serialize } from "./html.js";
import { renderProjection } from "./render.js";

// What the renderer needs of a fetch: the host's, with its own credentials,
// timeouts and base URL policy. Absent: Http is not offered either.
export type ServerFetch = (url: string, init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly signal: AbortSignal }) => Promise<{ readonly status: number; readonly headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type RenderOptions = {
  // The page's template HTML: the same file the browser loads.
  readonly page: string;
  readonly engine: EngineTransport;
  // The absolute URL being rendered.
  readonly url: string;
  readonly fetch?: ServerFetch;
  // How many engine round trips, and how long, before rendering what there is.
  readonly maxRounds?: number;
  readonly timeoutMs?: number;
};

export type RenderResult = {
  readonly html: string;
  readonly view: ViewState;
  // false: the round or time budget ran out with effects still outstanding;
  // the page shows the engine's last projection, and the browser's engine
  // takes over from the location as always.
  readonly settled: boolean;
  readonly rounds: number;
  // Unsafe URLs not written, as the kernel would report them.
  readonly refusals: readonly string[];
  // Every effect the server answered with unavailable or not-negotiated.
  readonly refused: readonly string[];
};

export class RenderRefused extends Error {
  constructor(readonly incompatibility: Incompatibility) {
    super(`the engine and the server renderer are incompatible: ${incompatibility.kind}`);
    this.name = "RenderRefused";
  }
}

export const locationOf = (url: string): BrowserLocation => {
  const parsed = new URL(url);
  // The fragment never reaches a server.
  return { origin: parsed.origin, path: parsed.pathname, query: parsed.search, hash: "" };
};

const safeMethod = (method: string): boolean => method === "GET" || method === "HEAD" || method === "OPTIONS";

const toBase64 = (text: string): string => btoa(Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(""));

// Http on the server, with the kernel's outcome rules: a timeout is unknown;
// a thrown write is unknown (connection-lost from 1.4); a thrown read is a
// network failure; a body that does not decode keeps its status.
const runHttp = async (fetch: ServerFetch, effect: HttpEffectRequest, base: string, minor: number): Promise<EffectOutcome> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), effect.timeoutMs);
  const representation = effect.response ?? "json";
  try {
    const response = await fetch(new URL(effect.url, base).href, {
      method: effect.method,
      headers: { ...(representation === "json" ? { accept: "application/json" } : {}), ...effect.headers },
      ...(effect.body !== undefined ? { body: effect.body } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    const headers = effect.responseHeaders === undefined ? undefined : Object.fromEntries(effect.responseHeaders.flatMap((name) => { const value = response.headers.get(name); return value === null ? [] : [[name.toLowerCase(), value] as const]; }));
    const success = (body: unknown): EffectOutcome => ({ kind: "Success", status: response.status, body, ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}) });
    switch (representation) {
      case "none": return success(null);
      case "text": return success(text);
      case "base64": return success(toBase64(text));
      case "json":
        try {
          return success(JSON.parse(text) as unknown);
        } catch {
          return { kind: "Failure", reason: "invalid-response", status: response.status };
        }
    }
  } catch {
    if (controller.signal.reason === "timeout") return { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" };
    if (safeMethod(effect.method)) return { kind: "Failure", reason: "network" };
    return { kind: "OutcomeUnknown", reason: minor >= 4 ? "connection-lost" : "timeout-after-dispatch" };
  } finally {
    clearTimeout(timer);
  }
};

const answer = async (effect: EffectRequest, options: RenderOptions, minor: number): Promise<{ readonly result: EffectResult; readonly refused?: string }> => {
  switch (effect.kind) {
    case "Http":
      return options.fetch === undefined
        ? { result: { kind: "HttpResult", correlationId: effect.correlationId, outcome: { kind: "Failure", reason: "network" } }, refused: `Http ${effect.method} (no fetch on this server)` }
        : { result: { kind: "HttpResult", correlationId: effect.correlationId, outcome: await runHttp(options.fetch, effect, options.url, minor) } };
    case "Storage":
      return { result: { kind: "StorageResult", correlationId: effect.correlationId, outcome: { kind: "Failure", reason: "unavailable" } }, refused: `Storage ${effect.operation}` };
    case "Clipboard":
      return { result: { kind: "ClipboardResult", correlationId: effect.correlationId, outcome: { kind: "Failure", reason: "unavailable" } }, refused: "Clipboard writeText" };
    case "Navigation":
      return { result: { kind: "NavigationResult", correlationId: effect.correlationId, outcome: { kind: "Failure", reason: "unavailable" } }, refused: `Navigation ${effect.operation}` };
    case "Capability":
      return { result: { kind: "CapabilityResult", correlationId: effect.correlationId, capability: effect.capability, version: effect.version, outcome: { kind: "Unsupported", reason: "not-negotiated" } }, refused: `Capability ${effect.capability}` };
  }
};

type Progress = { readonly view: ViewState; readonly effects: readonly EffectRequest[]; readonly rounds: number; readonly refused: readonly string[] };

export const renderRoute = async (options: RenderOptions): Promise<RenderResult> => {
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const maxRounds = options.maxRounds ?? 8;
  const capabilities: readonly Capability[] = options.fetch === undefined ? [] : ["Http"];
  const offer: HostHandshake = { protocol: { major: PROTOCOL_VERSION, minor: PROTOCOL_MINOR }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [] };
  await options.engine.start();
  const initialize: BrowserToEngineMessage = { kind: "Initialize", protocolVersion: 1, capabilities: [...capabilities], location: locationOf(options.url), handshake: offer };
  const first: EngineToBrowserMessage = await options.engine.dispatch(initialize);
  const verdict = verifyHandshake(offer, first.handshake, false);
  if (verdict.kind === "Incompatible") throw new RenderRefused(verdict.reason);
  const minor = verdict.negotiation.kind === "Negotiated" ? verdict.negotiation.protocol.minor : 0;

  // One round: answer every outstanding effect, in order, and apply what the
  // engine answers each time.
  const round = async (progress: Progress): Promise<Progress> => {
    const answered = await progress.effects.reduce<Promise<Progress>>(async (done, effect) => {
      const previous = await done;
      const { result, refused } = await answer(effect, options, minor);
      const response = await options.engine.dispatch({ kind: "EffectResult", result });
      return { view: response.view, effects: [...previous.effects, ...response.effects], rounds: previous.rounds, refused: refused === undefined ? previous.refused : [...previous.refused, refused] };
    }, Promise.resolve({ ...progress, effects: [] }));
    return { ...answered, rounds: progress.rounds + 1 };
  };
  const settle = async (progress: Progress): Promise<Progress> =>
    progress.effects.length === 0 || progress.rounds >= maxRounds || Date.now() > deadline ? progress : settle(await round(progress));
  const settled = await settle({ view: first.view, effects: first.effects, rounds: 0, refused: [] });

  const rendered = renderProjection(parse(options.page), settled.view, options.url);
  return { html: serialize(rendered.nodes), view: settled.view, settled: settled.effects.length === 0, rounds: settled.rounds, refusals: rendered.refusals, refused: settled.refused };
};

// Static generation: the same render for each route, at build time. Writing
// the files is the caller's; this returns path → HTML.
export const renderStatic = async (routes: readonly string[], options: Omit<RenderOptions, "url" | "engine"> & { readonly origin: string; readonly engine: () => EngineTransport }): Promise<ReadonlyMap<string, RenderResult>> =>
  new Map(await routes.reduce<Promise<readonly (readonly [string, RenderResult])[]>>(async (done, route) => {
    const previous = await done;
    return [...previous, [route, await renderRoute({ ...options, url: new URL(route, options.origin).href, engine: options.engine() })] as const];
  }, Promise.resolve([])));
