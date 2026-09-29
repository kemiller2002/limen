import { CORE_CONTRACT_IDENTITY, PROTOCOL_MINOR, PROTOCOL_VERSION, type BrowserLocation, type BrowserToEngineMessage, type Capability, type CapabilityEffectRequest, type CapabilityId, type CapabilityOutcome, type ClipboardEffectRequest, type ClipboardOutcome, type CorrelationId, type EffectOutcome, type EffectRequest, type EffectResult, type EngineToBrowserMessage, type EngineTransport, type HostHandshake, type HttpEffectRequest, type NavigationEffectRequest, type NavigationOutcome, type SemanticEvent, type StorageEffectRequest, type StorageOutcome, type ViewItem, type ViewState, type ViewValue } from "../protocol.js";
import type { CapabilityProvider } from "./capabilities.js";
import { noopDiagnostics, type DiagnosticsSink } from "./diagnostics.js";
import { verifyHandshake, type Incompatibility, type Negotiation } from "./handshake.js";
import { bindableElement, checkUrl, classifyAttribute, type AttributeTarget } from "./binding-policy.js";

// Exceptions to the "click" default: element types whose most natural
// interaction isn't a click. Any other element (a row, a card, a div acting
// as a button) falls back to click, matching plain DOM behavior; data-on
// overrides either. Purely a browser-mechanism default: it says nothing
// about what the event means.
const TRIGGER_BY_TAG: Readonly<Record<string, string>> = {
  FORM: "submit",
  INPUT: "change",
  SELECT: "change",
  TEXTAREA: "change",
};


// Announced once, in Initialize. This is the list of effect kinds the kernel
// can execute — not a promise that any of them will succeed in this browser.
// A clipboard write can still be denied and localStorage can still be absent;
// both are reported in that effect's own outcome, never by withholding the
// capability here. Keeping the announcement static means an engine's startup
// branch does not silently change between browsers.
const CAPABILITIES: readonly Capability[] = ["Http", "Storage", "Clipboard", "Navigation"];

export type KernelOptions = {
  // Optional capability packs this host implements. Each is offered in the
  // handshake; only those the engine selects are activated. An application
  // that registers none loads none.
  readonly capabilities?: readonly CapabilityProvider[];
  // Refuse engines that send no handshake (protocol 1.0) instead of running
  // them in legacy mode. Generated WebAssembly guests always handshake.
  readonly requireHandshake?: boolean;
};

// The kernel's own lifecycle. Normal traffic — events, effects, facts — flows
// only in Running. Incompatible is terminal: nothing from that engine is ever
// applied. See research/decisions/DF-LIMEN-2026-0001.
type Phase =
  | { readonly kind: "Unstarted" }
  | { readonly kind: "Starting" }
  | { readonly kind: "Running"; readonly negotiation: Negotiation }
  | { readonly kind: "Incompatible"; readonly reason: Incompatibility }
  | { readonly kind: "Faulted" };

type TextBinding = { readonly element: HTMLElement; readonly key: string };
type AttrBinding = { readonly element: HTMLElement; readonly attr: string; readonly key: string; readonly target: AttributeTarget };
type IfBinding = {
  readonly anchor: Comment;
  readonly template: HTMLTemplateElement;
  readonly key: string;
  readonly itemKey: string | undefined;
  mounted: { readonly root: HTMLElement; readonly scope: Scope } | null;
};
type EachBinding = {
  readonly anchor: Comment;
  readonly template: HTMLTemplateElement;
  readonly listKey: string;
  readonly itemKey: string;
  readonly instances: Map<string, { readonly root: HTMLElement; readonly scope: Scope }>;
};
type Scope = {
  readonly texts: TextBinding[];
  readonly attrs: AttrBinding[];
  readonly ifs: IfBinding[];
  readonly eachs: EachBinding[];
};

function emptyScope(): Scope {
  return { texts: [], attrs: [], ifs: [], eachs: [] };
}

function readValue(el: HTMLElement): string | undefined {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return el.value;
  return undefined;
}

// Protocol 1.2: what `.value` alone cannot say. A checkbox or radio's checked
// state; a multi-select's selected values, or the checked values of the
// checkbox group (same name, same form) an event came from; the name of the
// button that submitted a form. Mechanism only — what a value means is the
// engine's.
type ControlState = { readonly checked?: boolean; readonly values?: readonly string[]; readonly submitter?: string };

