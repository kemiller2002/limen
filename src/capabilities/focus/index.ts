// The focus, selection and scroll capability pack (kemiller2002/limen#23,
// LCP-007): imperative presentation mechanics a projection cannot express.
//
// The engine decides when and where focus moves; this pack performs the move
// and reports exactly what happened. It keeps no state, retries nothing, and
// never decides what a target means. Targets are names in the HTML
// (data-focus-target), optionally narrowed to a row (data-focus-key) and
// guarded by a screen generation (data-focus-generation) — both projected by
// the engine through ordinary data-bind-data-* bindings — so no DOM node ever
// crosses the boundary.
//
// Optional: nothing in Core imports this module. An application that does not
// register focusCapability() loads none of it.

import { defineCapability, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type FocusRequest, type FocusResult, type FocusTarget } from "./generated/focus.js";
import { decodeFocusRequest } from "./generated/focus.codec.js";

export { CAPABILITY_OFFER as FOCUS_CAPABILITY } from "./generated/focus.js";
export type { FocusRequest, FocusResult, FocusTarget, ScrollBlock } from "./generated/focus.js";
export { decodeFocusRequest, decodeFocusResult } from "./generated/focus.codec.js";

type Focusable = Element & HTMLOrSVGElement;
type Resolution = { readonly kind: "Found"; readonly element: Focusable } | { readonly kind: "Answer"; readonly result: FocusResult };

const DONE: FocusResult = { kind: "Done" };

// Elements that can take focus by default, in document order; the browser
// still has the last word (disabled, hidden and inert elements refuse).
const FOCUS_CANDIDATES = [
  "a[href]", "area[href]", "button", "input:not([type=hidden])", "select", "textarea", "iframe", "summary",
  "audio[controls]", "video[controls]", "[tabindex]:not([tabindex='-1'])", "[contenteditable]:not([contenteditable='false'])",
].join(", ");

const quoted = (value: string): string => `"${value.replace(/["\\]/g, (character) => `\\${character}`)}"`;

const isFocusable = (element: Element): element is Focusable => "focus" in element && typeof element.focus === "function";

const nearest = (element: Element, attribute: string): string | null => element.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null;

// Name → row key → exactly one element → current generation. Each step that
// fails is an answer the engine can act on, not an exception.
const resolve = (document: Document, target: FocusTarget): Resolution => {
  const named = Array.from(document.querySelectorAll(`[data-focus-target=${quoted(target.name)}]`));
  const matches = target.key === undefined ? named : named.filter((element) => nearest(element, "data-focus-key") === target.key);
  const [only, ...others] = matches;
  if (only === undefined) return { kind: "Answer", result: { kind: "NotFound" } };
  if (others.length > 0) return { kind: "Answer", result: { kind: "Ambiguous", count: matches.length } };
  const current = nearest(only, "data-focus-generation") ?? "";
  if (target.generation !== undefined && target.generation !== current) return { kind: "Answer", result: { kind: "Stale", current } };
  return isFocusable(only) ? { kind: "Found", element: only } : { kind: "Answer", result: { kind: "NotFocusable" } };
};

const focused = (element: Focusable, preventScroll: boolean): boolean => {
  element.focus({ preventScroll });
  return element.ownerDocument.activeElement === element;
};

// A text control is one whose selection can be set; number, email and the
// like throw InvalidStateError, which is the browser saying "not selectable".
const selectRange = (element: Focusable, start: number, end: number): FocusResult => {
  if (!("setSelectionRange" in element) || typeof element.setSelectionRange !== "function") return { kind: "NotSelectable" };
  if (!focused(element, false)) return { kind: "NotFocusable" };
  try {
    element.setSelectionRange(start, end);
    return DONE;
  } catch {
    return { kind: "NotSelectable" };
  }
};

const textLength = (element: Focusable): number => ("value" in element && typeof element.value === "string" ? element.value.length : 0);

const within = (scope: Focusable, last: boolean): FocusResult => {
  const candidates = Array.from(scope.querySelectorAll(FOCUS_CANDIDATES)).filter(isFocusable);
  const ordered = last ? [...candidates].reverse() : candidates;
  // The first candidate the browser actually focuses wins; a refused one
  // leaves focus where it was.
  return ordered.some((candidate) => focused(candidate, false)) ? DONE : { kind: "NotFocusable" };
};

const perform = (request: FocusRequest, document: Document): FocusResult => {
  if (request.operation === "select" && (request.start < 0 || request.end < 0 || request.start > request.end)) return { kind: "InvalidRange" };
  const target = "target" in request ? request.target : request.scope;
  const resolved = resolve(document, target);
  if (resolved.kind === "Answer") return resolved.result;
  const element = resolved.element;
  switch (request.operation) {
    case "focus":
      return focused(element, request.preventScroll) ? DONE : { kind: "NotFocusable" };
    case "blur":
      if (document.activeElement === element) element.blur();
      return DONE;
    case "focusFirst":
      return within(element, false);
    case "focusLast":
      return within(element, true);
    case "select":
      return selectRange(element, request.start, request.end);
    case "selectAll":
      return selectRange(element, 0, textLength(element));
    case "scrollIntoView":
      if (!("scrollIntoView" in element) || typeof element.scrollIntoView !== "function") return { kind: "Unavailable" };
      element.scrollIntoView({ block: request.block, behavior: request.smooth ? "smooth" : "auto" });
      return DONE;
  }
};

const execute = async (request: FocusRequest, context: CapabilityRequestContext): Promise<FocusResult> =>
  context.signal.aborted ? { kind: "Cancelled" } : perform(request, context.document);

export const focusCapability = (): CapabilityProvider =>
  defineCapability<FocusRequest, FocusResult>({ offer: CAPABILITY_OFFER, decodeRequest: decodeFocusRequest, execute });
