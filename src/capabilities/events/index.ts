// The rich browser event facts capability pack (kemiller2002/limen#29,
// LCP-020). A listener is declared in HTML, separately from the simple
// data-event path, and opts into exactly the facts it needs:
//
//   <div data-rich-event="canvasDrag" data-rich-on="pointerdown pointermove pointerup"
//        data-rich-facts="pointer coordinates modifiers" data-rich-coalesce="frame"></div>
//   <input data-rich-event="shortcut" data-rich-on="keydown"
//          data-rich-facts="keyboard modifiers" data-rich-keys="Enter Escape" data-rich-prevent>
//
// Everything the browser must decide synchronously — preventDefault,
// stopPropagation, capture, passive, once, pointer capture, which keys count —
// is declared there, so the engine is never asked for a synchronous DOM
// decision. Facts reach the engine as capability facts. The pack interprets no
// shortcut or gesture, and never reports text an input method has not
// committed. Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type DragPhase, type EventsRequest, type EventsResult, type Listener, type RichEvent } from "./generated/events.js";
import { decodeEventsRequest } from "./generated/events.codec.js";

export { CAPABILITY_OFFER as EVENTS_CAPABILITY } from "./generated/events.js";
export type { EventsRequest, EventsResult, Listener, RichEvent } from "./generated/events.js";
export { decodeEventsRequest, decodeEventsResult, decodeRichEvent } from "./generated/events.codec.js";

const GROUPS = ["keyboard", "modifiers", "pointer", "coordinates", "drag", "composition", "selection", "input", "value", "direction"] as const;
type Group = (typeof GROUPS)[number];
const isGroup = (word: string): word is Group => GROUPS.some((group) => group === word);

type Declaration = {
  readonly name: string;
  // One or more DOM event types sharing the facts and mechanics, so pointer
  // capture on pointerdown and the moves it captures are one declaration.
  readonly types: readonly string[];
  readonly groups: ReadonlySet<Group>;
  readonly keys: readonly string[] | undefined;
  readonly prevent: boolean;
  readonly stop: boolean;
  readonly capture: boolean;
  readonly passive: boolean;
  readonly once: boolean;
  readonly coalesce: boolean;
  readonly pointerCapture: boolean;
};

type Parsed = { readonly kind: "Bindable"; readonly declaration: Declaration } | { readonly kind: "Refused"; readonly listener: Listener };

const words = (value: string | null): readonly string[] => (value ?? "").split(/[\s,]+/).filter((word) => word !== "");

// The declaration is the whole contract between the HTML author and the pack.
export const parseDeclaration = (element: Element): Parsed => {
  const name = element.getAttribute("data-rich-event") ?? "";
  const types = words(element.getAttribute("data-rich-on"));
  const type = types.join(" ");
  const refuse = (refused: string): Parsed => ({ kind: "Refused", listener: { name, type, refused } });
  if (name === "" || type === "") return refuse("data-rich-event and data-rich-on are both required");
  const requested = words(element.getAttribute("data-rich-facts"));
  const unknown = requested.filter((word) => !isGroup(word));
  if (unknown.length > 0) return refuse(`unknown fact group(s): ${unknown.join(", ")}`);
  const flag = (attribute: string): boolean => element.hasAttribute(attribute);
  const coalesce = element.getAttribute("data-rich-coalesce");
  if (coalesce !== null && coalesce !== "frame") return refuse(`data-rich-coalesce supports only "frame"`);
  if (flag("data-rich-passive") && flag("data-rich-prevent")) return refuse("a passive listener cannot prevent the default action");
  const keys = element.hasAttribute("data-rich-keys") ? words(element.getAttribute("data-rich-keys")) : undefined;
  return {
    kind: "Bindable",
    declaration: {
      name, types, keys,
      groups: new Set(requested.filter(isGroup)),
      prevent: flag("data-rich-prevent"),
      stop: flag("data-rich-stop"),
      capture: flag("data-rich-capture"),
      passive: flag("data-rich-passive"),
      once: flag("data-rich-once"),
      coalesce: coalesce === "frame",
      pointerCapture: flag("data-rich-pointer-capture"),
    },
  };
};

// Reading event fields without asserting the event's class: jsdom and every
// browser agree on the property names, not always on the constructors.
const read = (event: Event, field: string): unknown => Reflect.get(event, field);
const text = (event: Event, field: string): string | undefined => { const value = read(event, field); return typeof value === "string" ? value : undefined; };
const number = (event: Event, field: string): number | undefined => { const value = read(event, field); return typeof value === "number" ? value : undefined; };
const flagOf = (event: Event, field: string): boolean => read(event, field) === true;
const composing = (event: Event): boolean => flagOf(event, "isComposing");