function readControlState(el: HTMLElement, submitter: HTMLElement | null): ControlState {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const group = el.type === "checkbox" && el.name !== ""
      ? Array.from((el.form ?? el.ownerDocument).querySelectorAll("input[type=checkbox]"))
        .filter((other): other is HTMLInputElement => other instanceof HTMLInputElement && other.name === el.name && other.form === el.form)
      : [];
    return { checked: el.checked, ...(group.length > 0 ? { values: group.filter((box) => box.checked).map((box) => box.value) } : {}) };
  }
  if (el instanceof HTMLSelectElement && el.multiple) return { values: Array.from(el.selectedOptions, (option) => option.value) };
  if (el instanceof HTMLFormElement && submitter !== null) {
    const name = submitter.getAttribute("name");
    return name !== null && name !== "" ? { submitter: name } : {};
  }
  return {};
}

// Bindings inside <template> content are bound only when a row or a
// conditional section mounts. Refuse a forbidden target there when the page
// starts, not later in the middle of a projection.
function auditTemplates(root: ParentNode): void {
  for (const template of Array.from(root.querySelectorAll("template"))) {
    for (const el of Array.from(template.content.querySelectorAll("*"))) {
      const projected = el.getAttributeNames().filter((name) => name.startsWith("data-bind-"));
      if (el.hasAttribute("data-text") || projected.length > 0) {
        const unbindable = bindableElement(el.tagName);
        if (unbindable !== undefined) throw new Error(unbindable);
      }
      for (const name of projected) {
        const target = classifyAttribute(name.slice("data-bind-".length));
        if (target.kind === "Forbidden") throw new Error(`${name}: ${target.reason}`);
      }
    }
    auditTemplates(template.content);
  }
}

function coerceScalar(raw: ViewValue | undefined, key: string): string {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return String(raw);
  throw new Error(`View value for "${key}" is missing or not scalar`);
}

// Returns a refusal to report, or undefined when the value was applied. What
// may be bound where is src/kernel/binding-policy.ts; a Forbidden target never
// reaches here, because #bindElement refuses it when the page is bound.
function applyBoundAttribute(bound: AttrBinding, raw: ViewValue | undefined): string | undefined {
  const { element: el, attr, target } = bound;
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    throw new Error(`Attribute binding "${attr}" requires a scalar view value`);
  }
  switch (target.kind) {
    // IDL properties are reflected through Reflect rather than a type
    // assertion: the element's static type does not declare every boolean
    // property (e.g. `open` on <details>), and asserting it away would hide
    // exactly the kind of mistake the restricted TypeScript subset exists to stop.
    case "BooleanProperty":
      Reflect.set(el, attr, Boolean(raw));
      return undefined;
    case "ValueProperty": {
      if (!("value" in el)) throw new Error(`Element bound to "value" has no value property`);
      const next = String(raw);
      if (Reflect.get(el, "value") !== next) Reflect.set(el, "value", next);
      return undefined;
    }
    // The value is often user data, so it is checked on every projection. An
    // unsafe URL is not written — the attribute is removed, so a stale safe
    // URL cannot linger either — and the refusal names the scheme, never the
    // value, which may carry a token.
    case "Url": {
      const verdict = checkUrl(String(raw), el.ownerDocument.baseURI);
      if (verdict.kind === "Safe") {
        el.setAttribute(attr, String(raw));
        return undefined;
      }
      el.removeAttribute(attr);
      return `refused a ${verdict.scheme} URL for <${el.tagName.toLowerCase()} ${attr}>; only http, https, mailto, tel and relative URLs are projected`;
    }
    case "Attribute":
      el.setAttribute(attr, String(raw));
      return undefined;
    case "Forbidden":
      throw new Error(`data-bind-${attr}: ${target.reason}`);
  }
}

function makeEvent(name: string, key: string | undefined, value: string | undefined): SemanticEvent {
  return { kind: "Event", name, ...(key !== undefined ? { key } : {}), ...(value !== undefined ? { value } : {}) };
}

