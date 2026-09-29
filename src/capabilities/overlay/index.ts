// The overlay and top-layer capability pack (kemiller2002/limen#49, LCP-013),
// native-first. The pack calls the browser's own <dialog> and popover methods
// on named targets (data-overlay-target, and data-overlay-key inside a row)
// and reports what the browser did. The browser owns the top layer, inertness
// behind a modal, focus entry and focus return; the engine owns whether an
// overlay should be open.
//
// A dismissal the browser performs on its own — Escape, a close request, light
// dismiss, a method=dialog form — is reported once as a Dismissed fact, which
// the engine adopts. Closes the engine asked for are not reported back.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { resolveTarget } from "../../capability-support/targets.js";
import { CAPABILITY_OFFER, type OverlayFact, type OverlayRequest, type OverlayResult, type OverlayTarget, type Placement, type Side } from "./generated/overlay.js";
import { decodeOverlayRequest } from "./generated/overlay.codec.js";

export { CAPABILITY_OFFER as OVERLAY_CAPABILITY } from "./generated/overlay.js";
export type { DismissReason, OverlayFact, OverlayRequest, OverlayResult, OverlayTarget, Placement, Side } from "./generated/overlay.js";
export { decodeOverlayFact, decodeOverlayRequest, decodeOverlayResult } from "./generated/overlay.codec.js";

const ATTRIBUTES = { name: "data-overlay-target", key: "data-overlay-key" } as const;

// The methods the pack calls, read by name so an element from any window — or
// a browser without them — is handled the same way.
type DialogLike = Element & { open: boolean; returnValue: string; show(): void; showModal(): void; close(returnValue?: string): void };
type PopoverLike = HTMLElement & { showPopover(): void; hidePopover(): void };
type Box = { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number; readonly width: number; readonly height: number };

const isDialog = (element: Element): boolean => element.localName === "dialog";
const dialogSupported = (element: Element): element is DialogLike => "showModal" in element && typeof element.showModal === "function";
const popoverSupported = (element: Element): element is PopoverLike => "showPopover" in element && typeof element.showPopover === "function";
const popoverOpen = (element: Element): boolean => { try { return element.matches(":popover-open"); } catch { return false; } };

// The browser's exception, by name only: its message may describe the page.
const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "unknown";

const attempt = (act: () => OverlayResult): OverlayResult => {
  try {
    return act();
  } catch (error) {
    return { kind: "Refused", reason: nameOf(error) };
  }
};

// An event's target or submitter, if it is an element (from any window).
const asElement = (value: unknown): Element | undefined =>
  typeof value === "object" && value !== null && "localName" in value && "closest" in value ? (value as Element) : undefined;

// ---------------------------------------------------------------------------
// Anchored placement: a pure choice over rectangles, then one style write
// ---------------------------------------------------------------------------

const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(value, Math.max(low, high)));

// Where `popup` would sit on `side` of `anchor`, and whether it fits the viewport.
export const place = (anchor: Box, popup: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }, side: Side, rtl: boolean): Placement => {
  const physical = side === "after" ? (rtl ? "left" : "right") : side === "before" ? (rtl ? "right" : "left") : side;
  switch (physical) {
    case "below":
    case "above": {
      const y = physical === "below" ? anchor.bottom : anchor.top - popup.height;
      return { side, x: clamp(rtl ? anchor.right - popup.width : anchor.left, 0, viewport.width - popup.width), y, fits: y >= 0 && y + popup.height <= viewport.height };
    }
    case "right":
    case "left": {
      const x = physical === "right" ? anchor.right : anchor.left - popup.width;
      return { side, x, y: clamp(anchor.top, 0, viewport.height - popup.height), fits: x >= 0 && x + popup.width <= viewport.width };
    }
  }
};

export const choosePlacement = (anchor: Box, popup: { readonly width: number; readonly height: number }, viewport: { readonly width: number; readonly height: number }, sides: readonly Side[], rtl: boolean): Placement => {
  const candidates = (sides.length > 0 ? sides : (["below"] as const)).map((side) => place(anchor, popup, viewport, side, rtl));
  const fitting = candidates.find((candidate) => candidate.fits);
  return fitting ?? { ...(candidates[0] as Placement), fits: false };
};

const anchorTo = (document: Document, popup: PopoverLike, anchor: Element, sides: readonly Side[]): Placement => {
  const view = document.defaultView;
  const placement = choosePlacement(anchor.getBoundingClientRect(), popup.getBoundingClientRect(), { width: view?.innerWidth ?? 0, height: view?.innerHeight ?? 0 }, sides, view?.getComputedStyle(anchor).direction === "rtl");
  // CSSOM writes, not a style attribute: permitted under style-src 'self'.
  // A popover is position: fixed in the top layer, so viewport coordinates apply.
  Object.assign(popup.style, { inset: "auto", margin: "0", left: `${placement.x}px`, top: `${placement.y}px` });
  return placement;
};

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