const DRAG_PHASES: Readonly<Record<string, DragPhase>> = { dragstart: "start", dragenter: "enter", dragover: "over", dragleave: "leave", drop: "drop", dragend: "end" };

const dragFacts = (event: Event): RichEvent["drag"] => {
  const phase = DRAG_PHASES[event.type];
  if (phase === undefined) return undefined;
  const transfer = read(event, "dataTransfer");
  const types = transfer !== null && typeof transfer === "object" ? Reflect.get(transfer, "types") : undefined;
  const files = transfer !== null && typeof transfer === "object" ? Reflect.get(transfer, "files") : undefined;
  const count = files !== null && typeof files === "object" ? Reflect.get(files, "length") : 0;
  // DataTransfer.types is a frozen array of strings in every current browser.
  return { phase, types: Array.isArray(types) ? types.filter((item): item is string => typeof item === "string") : [], fileCount: typeof count === "number" ? count : 0 };
};

const compositionFacts = (event: Event): RichEvent["composition"] => {
  switch (event.type) {
    case "compositionstart": return { phase: "start" };
    case "compositionupdate": return { phase: "update" };
    case "compositionend": return { phase: "end", committed: text(event, "data") ?? "" };
    default: return undefined;
  }
};

const selectionFacts = (element: Element): RichEvent["selection"] => {
  const start = Reflect.get(element, "selectionStart");
  const end = Reflect.get(element, "selectionEnd");
  const direction = Reflect.get(element, "selectionDirection");
  return typeof start === "number" && typeof end === "number" ? { start, end, direction: typeof direction === "string" ? direction : "none" } : undefined;
};

// The computed direction (dir attribute, inherited, or CSS): an environment
// fact, reported only — which arrow means "next" is the engine's decision.
const directionOf = (element: Element): "ltr" | "rtl" => {
  const view = element.ownerDocument.defaultView;
  const computed = view === null ? "" : view.getComputedStyle(element).direction;
  const declared = element.closest("[dir]")?.getAttribute("dir");
  return (computed === "rtl" || computed === "ltr" ? computed : declared) === "rtl" ? "rtl" : "ltr";
};

// Pure: the fact for one event, carrying only the groups the listener asked for.
export const factOf = (event: Event, declaration: Declaration, element: Element): RichEvent => {
  const wants = (group: Group): boolean => declaration.groups.has(group);
  const key = element.closest("[data-rich-key]")?.getAttribute("data-rich-key") ?? undefined;
  const value = Reflect.get(element, "value");
  const keyName = text(event, "key");
  const pointerType = text(event, "pointerType");
  const inputType = text(event, "inputType");
  const data = text(event, "data");
  const drag = wants("drag") ? dragFacts(event) : undefined;
  const composition = wants("composition") ? compositionFacts(event) : undefined;
  const selection = wants("selection") ? selectionFacts(element) : undefined;
  return {
    name: declaration.name,
    type: event.type,
    ...(key !== undefined ? { key } : {}),
    ...(wants("value") && typeof value === "string" ? { value } : {}),
    ...(wants("modifiers") ? { modifiers: { alt: flagOf(event, "altKey"), ctrl: flagOf(event, "ctrlKey"), meta: flagOf(event, "metaKey"), shift: flagOf(event, "shiftKey") } } : {}),
    ...(wants("keyboard") && keyName !== undefined ? { keyboard: { key: keyName, code: text(event, "code") ?? "", repeat: flagOf(event, "repeat"), composing: composing(event) } } : {}),
    ...(wants("pointer") && pointerType !== undefined ? {
      pointer: {
        pointerType, pointerId: number(event, "pointerId") ?? 0, button: number(event, "button") ?? 0, buttons: number(event, "buttons") ?? 0, isPrimary: flagOf(event, "isPrimary"),
        ...(wants("coordinates") ? { x: number(event, "clientX") ?? 0, y: number(event, "clientY") ?? 0 } : {}),
      },
    } : {}),
    ...(drag !== undefined ? { drag } : {}),
    ...(composition !== undefined ? { composition } : {}),
    ...(selection !== undefined ? { selection } : {}),
    // Data typed during composition is not the user's yet: it is withheld.
    ...(wants("input") && inputType !== undefined ? { input: { inputType, ...(data !== undefined && !composing(event) ? { data } : {}) } } : {}),
    ...(wants("direction") ? { direction: directionOf(element) } : {}),
  };
};

type View = Window & typeof globalThis;