export class BrowserKernel {
  readonly #controllers = new Map<CorrelationId, AbortController>();
  // Every effect from request until its result is handed back. A second
  // request under an id that is still in flight would make the two answers
  // indistinguishable to the engine — and would overwrite the first one's
  // abort controller — so it is refused, never executed.
  readonly #inFlight = new Set<CorrelationId>();
  // The element is kept alongside its callback so an unmounted binding (a
  // data-if that closed, a data-each row removed) can be pruned at flush time.
  readonly #flushable = new Map<HTMLFormElement, Array<{ readonly element: HTMLElement; readonly fire: () => Promise<void> }>>();
  readonly #root: Scope = emptyScope();
  readonly #diagnostics: DiagnosticsSink;
  readonly #providers: ReadonlyMap<CapabilityId, CapabilityProvider>;
  readonly #requireHandshake: boolean;
  #phase: Phase = { kind: "Unstarted" };
  readonly transport: EngineTransport;
  readonly document: Document;

  constructor(transport: EngineTransport, document: Document, diagnostics: DiagnosticsSink = noopDiagnostics, options: KernelOptions = {}) {
    this.transport = transport;
    this.document = document;
    this.#diagnostics = diagnostics;
    const providers = options.capabilities ?? [];
    const duplicate = providers.find((provider, index) => providers.findIndex((other) => other.descriptor.id === provider.descriptor.id) !== index);
    if (duplicate !== undefined) throw new Error(`Capability ${duplicate.descriptor.id} is registered more than once`);
    this.#providers = new Map(providers.map((provider) => [provider.descriptor.id, provider] as const));
    this.#requireHandshake = options.requireHandshake ?? false;
  }

  async start(): Promise<void> {
    if (this.#phase.kind !== "Unstarted") {
      this.#diagnostics.report({ kind: "BridgeError", phase: "protocol", detail: "start() called more than once" });
      return;
    }
    this.#phase = { kind: "Starting" };
    try {
      await this.transport.start();
    } catch (error) {
      this.#phase = { kind: "Faulted" };
      this.#diagnostics.report({ kind: "BridgeError", phase: "dispatch", detail: String(error) });
      return;
    }
    try {
      auditTemplates(this.document.body);
      this.#bindElement(this.document.body, this.#root, undefined);
    } catch (error) {
      // A malformed binding is a bridge integration failure, not a domain
      // outcome — the same rule #send applies. Reporting rather than throwing
      // keeps start()'s "never rejects" contract true and routes the failure
      // through the one channel consumers already watch.
      this.#phase = { kind: "Faulted" };
      this.#diagnostics.report({ kind: "BridgeError", phase: "binding", detail: String(error) });
      return;
    }
    // Browser-originated navigation — Back, Forward, or a gesture that does
    // the same thing. It is not correlated with any effect the engine
    // requested, so it arrives as its own message rather than an
    // EffectResult. An engine that does not route simply never reacts to it.
    window.addEventListener("popstate", () => {
      void this.#send({ kind: "LocationChanged", location: readLocation() });
    });
    await this.#initialize();
  }

  get #offer(): HostHandshake {
    return {
      protocol: { major: PROTOCOL_VERSION, minor: PROTOCOL_MINOR },
      contract: { unit: CORE_CONTRACT_IDENTITY.unit, version: CORE_CONTRACT_IDENTITY.version, fingerprint: CORE_CONTRACT_IDENTITY.fingerprint },
      capabilities: Array.from(this.#providers.values(), (provider) => provider.descriptor),
    };
  }

  // Initialize is the one round trip that happens before normal traffic. Its
  // response is applied only after the engine's handshake has been verified:
  // an incompatible engine's view and effects never reach the page.
  async #initialize(): Promise<void> {
    const offer = this.#offer;
    let response: EngineToBrowserMessage;
    try {
      response = await this.transport.dispatch({ kind: "Initialize", protocolVersion: PROTOCOL_VERSION, capabilities: CAPABILITIES, location: readLocation(), handshake: offer });
    } catch (error) {
      this.#phase = { kind: "Faulted" };
      this.#diagnostics.report({ kind: "BridgeError", phase: "dispatch", detail: String(error) });
      return;
    }
    const verdict = verifyHandshake(offer, response.handshake, this.#requireHandshake);
    this.#diagnostics.report({ kind: "Handshake", verdict });
    if (verdict.kind === "Incompatible") {
      this.#phase = { kind: "Incompatible", reason: verdict.reason };
      return;
    }
    this.#phase = { kind: "Running", negotiation: verdict.negotiation };
    this.#activateNegotiated(verdict.negotiation);
    await this.#apply(response);
  }

