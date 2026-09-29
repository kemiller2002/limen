// Resource hints and view transitions (kemiller2002/limen#34, LCP-025/026).
//
// Hints: the engine asks for a preconnect, preload, modulepreload or prefetch
// the static HTML cannot express (it depends on where the user is going); the
// pack adds one <link> to the head, and never a second — a link with the same
// rel and resolved href, written in the HTML or added earlier, answers
// AlreadyPresent.
//
// View transitions: a transition must capture the old view before the new one
// is written, and the kernel applies a projection before it runs that
// projection's effects. So the engine asks first — prepareTransition — and the
// pack starts document.startViewTransition, answers Ready once the browser has
// captured the old view, and completes the transition when the engine's next
// projection changes the page (or after timeoutMs, without animating). The
// engine's label becomes the transition's type and data-view-transition on the
// root, so CSS decides what animates, including under reduced motion. A
// browser without view transitions answers Unsupported, and the engine simply
// renders.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type PresentationFact, type PresentationRequest, type PresentationResult, type TransitionEnd } from "./generated/presentation.js";
import { decodePresentationRequest } from "./generated/presentation.codec.js";

export { CAPABILITY_OFFER as PRESENTATION_CAPABILITY } from "./generated/presentation.js";
export type { HintKind, PreloadAs, PresentationFact, PresentationRequest, PresentationResult, TransitionEnd } from "./generated/presentation.js";
export { decodePresentationFact, decodePresentationRequest, decodePresentationResult } from "./generated/presentation.codec.js";

type View = Window & typeof globalThis;
type Hint = Extract<PresentationRequest, { operation: "hint" }>;
type Prepare = Extract<PresentationRequest, { operation: "prepareTransition" }>;

// The parts of the View Transition API the pack uses, by shape.
type ViewTransitionLike = { readonly finished: Promise<unknown>; readonly updateCallbackDone: Promise<unknown> };
type Starter = (update: (() => Promise<void>) | { readonly update: () => Promise<void>; readonly types: readonly string[] }) => ViewTransitionLike;

const LABEL = /^[a-z][a-z0-9-]{0,63}$/;
const TRANSITION_ATTRIBUTE = "data-view-transition";

const startViewTransition = (document: Document): Starter | undefined => {
  const start: unknown = Reflect.get(document, "startViewTransition");
  return typeof start === "function" ? (update) => Reflect.apply(start, document, [update]) as ViewTransitionLike : undefined;
};

// Transition types (a label CSS can select with :active-view-transition-type)
// arrived after view transitions themselves; without them, the root attribute
// alone carries the label.
const supportsTypes = (view: View): boolean => {
  const constructor: unknown = Reflect.get(view, "ViewTransition");
  return typeof constructor === "function" && "types" in (constructor as { prototype: object }).prototype;
};

const resolveHref = (view: View, document: Document, href: string): { readonly kind: "Url"; readonly href: string } | { readonly kind: "Invalid"; readonly scheme: string } => {
  if (!view.URL.canParse(href, document.baseURI)) return { kind: "Invalid", scheme: "" };
  const url = new view.URL(href, document.baseURI);
  return url.protocol === "http:" || url.protocol === "https:" ? { kind: "Url", href: url.href } : { kind: "Invalid", scheme: url.protocol.replace(/:$/, "") };
};

const hint = (view: View, document: Document, request: Hint): PresentationResult => {
  if (request.kind === "preload" && request.as === undefined) return { kind: "InvalidRequest", problem: "preload needs as" };
  const url = resolveHref(view, document, request.href);
  if (url.kind === "Invalid") return { kind: "InvalidUrl", scheme: url.scheme };
  const link = document.createElement("link");
  const supported = (() => { try { return link.relList.supports(request.kind); } catch { return false; } })();
  if (!supported) return { kind: "Unsupported" };
  const present = Array.from(document.querySelectorAll("link[rel]"))
    .some((existing) => existing instanceof view.HTMLLinkElement && existing.relList.contains(request.kind) && existing.href === url.href);
  if (present) return { kind: "AlreadyPresent" };
  link.rel = request.kind;
  link.href = url.href;
  if (request.kind === "preload" && request.as !== undefined) link.setAttribute("as", request.as);
  if (request.crossOrigin) link.crossOrigin = "anonymous";
  document.head.append(link);
  return { kind: "Added" };
};

export const presentationCapability = (): CapabilityProvider => {
  const wiring: { host?: CapabilityHost<PresentationFact>; pending: boolean } = { pending: false };

  const prepare = (view: View, document: Document, request: Prepare): Promise<PresentationResult> => {
    if (!LABEL.test(request.label)) return Promise.resolve({ kind: "InvalidRequest", problem: "label must be a lower-case CSS identifier" });
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 10000) return Promise.resolve({ kind: "InvalidRequest", problem: "timeoutMs must be 1 to 10000" });
    const start = startViewTransition(document);
    if (start === undefined) return Promise.resolve({ kind: "Unsupported" });
    if (wiring.pending) return Promise.resolve({ kind: "Busy" });
    wiring.pending = true;

    return new Promise<PresentationResult>((resolve) => {
      const root = document.documentElement;
      const state = { timedOut: false };
      // Called by the browser once the old view is captured: answer Ready,
      // then wait for the engine's projection to change the page.
      const update = (): Promise<void> => new Promise<void>((done) => {
        resolve({ kind: "Ready" });
        const finish = (timedOut: boolean): void => {
          observer.disconnect();
          view.clearTimeout(timer);
          state.timedOut = timedOut;
          done();
        };
        const observer = new view.MutationObserver(() => finish(false));
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
        const timer = view.setTimeout(() => finish(true), request.timeoutMs);
      });
      const report = (outcome: TransitionEnd): void => {
        root.removeAttribute(TRANSITION_ATTRIBUTE);
        wiring.pending = false;
        wiring.host?.emitFact({ kind: "TransitionFinished", label: request.label, outcome });
      };
      root.setAttribute(TRANSITION_ATTRIBUTE, request.label);
      try {
        const transition = start(supportsTypes(view) ? { update, types: [request.label] } : update);
        // If the browser skips before capturing, Ready is still owed.
        transition.updateCallbackDone.catch(() => resolve({ kind: "Ready" }));
        transition.finished.then(() => report(state.timedOut ? "timedOut" : "finished"), () => report("skipped"));
      } catch {
        root.removeAttribute(TRANSITION_ATTRIBUTE);
        wiring.pending = false;
        resolve({ kind: "Unsupported" });
      }
    });
  };

  const execute = async (request: PresentationRequest, context: CapabilityRequestContext): Promise<PresentationResult> => {
    const view = context.document.defaultView;
    if (context.signal.aborted) return { kind: "Cancelled" };
    if (view === null) return { kind: "Unsupported" };
    switch (request.operation) {
      case "hint": return hint(view, context.document, request);
      case "prepareTransition": return prepare(view, context.document, request);
    }
  };

  return defineCapability<PresentationRequest, PresentationResult, PresentationFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodePresentationRequest, execute, activate: (host) => { wiring.host = host; } });
};