// Only continuous streams are coalesced; a discrete event (down, up, drop, a
// key) is never delayed or merged, and flushes the moves before it so the
// engine hears them in the order they happened.
const CONTINUOUS: readonly string[] = ["pointermove", "pointerrawupdate", "mousemove", "touchmove", "drag", "dragover", "scroll", "wheel"];

export const eventsCapability = (): CapabilityProvider => {
  // Owned by this provider instance: the host, what is already bound, the
  // watcher for templates mounted later, and per-element pending coalesced facts.
  const wiring: { host?: CapabilityHost<RichEvent>; watcher?: MutationObserver } = {};
  const bound = new WeakSet<Element>();
  // Coalescing is per element and per event type: a pointerdown or pointerup
  // is never merged away by the moves around it.
  const pending = new WeakMap<Element, Map<string, RichEvent>>();

  const emit = (fact: RichEvent): void => { wiring.host?.emitFact(fact); };

  const flush = (element: Element): void => {
    const waiting = pending.get(element);
    if (waiting === undefined) return;
    const facts = Array.from(waiting.values());
    waiting.clear();
    facts.forEach(emit);
  };

  const bind = (view: View, element: Element): void => {
    if (bound.has(element)) return;
    bound.add(element);
    const parsed = parseDeclaration(element);
    if (parsed.kind === "Refused") return;
    const declaration = parsed.declaration;
    const nextFrame = (callback: () => void): void => {
      if (typeof view.requestAnimationFrame === "function") view.requestAnimationFrame(callback);
      else view.setTimeout(callback, 16);
    };
    const listen = (type: string): void => element.addEventListener(type, (event) => {
      const keyName = text(event, "key");
      // data-rich-keys is whitespace-separated, so the space bar (key " ") is named "Space" there.
      const listed = keyName === " " ? "Space" : keyName;
      if (declaration.keys !== undefined && (listed === undefined || !declaration.keys.includes(listed))) return;
      if (declaration.prevent) event.preventDefault();
      if (declaration.stop) event.stopPropagation();
      if (declaration.pointerCapture && event.type === "pointerdown") {
        const id = number(event, "pointerId");
        try { if (id !== undefined && "setPointerCapture" in element) element.setPointerCapture(id); } catch { /* the pointer is already gone */ }
      }
      // An input event mid-composition says nothing the user has committed.
      if ((event.type === "input" || event.type === "beforeinput") && composing(event) && !declaration.groups.has("composition")) return;
      const fact = factOf(event, declaration, element);
      if (!declaration.coalesce || !CONTINUOUS.includes(event.type)) {
        flush(element);
        emit(fact);
        return;
      }
      const waiting = pending.get(element) ?? new Map<string, RichEvent>();
      pending.set(element, waiting);
      const scheduled = waiting.has(event.type);
      waiting.set(event.type, fact);
      if (!scheduled) nextFrame(() => {
        const latest = waiting.get(event.type);
        waiting.delete(event.type);
        if (latest !== undefined) emit(latest);
      });
    }, { capture: declaration.capture, passive: declaration.passive, once: declaration.once });
    declaration.types.forEach(listen);
  };

  const bindWithin = (view: View, root: ParentNode): void => {
    if (root instanceof view.Element && root.hasAttribute("data-rich-event")) bind(view, root);
    root.querySelectorAll("[data-rich-event]").forEach((element) => bind(view, element));
  };

  const activate = (host: CapabilityHost<RichEvent>): void => {
    wiring.host = host;
    const view = host.document.defaultView;
    if (view === null) return;
    bindWithin(view, host.document);
    const watcher = new view.MutationObserver((records) => {
      records.forEach((record) => record.addedNodes.forEach((node) => { if (node instanceof view.Element) bindWithin(view, node); }));
    });
    watcher.observe(host.document.documentElement, { childList: true, subtree: true });
    wiring.watcher = watcher;
  };

  const describe = (document: Document): EventsResult => ({
    kind: "Listening",
    listeners: Array.from(document.querySelectorAll("[data-rich-event]"), (element): Listener => {
      const parsed = parseDeclaration(element);
      return parsed.kind === "Refused" ? parsed.listener : { name: parsed.declaration.name, type: parsed.declaration.types.join(" ") };
    }),
  });

  const execute = async (request: EventsRequest, context: CapabilityRequestContext): Promise<EventsResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    switch (request.operation) {
      case "describe": return describe(context.document);
    }
  };

  return defineCapability<EventsRequest, EventsResult, RichEvent>({ offer: CAPABILITY_OFFER, decodeRequest: decodeEventsRequest, execute, activate });
};