  #activateNegotiated(negotiation: Negotiation): void {
    if (negotiation.kind === "Legacy") return;
    for (const selected of negotiation.capabilities) {
      const provider = this.#providers.get(selected.id);
      provider?.activate({
        document: this.document,
        emitFact: (fact) => { void this.#send({ kind: "CapabilityFact", capability: selected.id, version: selected.version, fact }); },
      });
    }
  }

  // Binds only root's descendants, not root itself — the recursive step
  // #bindElement uses once it has already processed an element's own
  // bindings. To bind a newly instantiated template's root element (which
  // may itself carry data-text/data-event/etc.), call #bindElement on it
  // directly instead of this.
  #bind(root: Element | DocumentFragment, scope: Scope, itemKey: string | undefined): void {
    for (const child of Array.from(root.children)) this.#bindElement(child as HTMLElement, scope, itemKey);
  }

  #bindElement(el: HTMLElement, scope: Scope, itemKey: string | undefined): void {
    if (el instanceof HTMLTemplateElement && el.hasAttribute("data-if")) {
      const key = el.getAttribute("data-if")!;
      const anchor = this.document.createComment(`if:${key}`);
      el.replaceWith(anchor);
      scope.ifs.push({ anchor, template: el, key, itemKey, mounted: null });
      return;
    }
    if (el instanceof HTMLTemplateElement && el.hasAttribute("data-each")) {
      const listKey = el.getAttribute("data-each")!;
      const field = el.getAttribute("data-key");
      if (!field) throw new Error(`data-each="${listKey}" requires data-key`);
      const anchor = this.document.createComment(`each:${listKey}`);
      el.replaceWith(anchor);
      scope.eachs.push({ anchor, template: el, listKey, itemKey: field, instances: new Map() });
      return;
    }
    // data-if/data-each mount and unmount a <template>'s *content*, so they are
    // meaningless anywhere else. Written on an ordinary element they used to be
    // ignored in silence — invisible until someone loaded the page and noticed
    // the content never appeared. That happened in a real consumer project; see
    // docs/19-evidence.md. Fail loudly instead.
    for (const misplaced of ["data-if", "data-each"]) {
      if (el.hasAttribute(misplaced)) {
        throw new Error(`${misplaced}="${el.getAttribute(misplaced)}" is only supported on a <template> element, but was found on <${el.tagName.toLowerCase()}>`);
      }
    }
    if (el.hasAttribute("data-event")) this.#bindEvent(el, itemKey);
    const projected = Array.from(el.attributes).filter((attr) => attr.name.startsWith("data-bind-"));
    if (el.hasAttribute("data-text") || projected.length > 0) {
      const unbindable = bindableElement(el.tagName);
      if (unbindable !== undefined) throw new Error(unbindable);
    }
    if (el.hasAttribute("data-text")) scope.texts.push({ element: el, key: el.getAttribute("data-text")! });
    for (const attr of projected) {
      const name = attr.name.slice("data-bind-".length);
      const target = classifyAttribute(name);
      if (target.kind === "Forbidden") throw new Error(`${attr.name}: ${target.reason}`);
      scope.attrs.push({ element: el, attr: name, key: attr.value, target });
    }
    this.#bind(el, scope, itemKey);
  }

  #bindEvent(el: HTMLElement, itemKey: string | undefined): void {
    const name = el.getAttribute("data-event")!;
    const trigger = el.getAttribute("data-on") ?? TRIGGER_BY_TAG[el.tagName] ?? "click";
    const fire = (): Promise<void> => this.#fire(el, name, itemKey, null);
    el.addEventListener(trigger, (domEvent) => {
      if (trigger === "submit") domEvent.preventDefault();
      // An input event during IME composition carries text the user has not
      // committed; reporting it would hand the engine half a character. The
      // committed value is reported once, at compositionend, below.
      if ("isComposing" in domEvent && domEvent.isComposing === true) return;
      const submitter = "submitter" in domEvent && domEvent.submitter instanceof HTMLElement ? domEvent.submitter : null;
      void this.#fire(el, name, itemKey, submitter);
    });
    if (trigger === "input") el.addEventListener("compositionend", () => { void this.#fire(el, name, itemKey, null); });
    const form = "form" in el ? (el as HTMLInputElement).form : null;
    if (trigger !== "submit" && form !== null) {
      const pending = this.#flushable.get(form) ?? [];
      pending.push({ element: el, fire });
      this.#flushable.set(form, pending);
    }
  }

  async #fire(el: HTMLElement, name: string, itemKey: string | undefined, submitter: HTMLElement | null): Promise<void> {
    if (el instanceof HTMLFormElement) {
      if (!el.reportValidity()) return;
      // Prune bindings whose element has since been unmounted. Without this,
      // repeatedly toggling a conditional section accumulates stale callbacks
      // and dispatches events for elements no longer on the page.
      const pending = this.#flushable.get(el) ?? [];
      const live = pending.filter((entry) => entry.element.isConnected);
      if (live.length !== pending.length) this.#flushable.set(el, live);
      for (const entry of live) await entry.fire();
    }
    const value = readValue(el);
    // A 1.1 engine's strict decoder would refuse fields it has never heard of,
    // so control state is sent only to an engine that negotiated 1.2.
    const state = this.#speaks(2) ? readControlState(el, submitter) : {};
    const event: SemanticEvent = { ...makeEvent(name, itemKey, value), ...state, ...(state.values !== undefined ? { values: [...state.values] } : {}) };
    await this.#send({ kind: "Event", event });
  }

  #speaks(minor: number): boolean {
    return this.#phase.kind === "Running" && this.#phase.negotiation.kind === "Negotiated" && this.#phase.negotiation.protocol.minor >= minor;
  }

  // The single chokepoint every engine round-trip passes through. A failure
  // here is a bridge/transport/DOM integration failure, not a domain
  // outcome — it is reported to diagnostics and does not propagate, so one
  // bad projection or a dead transport cannot crash the page or silently
  // corrupt already-applied view state.
  async #send(message: BrowserToEngineMessage): Promise<void> {
    // Nothing flows before the handshake is verified, or ever after it failed.
    if (this.#phase.kind !== "Running") {
      this.#diagnostics.report({ kind: "BridgeError", phase: "protocol", detail: `${message.kind} not dispatched: kernel is ${this.#phase.kind}` });
      return;
    }
    let response: EngineToBrowserMessage;
    try {
      response = await this.transport.dispatch(message);
    } catch (error) {
      this.#diagnostics.report({ kind: "BridgeError", phase: "dispatch", detail: String(error) });
      return;
    }
    // A handshake is an answer to Initialize only. Anywhere else it is a
    // protocol violation, and the response carrying it is not applied.
    if (response.handshake !== undefined) {
      this.#diagnostics.report({ kind: "BridgeError", phase: "protocol", detail: `handshake in response to ${message.kind}` });
      return;
    }
    await this.#apply(response);
  }

  async #apply(response: EngineToBrowserMessage): Promise<void> {
    try {
      for (const refusal of this.#applyScope(this.#root, response.view)) this.#diagnostics.report({ kind: "BridgeError", phase: "projection", detail: refusal });
    } catch (error) {
      this.#diagnostics.report({ kind: "BridgeError", phase: "projection", detail: String(error) });
      return;
    }
    for (const correlationId of response.cancellations) this.#controllers.get(correlationId)?.abort("cancelled");
    await Promise.all(response.effects.map((effect) => this.#executeEffect(effect)));
  }

  // Returns the refusals the projection produced (an unsafe URL not written);
  // a malformed projection still throws.
  #applyScope(scope: Scope, view: ViewState): readonly string[] {
    for (const text of scope.texts) text.element.textContent = coerceScalar(view[text.key], text.key);
    return [
      ...scope.attrs.flatMap((bound) => applyBoundAttribute(bound, view[bound.key]) ?? []),
      ...scope.ifs.flatMap((ifBinding) => this.#applyIf(ifBinding, view)),
      ...scope.eachs.flatMap((eachBinding) => this.#applyEach(eachBinding, view)),
    ];
  }

  #applyIf(binding: IfBinding, view: ViewState): readonly string[] {
    const present = Boolean(view[binding.key]);
    if (binding.mounted) {
      if (!present) { binding.mounted.root.remove(); binding.mounted = null; return []; }
      return this.#applyScope(binding.mounted.scope, view);
    }
    if (!present) return [];
    const fragment = binding.template.content.cloneNode(true) as DocumentFragment;
    const root = fragment.firstElementChild;
    if (!(root instanceof HTMLElement)) throw new Error(`data-if="${binding.key}" template must contain exactly one root element`);
    // Insert BEFORE binding. An element only has a `.form` owner once it is in
    // the document, and #bindEvent reads that to register the pending-field
    // flush — binding a detached clone skipped the registration silently, so a
    // conditionally-shown field edited without blurring never reached the
    // engine on submit.
    binding.anchor.after(root);
    const scope = emptyScope();
    this.#bindElement(root, scope, binding.itemKey);
    binding.mounted = { root, scope };
    return this.#applyScope(scope, view);
  }

  #applyEach(binding: EachBinding, view: ViewState): readonly string[] {
    const raw = view[binding.listKey];
    if (!Array.isArray(raw)) throw new Error(`data-each="${binding.listKey}" requires an array view value`);
    const items = raw as readonly ViewItem[];
    const parent = binding.anchor.parentNode;
    if (!parent) throw new Error(`data-each anchor for "${binding.listKey}" is detached`);
    const seen = new Set<string>();
    const refusals: string[] = [];
    let cursor: ChildNode = binding.anchor;
    for (const item of items) {
      const rawKey = item[binding.itemKey];
      if (rawKey === undefined) throw new Error(`data-each item missing key field "${binding.itemKey}"`);
      const key = String(rawKey);
      seen.add(key);
      let instance = binding.instances.get(key);
      if (!instance) {
        const fragment = binding.template.content.cloneNode(true) as DocumentFragment;
        const root = fragment.firstElementChild;
        if (!(root instanceof HTMLElement)) throw new Error(`data-each="${binding.listKey}" template must contain exactly one root element`);
        // Insert before binding, for the reason given in #applyIf. The reorder
        // below is then a no-op for this freshly placed item.
        parent.insertBefore(root, cursor.nextSibling);
        const scope = emptyScope();
        this.#bindElement(root, scope, key);
        instance = { root, scope };
        binding.instances.set(key, instance);
      }
      refusals.push(...this.#applyScope(instance.scope, item));
      if (cursor.nextSibling !== instance.root) parent.insertBefore(instance.root, cursor.nextSibling);
      cursor = instance.root;
    }
    for (const [key, instance] of binding.instances) {
      if (!seen.has(key)) { instance.root.remove(); binding.instances.delete(key); }
    }
    return refusals;
  }

  async #executeEffect(effect: EffectRequest): Promise<void> {
    if (this.#inFlight.has(effect.correlationId)) {
      this.#diagnostics.report({ kind: "BridgeError", phase: "protocol", detail: `${effect.kind} not executed: correlation id ${effect.correlationId} is already in flight` });
      return;
    }
    this.#inFlight.add(effect.correlationId);
    const started = performance.now();
    let result: EffectResult;
    try {
      result = await this.#runEffect(effect);
    } catch (error) {
      this.#inFlight.delete(effect.correlationId);
      // The kernel could not run the effect at all: an effect kind it does not
      // implement, or a browser API that threw where its own contract says it
      // cannot. There is no outcome it could report honestly, so it reports
      // nothing to the engine and everything to diagnostics. An engine waiting
      // on this correlation id now waits forever — which is exactly why this
      // is the loudest thing the bridge can say, rather than a silent drop.
      this.#diagnostics.report({ kind: "BridgeError", phase: "effect", detail: String(error) });
      return;
    }
    this.#inFlight.delete(effect.correlationId);
    this.#diagnostics.report({ kind: "EffectTiming", correlationId: effect.correlationId, durationMs: performance.now() - started });
    await this.#send({ kind: "EffectResult", result });
  }

  // Exhaustive by construction: adding a variant to EffectRequest without a
  // branch here is a compile error, not a silently dropped effect. An effect
  // that vanished used to be the single hardest Limen failure to diagnose —
  // the engine waits forever for a result that is never coming.
  async #runEffect(effect: EffectRequest): Promise<EffectResult> {
    switch (effect.kind) {
      case "Http": return await this.#executeHttp(effect);
      case "Storage": return this.#executeStorage(effect);
      case "Clipboard": return await this.#executeClipboard(effect);
      case "Navigation": return this.#executeNavigation(effect);
      case "Capability": return await this.#executeCapability(effect);
      default: return assertNeverEffect(effect);
    }
  }

  // Core routes by negotiated identity and never looks inside the request. A
  // capability the engine did not negotiate — or a legacy engine asking for
  // any — gets a typed Unsupported answer, never a silent drop.
  async #executeCapability(effect: CapabilityEffectRequest): Promise<EffectResult> {
    const answer = (outcome: CapabilityOutcome): EffectResult =>
      ({ kind: "CapabilityResult", correlationId: effect.correlationId, capability: effect.capability, version: effect.version, outcome });
    const negotiated = this.#phase.kind === "Running" && this.#phase.negotiation.kind === "Negotiated"
      ? this.#phase.negotiation.capabilities.find((capability) => capability.id === effect.capability)
      : undefined;
    const provider = this.#providers.get(effect.capability);
    if (negotiated === undefined || provider === undefined) return answer({ kind: "Unsupported", reason: "not-negotiated" });
    if (negotiated.version !== effect.version) return answer({ kind: "Unsupported", reason: "version-unsupported" });
    const controller = new AbortController();
    this.#controllers.set(effect.correlationId, controller);
    try {
      const result = await provider.execute(effect.request, { correlationId: effect.correlationId, signal: controller.signal, document: this.document });
      if (result.kind === "Rejected") this.#diagnostics.report({ kind: "BridgeError", phase: "effect", detail: `${effect.capability} rejected request ${effect.correlationId}: ${result.reason}` });
      return answer(result);
    } finally {
      this.#controllers.delete(effect.correlationId);
    }
  }

  async #executeHttp(effect: HttpEffectRequest): Promise<EffectResult> {
    const controller = new AbortController();
    this.#controllers.set(effect.correlationId, controller);
    const timer = window.setTimeout(() => controller.abort("timeout"), effect.timeoutMs);
    const outcome = await this.#runHttp(effect, controller);
    window.clearTimeout(timer);
    this.#controllers.delete(effect.correlationId);
    return { kind: "HttpResult", correlationId: effect.correlationId, outcome };
  }

  // The kernel classifies transport-level outcomes only — it never decides
  // what a status code or a decoded body means; that is the engine's job.
  // A timeout is always reported as OutcomeUnknown, never a confident
  // Failure: fetch() may already have sent the request before the abort
  // fires, so the kernel cannot claim the effect did not occur.
  async #runHttp(effect: HttpEffectRequest, controller: AbortController): Promise<EffectOutcome> {
    try {
      const response = await fetch(effect.url, {
        method: effect.method,
        signal: controller.signal,
        headers: { accept: "application/json", ...effect.headers },
        ...(effect.body !== undefined ? { body: effect.body } : {}),
      });
      try {
        return { kind: "Success", status: response.status, body: await response.json() as unknown };
      } catch {
        // A response did arrive — it simply would not decode. Carry the status
        // so the engine can tell a 500 error page apart from a malformed 200.
        return controller.signal.aborted
          ? this.#classifyAbort(controller)
          : { kind: "Failure", reason: "invalid-response", status: response.status };
      }
    } catch {
      return this.#classifyAbort(controller);
    }
  }

  #classifyAbort(controller: AbortController): EffectOutcome {
    if (controller.signal.reason === "cancelled") return { kind: "Cancelled" };
    if (controller.signal.reason === "timeout") return { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" };
    return { kind: "Failure", reason: controller.signal.aborted ? "aborted" : "network" };
  }

  // Synchronous by nature (localStorage has no async API), so unlike Http
  // there is no AbortController to register, no timeout, and cancelling a
  // Storage effect is a structural no-op — by the time a later response
  // could name its correlationId, the operation has already completed and
  // its result already sent.
  #executeStorage(effect: StorageEffectRequest): EffectResult {
    return { kind: "StorageResult", correlationId: effect.correlationId, outcome: runStorage(effect) };
  }

  // `effect.text` is never reported to diagnostics, for the same reason an
  // Http header is not: whatever an application copies for its user is the
  // user's, and a bridge that logged it would make every consumer's log a
  // place secrets accumulate.
  async #executeClipboard(effect: ClipboardEffectRequest): Promise<EffectResult> {
    return { kind: "ClipboardResult", correlationId: effect.correlationId, outcome: await writeClipboardText(effect.text) };
  }

  // Synchronous, like Storage: history.pushState either applies or throws,
  // and back()/forward() return immediately having only *asked*. There is
  // therefore nothing to cancel, and no correlation controller to register.
  #executeNavigation(effect: NavigationEffectRequest): EffectResult {
    return { kind: "NavigationResult", correlationId: effect.correlationId, outcome: runNavigation(effect) };
  }
}

