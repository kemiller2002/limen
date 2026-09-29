// Page, connectivity and browser-lifecycle evidence (kemiller2002/limen#43,
// LCP-037).
//
// The engine never reads navigator.onLine, document.visibilityState or the
// Network Information API. It asks for the page's state, subscribes to the
// topics it needs, and hears every change as a typed fact tagged with its
// subscription. Each fact claims only what the browser proves: offline means
// no network, but online does not mean the engine's backend answers, and
// connection quality is an advisory estimate that may be absent.
//
// The pack decides nothing. It never pauses a timer, closes a socket, retries a
// request or refreshes a view because a page was hidden, frozen or restored
// from the back/forward cache: it reports, and the engine decides.
//
// It listens to pagehide and pageshow, never unload or beforeunload, whose
// listeners make a page ineligible for the back/forward cache.
//
// The event source is injectable: a fake host scripts the lifecycle for a test,
// and the engine cannot tell the difference.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type ConnectionQuality, type LifecycleFact, type LifecycleRequest, type LifecycleResult, type PageState, type Topic, type Visibility } from "./generated/lifecycle.js";
import { decodeLifecycleRequest } from "./generated/lifecycle.codec.js";

export { CAPABILITY_OFFER as LIFECYCLE_CAPABILITY } from "./generated/lifecycle.js";
export type { ConnectionQuality, LifecycleFact, LifecycleRequest, LifecycleResult, PageState, Topic, Visibility } from "./generated/lifecycle.js";
export { decodeLifecycleFact, decodeLifecycleRequest, decodeLifecycleResult } from "./generated/lifecycle.codec.js";

// One browser signal, before it is tagged with a subscription.
export type LifecycleSignal =
  | { readonly kind: "connectivity"; readonly online: boolean }
  | { readonly kind: "visibility"; readonly visibility: Visibility }
  | { readonly kind: "pagehide"; readonly persisted: boolean }
  | { readonly kind: "pageshow"; readonly persisted: boolean }
  | { readonly kind: "freeze" }
  | { readonly kind: "resume" }
  | { readonly kind: "prerenderActivated" }
  | { readonly kind: "connection"; readonly connection: ConnectionQuality };

// Where the facts come from. The browser by default; anything in a test.
export type LifecycleSource = {
  readonly state: () => PageState;
  // Calls onSignal for every signal of the named topics; returns the unsubscribe.
  readonly listen: (topics: readonly Topic[], onSignal: (signal: LifecycleSignal) => void) => () => void;
};

// The Network Information API, where it exists (Chromium). Read structurally:
// the DOM library does not declare it.
type NetworkInformationLike = EventTarget & { readonly effectiveType?: unknown; readonly downlink?: unknown; readonly rtt?: unknown; readonly saveData?: unknown };

const networkInformation = (navigator: Navigator | undefined): NetworkInformationLike | undefined => {
  const candidate: unknown = navigator === undefined ? undefined : Reflect.get(navigator, "connection");
  return candidate !== null && typeof candidate === "object" && "addEventListener" in candidate ? (candidate as NetworkInformationLike) : undefined;
};

const qualityOf = (connection: NetworkInformationLike): ConnectionQuality => ({
  ...(typeof connection.effectiveType === "string" ? { effectiveType: connection.effectiveType } : {}),
  ...(typeof connection.downlink === "number" ? { downlinkMbps: connection.downlink } : {}),
  ...(typeof connection.rtt === "number" ? { rttMs: connection.rtt } : {}),
  ...(typeof connection.saveData === "boolean" ? { saveData: connection.saveData } : {}),
});

const flag = (target: object, name: string): boolean => Reflect.get(target, name) === true;

const persistedOf = (event: Event): boolean => flag(event, "persisted");

// One listener: where it listens, for what, and the signal it becomes.
type Wire = { readonly target: EventTarget; readonly type: string; readonly signal: (event: Event) => LifecycleSignal };

