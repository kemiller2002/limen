import { PROTOCOL_VERSION, type BrowserToEngineMessage, type CorrelationId, type EffectOutcome, type EffectRequest, type EffectResult, type EngineToBrowserMessage, type EngineTransport, type HttpEffectRequest, type SemanticEvent, type StorageEffectRequest, type StorageOutcome, type ViewItem, type ViewState, type ViewValue } from "../protocol.js";
import { noopDiagnostics, type DiagnosticsSink } from "./diagnostics.js";

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

// The only attributes the bridge reflects as DOM/IDL boolean properties
// rather than string attributes, per section 11.3 of the spec.
const BOOLEAN_PROPS = new Set(["disabled", "checked", "selected", "hidden", "open"]);

type TextBinding = { readonly element: HTMLElement; readonly key: string };
type AttrBinding = { readonly element: HTMLElement; readonly attr: string; readonly key: string };
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

function coerceScalar(raw: ViewValue | undefined, key: string): string {
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return String(raw);
  throw new Error(`View value for "${key}" is missing or not scalar`);
}

function applyBoundAttribute(el: HTMLElement, attr: string, raw: ViewValue | undefined): void {
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    throw new Error(`Attribute binding "${attr}" requires a scalar view value`);
  }
  if (BOOLEAN_PROPS.has(attr)) {
    (el as unknown as Record<string, boolean>)[attr] = Boolean(raw);
    return;
  }
  if (attr === "value") {
    if (!("value" in el)) throw new Error(`Element bound to "value" has no value property`);
    const next = String(raw);
    const valueEl = el as unknown as { value: string };
    if (valueEl.value !== next) valueEl.value = next;
    return;
  }
  el.setAttribute(attr, String(raw));
}

function makeEvent(name: string, key: string | undefined, value: string | undefined): SemanticEvent {
  return { kind: "Event", name, ...(key !== undefined ? { key } : {}), ...(value !== undefined ? { value } : {}) };
}

export class BrowserKernel {
  readonly #controllers = new Map<CorrelationId, AbortController>();
  // The element is kept alongside its callback so an unmounted binding (a
  // data-if that closed, a data-each row removed) can be pruned at flush time.
  readonly #flushable = new Map<HTMLFormElement, Array<{ readonly element: HTMLElement; readonly fire: () => Promise<void> }>>();
  readonly #root: Scope = emptyScope();
  readonly #diagnostics: DiagnosticsSink;
  readonly transport: EngineTransport;
  readonly document: Document;

  constructor(transport: EngineTransport, document: Document, diagnostics: DiagnosticsSink = noopDiagnostics) {
    this.transport = transport;
    this.document = document;
    this.#diagnostics = diagnostics;
  }

  async start(): Promise<void> {
    try {
      await this.transport.start();
    } catch (error) {
      this.#diagnostics.report({ kind: "BridgeError", phase: "dispatch", detail: String(error) });
      return;
    }
    try {
      this.#bindElement(this.document.body, this.#root, undefined);
    } catch (error) {
      // A malformed binding is a bridge integration failure, not a domain
      // outcome — the same rule #send applies. Reporting rather than throwing
      // keeps start()'s "never rejects" contract true and routes the failure
      // through the one channel consumers already watch.
      this.#diagnostics.report({ kind: "BridgeError", phase: "binding", detail: String(error) });
      return;
    }
    await this.#send({ kind: "Initialize", protocolVersion: PROTOCOL_VERSION, capabilities: ["Http", "Storage"] });
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
    if (el.hasAttribute("data-text")) scope.texts.push({ element: el, key: el.getAttribute("data-text")! });
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-bind-")) scope.attrs.push({ element: el, attr: attr.name.slice("data-bind-".length), key: attr.value });
    }
    this.#bind(el, scope, itemKey);
  }

  #bindEvent(el: HTMLElement, itemKey: string | undefined): void {
    const name = el.getAttribute("data-event")!;
    const trigger = el.getAttribute("data-on") ?? TRIGGER_BY_TAG[el.tagName] ?? "click";
    const fire = (): Promise<void> => this.#fire(el, name, itemKey);
    el.addEventListener(trigger, (domEvent) => {
      if (trigger === "submit") domEvent.preventDefault();
      void fire();
    });
    const form = "form" in el ? (el as HTMLInputElement).form : null;
    if (trigger !== "submit" && form !== null) {
      const pending = this.#flushable.get(form) ?? [];
      pending.push({ element: el, fire });
      this.#flushable.set(form, pending);
    }
  }

  async #fire(el: HTMLElement, name: string, itemKey: string | undefined): Promise<void> {
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
    await this.#send({ kind: "Event", event: makeEvent(name, itemKey, value) });
  }

  // The single chokepoint every engine round-trip passes through. A failure
  // here is a bridge/transport/DOM integration failure, not a domain
  // outcome — it is reported to diagnostics and does not propagate, so one
  // bad projection or a dead transport cannot crash the page or silently
  // corrupt already-applied view state.
  async #send(message: BrowserToEngineMessage): Promise<void> {
    let response: EngineToBrowserMessage;
    try {
      response = await this.transport.dispatch(message);
    } catch (error) {
      this.#diagnostics.report({ kind: "BridgeError", phase: "dispatch", detail: String(error) });
      return;
    }
    try {
      this.#applyScope(this.#root, response.view);
    } catch (error) {
      this.#diagnostics.report({ kind: "BridgeError", phase: "projection", detail: String(error) });
      return;
    }
    for (const correlationId of response.cancellations) this.#controllers.get(correlationId)?.abort("cancelled");
    await Promise.all(response.effects.map((effect) => this.#executeEffect(effect)));
  }

  #applyScope(scope: Scope, view: ViewState): void {
    for (const text of scope.texts) text.element.textContent = coerceScalar(view[text.key], text.key);
    for (const bound of scope.attrs) applyBoundAttribute(bound.element, bound.attr, view[bound.key]);
    for (const ifBinding of scope.ifs) this.#applyIf(ifBinding, view);
    for (const eachBinding of scope.eachs) this.#applyEach(eachBinding, view);
  }

  #applyIf(binding: IfBinding, view: ViewState): void {
    const present = Boolean(view[binding.key]);
    if (binding.mounted) {
      if (!present) { binding.mounted.root.remove(); binding.mounted = null; return; }
      this.#applyScope(binding.mounted.scope, view);
      return;
    }
    if (!present) return;
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
    this.#applyScope(scope, view);
    binding.mounted = { root, scope };
  }

  #applyEach(binding: EachBinding, view: ViewState): void {
    const raw = view[binding.listKey];
    if (!Array.isArray(raw)) throw new Error(`data-each="${binding.listKey}" requires an array view value`);
    const items = raw as readonly ViewItem[];
    const parent = binding.anchor.parentNode;
    if (!parent) throw new Error(`data-each anchor for "${binding.listKey}" is detached`);
    const seen = new Set<string>();
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
      this.#applyScope(instance.scope, item);
      if (cursor.nextSibling !== instance.root) parent.insertBefore(instance.root, cursor.nextSibling);
      cursor = instance.root;
    }
    for (const [key, instance] of binding.instances) {
      if (!seen.has(key)) { instance.root.remove(); binding.instances.delete(key); }
    }
  }

  async #executeEffect(effect: EffectRequest): Promise<void> {
    const started = performance.now();
    const result = effect.kind === "Http" ? await this.#executeHttp(effect) : this.#executeStorage(effect);
    this.#diagnostics.report({ kind: "EffectTiming", correlationId: effect.correlationId, durationMs: performance.now() - started });
    await this.#send({ kind: "EffectResult", result });
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
}

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