const assertNeverEffect = (effect: never): never => {
  throw new Error(`Unsupported effect kind: ${JSON.stringify(effect)}`);
};

function runStorage(effect: StorageEffectRequest): StorageOutcome {
  try {
    switch (effect.operation) {
      case "get": return { kind: "Success", value: window.localStorage.getItem(effect.key) };
      case "set": window.localStorage.setItem(effect.key, effect.value); return { kind: "Success", value: null };
      case "remove": window.localStorage.removeItem(effect.key); return { kind: "Success", value: null };
    }
  } catch (error) {
    return { kind: "Failure", reason: isQuotaExceeded(error) ? "quota-exceeded" : "unavailable" };
  }
}

function isQuotaExceeded(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "QuotaExceededError" || error.code === 22 || error.code === 1014);
}

// --- Clipboard -------------------------------------------------------------

// The Clipboard API is asynchronous, permission-gated, and in most browsers
// only granted while a user gesture is still being handled. The kernel does
// not try to smooth any of that over: it performs the write and classifies
// what came back, so the engine can decide whether "try again" is honest
// advice or not.
async function writeClipboardText(text: string): Promise<ClipboardOutcome> {
  const clipboard: Clipboard | undefined = window.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") return { kind: "Failure", reason: "unavailable" };
  try {
    await clipboard.writeText(text);
    return { kind: "Success" };
  } catch (error) {
    return { kind: "Failure", reason: classifyClipboardError(error) };
  }
}

