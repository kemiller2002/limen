// The measurement and observer capability pack (kemiller2002/limen#25,
// LCP-014): layout and visibility facts without DOM nodes. The engine names a
// target (data-measure-target, and data-measure-key inside a row), asks for a
// rectangle, the viewport, or a subscription; subscription updates arrive as
// capability facts under an opaque id. What a size or a visibility means —
// load more, collapse a menu, virtualize a list — stays the engine's decision.
//
// A removed target ends its subscription deterministically: one
// TargetRemoved fact, then nothing. Optional: nothing in Core imports this.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { createHandleTable } from "../../capability-support/handles.js";
import { resolveTarget } from "../../capability-support/targets.js";
import { CAPABILITY_OFFER, type MeasureFact, type MeasureRequest, type MeasureResult, type MeasureTarget, type SubscriptionId } from "./generated/measure.js";
import { decodeMeasureRequest } from "./generated/measure.codec.js";

export { CAPABILITY_OFFER as MEASURE_CAPABILITY } from "./generated/measure.js";
export type { MeasureFact, MeasureRequest, MeasureResult, MeasureTarget, Rect, SubscriptionId, Viewport } from "./generated/measure.js";
export { decodeMeasureFact, decodeMeasureRequest, decodeMeasureResult } from "./generated/measure.codec.js";

const ATTRIBUTES = { name: "data-measure-target", key: "data-measure-key" } as const;

type Subscription = { readonly target: Element; readonly stop: () => void };
// The document's own window, with its constructors (ResizeObserver, …).
type View = Window & typeof globalThis;

// The one place a handle-table id becomes the contract's opaque brand.
const subscriptionId = (id: string): SubscriptionId => id as SubscriptionId;

export const measureCapability = (): CapabilityProvider => {
  // Owned by this provider instance: its live subscriptions, the host it was
  // activated with, and the one watcher that notices removed targets.
  const table = createHandleTable<Subscription>();
  const wiring: { host?: CapabilityHost<MeasureFact>; watcher?: MutationObserver | undefined } = {};

  const emit = (fact: MeasureFact): void => { wiring.host?.emitFact(fact); };

  // An observer callback already queued when its subscription ended must not
  // speak after TargetRemoved or Unsubscribed: only a live subscription emits.
  const emitWhileLive = (fact: MeasureFact & { readonly subscription: SubscriptionId }): void => {
    if (table.use(fact.subscription).kind === "Live") emit(fact);
  };

  // After any DOM change, every subscription whose target has left the
  // document ends: observers disconnected, handle disposed, one fact sent.
  const sweep = (): void => {
    table.entries()
      .filter(([, subscription]) => !subscription.target.isConnected)
      .forEach(([id]) => {
        table.dispose(id);
        emit({ kind: "TargetRemoved", subscription: subscriptionId(id) });
      });
    if (table.size() === 0) {
      wiring.watcher?.disconnect();
      wiring.watcher = undefined;
    }
  };

  const watch = (view: View, document: Document): void => {
    if (wiring.watcher !== undefined) return;
    const watcher = new view.MutationObserver(sweep);
    watcher.observe(document.documentElement, { childList: true, subtree: true });
    wiring.watcher = watcher;
  };

  const subscribe = (view: View, document: Document, element: Element, start: (id: SubscriptionId) => () => void): MeasureResult => {
    // The observer needs the id before it exists; the id needs the observer's
    // stop. A holder filled once, before any callback can run, closes the loop.
    const holder: { stop?: () => void } = {};
    const id = subscriptionId(table.create({ target: element, stop: () => holder.stop?.() }, (subscription) => subscription.stop()));
    holder.stop = start(id);
    watch(view, document);
    return { kind: "Subscribed", subscription: id };
  };

  const located = (document: Document, target: MeasureTarget, found: (element: Element) => MeasureResult): MeasureResult => {
    const resolved = resolveTarget(document, ATTRIBUTES, target);
    switch (resolved.kind) {
      case "NotFound": return { kind: "NotFound" };
      case "Ambiguous": return { kind: "Ambiguous", count: resolved.count };
      case "Found": return found(resolved.element);
    }
  };

  const perform = (request: MeasureRequest, view: View, document: Document): MeasureResult => {
    switch (request.operation) {
      case "measure":
        return located(document, request.target, (element) => {
          const rect = element.getBoundingClientRect();
          return { kind: "Measured", rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        });
      case "viewport": {
        const root = document.documentElement;
        return {
          kind: "ViewportMeasured",
          viewport: { width: view.innerWidth, height: view.innerHeight, scrollX: view.scrollX, scrollY: view.scrollY, scrollWidth: root.scrollWidth, scrollHeight: root.scrollHeight, devicePixelRatio: view.devicePixelRatio },
        };
      }
      case "observeSize":
        if (typeof view.ResizeObserver !== "function") return { kind: "Unsupported" };
        return located(document, request.target, (element) => subscribe(view, document, element, (id) => {
          const observer = new view.ResizeObserver((entries) => {
            const last = entries.at(-1);
            if (last !== undefined) emitWhileLive({ kind: "Resized", subscription: id, width: last.contentRect.width, height: last.contentRect.height });
          });
          observer.observe(element);
          return () => observer.disconnect();
        }));
      case "observeVisibility":
        if (!(request.threshold >= 0 && request.threshold <= 1)) return { kind: "InvalidThreshold" };
        if (typeof view.IntersectionObserver !== "function") return { kind: "Unsupported" };
        return located(document, request.target, (element) => subscribe(view, document, element, (id) => {
          const observer = new view.IntersectionObserver((entries) => {
            const last = entries.at(-1);
            if (last !== undefined) emitWhileLive({ kind: "Visibility", subscription: id, intersecting: last.isIntersecting, ratio: last.intersectionRatio });
          }, { threshold: request.threshold });
          observer.observe(element);
          return () => observer.disconnect();
        }));
      case "unsubscribe": {
        const disposal = table.dispose(request.subscription);
        if (table.size() === 0) sweep();
        return disposal.kind === "Disposed" ? { kind: "Unsubscribed" } : { kind: "Stale", reason: disposal.reason };
      }
    }
  };

  const execute = async (request: MeasureRequest, context: CapabilityRequestContext): Promise<MeasureResult> => {
    const view = context.document.defaultView;
    if (context.signal.aborted) return { kind: "Cancelled" };
    return view === null ? { kind: "Unsupported" } : perform(request, view, context.document);
  };

  return defineCapability<MeasureRequest, MeasureResult, MeasureFact>({
    offer: CAPABILITY_OFFER,
    decodeRequest: decodeMeasureRequest,
    execute,
    activate: (host) => { wiring.host = host; },
  });
};