export const overlayCapability = (): CapabilityProvider => {
  // Overlays the engine asked to close: their next close is not a dismissal.
  const requested = new WeakSet<Element>();
  // Dialogs whose own method=dialog form was just submitted: their close is a
  // submission. Every other close the engine did not ask for is a cancel —
  // browsers skip the cancel event for a repeated Escape without user
  // activation, so its absence proves nothing.
  const submitted = new WeakSet<Element>();
  const wiring: { host?: CapabilityHost<OverlayFact> } = {};

  const identity = (element: Element): OverlayTarget | undefined => {
    const name = element.getAttribute(ATTRIBUTES.name);
    const key = element.closest(`[${ATTRIBUTES.key}]`)?.getAttribute(ATTRIBUTES.key) ?? undefined;
    return name === null ? undefined : { name, ...(key !== undefined ? { key } : {}) };
  };

  // True once, when the engine asked for this close; the mark is consumed.
  const consumeRequested = (element: Element): boolean => requested.delete(element);

  const report = (element: Element, fact: (target: OverlayTarget) => OverlayFact): void => {
    const target = identity(element);
    if (target !== undefined) wiring.host?.emitFact(fact(target));
  };

  const onSubmit = (event: Event): void => {
    const form = asElement(event.target);
    const submitter = asElement("submitter" in event ? event.submitter : undefined);
    const method = (submitter?.getAttribute("formmethod") ?? form?.getAttribute("method") ?? "").toLowerCase();
    const dialog = form?.closest("dialog");
    if (method === "dialog" && dialog !== null && dialog !== undefined) submitted.add(dialog);
  };

  const onClose = (event: Event): void => {
    const element = asElement(event.target);
    if (element === undefined || !isDialog(element)) return;
    const wasSubmitted = submitted.delete(element);
    if (consumeRequested(element)) return;
    const returnValue = "returnValue" in element && typeof element.returnValue === "string" ? element.returnValue : "";
    report(element, (target) => wasSubmitted
      ? { kind: "Dismissed", target, reason: "submitted", ...(returnValue !== "" ? { returnValue } : {}) }
      : { kind: "Dismissed", target, reason: "cancel" });
  };

  const onToggle = (event: Event): void => {
    const element = asElement(event.target);
    const newState = "newState" in event ? event.newState : undefined;
    if (element === undefined || newState !== "closed" || !element.hasAttribute("popover")) return;
    if (consumeRequested(element)) return;
    report(element, (target) => ({ kind: "Dismissed", target, reason: "lightDismiss" }));
  };

  const activate = (host: CapabilityHost<OverlayFact>): void => {
    wiring.host = host;
    // close and toggle do not bubble; a capturing listener on the document
    // still sees every one.
    host.document.addEventListener("submit", onSubmit, true);
    host.document.addEventListener("close", onClose, true);
    host.document.addEventListener("toggle", onToggle, true);
  };

  const located = (document: Document, target: OverlayTarget, found: (element: Element) => OverlayResult): OverlayResult => {
    const resolved = resolveTarget(document, ATTRIBUTES, target);
    switch (resolved.kind) {
      case "NotFound": return { kind: "NotFound" };
      case "Ambiguous": return { kind: "Ambiguous", count: resolved.count };
      case "Found": return found(resolved.element);
    }
  };

  const dialog = (document: Document, target: OverlayTarget, act: (element: DialogLike) => OverlayResult): OverlayResult =>
    located(document, target, (element) => {
      if (!isDialog(element)) return { kind: "WrongElement" };
      return dialogSupported(element) ? attempt(() => act(element)) : { kind: "Unsupported" };
    });

  const popover = (document: Document, target: OverlayTarget, act: (element: PopoverLike) => OverlayResult): OverlayResult =>
    located(document, target, (element) => {
      if (!element.hasAttribute("popover")) return { kind: "WrongElement" };
      return popoverSupported(element) ? attempt(() => act(element)) : { kind: "Unsupported" };
    });

  const perform = (request: OverlayRequest, document: Document): OverlayResult => {
    switch (request.operation) {
      case "showModal":
      case "show":
        return dialog(document, request.target, (element) => {
          if (element.open) return { kind: "AlreadyOpen" };
          if (request.operation === "showModal") element.showModal(); else element.show();
          return { kind: "Shown" };
        });
      case "close":
        return dialog(document, request.target, (element) => {
          if (!element.open) return { kind: "NotOpen" };
          requested.add(element);
          element.close(request.returnValue);
          return { kind: "Closed" };
        });
      case "showPopover": {
        const anchor = request.anchor === undefined ? undefined : resolveTarget(document, ATTRIBUTES, request.anchor);
        if (anchor !== undefined && anchor.kind !== "Found") return anchor.kind === "NotFound" ? { kind: "NotFound" } : { kind: "Ambiguous", count: anchor.count };
        return popover(document, request.target, (element) => {
          if (popoverOpen(element)) return { kind: "AlreadyOpen" };
          element.showPopover();
          return anchor === undefined ? { kind: "Shown" } : { kind: "Shown", placement: anchorTo(document, element, anchor.element, request.sides) };
        });
      }
      case "hidePopover":
        return popover(document, request.target, (element) => {
          if (!popoverOpen(element)) return { kind: "NotOpen" };
          requested.add(element);
          element.hidePopover();
          return { kind: "Closed" };
        });
      case "support":
        return { kind: "Support", dialog: dialogSupported(document.createElement("dialog")), popover: popoverSupported(document.createElement("div")) };
    }
  };

  const execute = async (request: OverlayRequest, context: CapabilityRequestContext): Promise<OverlayResult> =>
    context.signal.aborted ? { kind: "Cancelled" } : perform(request, context.document);

  return defineCapability<OverlayRequest, OverlayResult, OverlayFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeOverlayRequest, execute, activate });
};