// "denied" is the recoverable one — the user can click again, and a browser
// that refused because the gesture had expired will usually allow the next
// attempt. Collapsing it into "unknown" would cost the engine the only piece
// of advice it can honestly give.
function classifyClipboardError(error: unknown): "denied" | "unavailable" | "unknown" {
  if (!(error instanceof DOMException)) return "unknown";
  if (error.name === "NotAllowedError" || error.name === "SecurityError") return "denied";
  if (error.name === "NotSupportedError") return "unavailable";
  return "unknown";
}

// --- Navigation ------------------------------------------------------------

function readLocation(): BrowserLocation {
  const { origin, pathname, search, hash } = window.location;
  return { origin, path: pathname, query: search, hash };
}

// No history state is written. The engine already holds the state this URL
// stands for, and a copy stored in the history entry is a second source of
// truth that can disagree with it after a reload or a deploy. On the way back,
// the engine re-derives its state from the URL — which is the only thing the
// browser can be trusted to have preserved.
function runNavigation(effect: NavigationEffectRequest): NavigationOutcome {
  const history = window.history;
  if (typeof history?.pushState !== "function") return { kind: "Failure", reason: "unavailable" };
  switch (effect.operation) {
    // Only *asks*. Whether the browser actually moves — and where to — arrives
    // later as a LocationChanged message, or never, if there was no entry to
    // move to. See NavigationOutcome in ../protocol.ts.
    case "back": history.back(); return { kind: "Dispatched" };
    case "forward": history.forward(); return { kind: "Dispatched" };
    case "push":
    case "replace": {
      const target = resolveSameOrigin(effect.url);
      if (target === null) return { kind: "Failure", reason: "not-same-origin" };
      if (effect.operation === "push") history.pushState(null, "", target.href);
      else history.replaceState(null, "", target.href);
      return { kind: "Success", location: readLocation() };
    }
  }
}

// Leaving the origin is not navigation the engine gets to perform: it ends the
// application, discards every piece of state the engine owns, and cannot be
// undone by a later transition. An ordinary <a href> is the right tool, and it
// needs no capability at all.
function resolveSameOrigin(url: string): URL | null {
  try {
    const resolved = new URL(url, window.location.href);
    return resolved.origin === window.location.origin ? resolved : null;
  } catch {
    return null;
  }
}