export const browserSource = (document: Document): LifecycleSource => {
  const view = document.defaultView;
  const visibility = (): Visibility => (document.visibilityState === "hidden" ? "hidden" : "visible");
  const connection = networkInformation(view?.navigator);
  const wires = (topic: Topic): readonly Wire[] => {
    switch (topic) {
      case "connectivity":
        return view === null ? [] : [
          { target: view, type: "online", signal: () => ({ kind: "connectivity", online: true }) },
          { target: view, type: "offline", signal: () => ({ kind: "connectivity", online: false }) },
        ];
      case "visibility":
        return [{ target: document, type: "visibilitychange", signal: () => ({ kind: "visibility", visibility: visibility() }) }];
      case "pageLifecycle":
        return view === null ? [] : [
          { target: view, type: "pagehide", signal: (event) => ({ kind: "pagehide", persisted: persistedOf(event) }) },
          { target: view, type: "pageshow", signal: (event) => ({ kind: "pageshow", persisted: persistedOf(event) }) },
        ];
      case "freezing":
        return [
          { target: document, type: "freeze", signal: () => ({ kind: "freeze" }) },
          { target: document, type: "resume", signal: () => ({ kind: "resume" }) },
        ];
      case "prerendering":
        return [{ target: document, type: "prerenderingchange", signal: () => ({ kind: "prerenderActivated" }) }];
      case "connection":
        return connection === undefined ? [] : [{ target: connection, type: "change", signal: () => ({ kind: "connection", connection: qualityOf(connection) }) }];
    }
  };
  return {
    state: () => ({
      online: view?.navigator.onLine !== false,
      visibility: visibility(),
      prerendering: flag(document, "prerendering"),
      wasDiscarded: flag(document, "wasDiscarded"),
      ...(connection !== undefined ? { connection: qualityOf(connection) } : {}),
    }),
    listen: (topics, onSignal) => {
      const bound = [...new Set(topics)].flatMap(wires).map((wire) => ({ wire, handler: (event: Event) => onSignal(wire.signal(event)) }));
      bound.forEach(({ wire, handler }) => wire.target.addEventListener(wire.type, handler));
      return () => bound.forEach(({ wire, handler }) => wire.target.removeEventListener(wire.type, handler));
    },
  };
};

// A signal, tagged with the subscription that asked for it.
export const factOf = (subscription: string, signal: LifecycleSignal): LifecycleFact => {
  switch (signal.kind) {
    case "connectivity": return { kind: "ConnectivityChanged", subscription, online: signal.online };
    case "visibility": return { kind: "VisibilityChanged", subscription, visibility: signal.visibility };
    case "pagehide": return { kind: "PageHidden", subscription, persisted: signal.persisted };
    case "pageshow": return { kind: "PageShown", subscription, persisted: signal.persisted };
    case "freeze": return { kind: "Frozen", subscription };
    case "resume": return { kind: "Resumed", subscription };
    case "prerenderActivated": return { kind: "PrerenderActivated", subscription };
    case "connection": return { kind: "ConnectionChanged", subscription, connection: signal.connection };
  }
};

export const lifecycleCapability = (options: { readonly source?: (document: Document) => LifecycleSource } = {}): CapabilityProvider => {
  // The live subscriptions, by id; replaced, never mutated in place.
  const wiring: { host?: CapabilityHost<LifecycleFact>; issued: number; live: ReadonlyMap<string, () => void> } = { issued: 0, live: new Map() };
  const sourceFor = (document: Document): LifecycleSource => (options.source ?? browserSource)(document);

  const execute = async (request: LifecycleRequest, context: CapabilityRequestContext): Promise<LifecycleResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    const source = sourceFor(context.document);
    switch (request.operation) {
      case "describe":
        return { kind: "Described", state: source.state() };
      case "subscribe": {
        if (request.topics.length === 0) return { kind: "InvalidRequest", problem: "a subscription names at least one topic" };
        wiring.issued += 1;
        const subscription = `lifecycle-${wiring.issued}`;
        const stop = source.listen(request.topics, (signal) => wiring.host?.emitFact(factOf(subscription, signal)));
        wiring.live = new Map([...wiring.live, [subscription, stop]]);
        return { kind: "Subscribed", subscription, state: source.state() };
      }
      case "unsubscribe": {
        const stop = wiring.live.get(request.subscription);
        if (stop === undefined) return { kind: "UnknownSubscription" };
        stop();
        wiring.live = new Map([...wiring.live].filter(([id]) => id !== request.subscription));
        return { kind: "Unsubscribed" };
      }
    }
  };

  return defineCapability<LifecycleRequest, LifecycleResult, LifecycleFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeLifecycleRequest, execute, activate: (host) => { wiring.host = host; } });
};
