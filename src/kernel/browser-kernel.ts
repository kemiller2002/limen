import { PROTOCOL_VERSION, type BrowserToEngineMessage, type Capability, type ClipboardEffectRequest, type ClipboardOutcome, type CorrelationId, type EffectOutcome, type EffectRequest, type EffectResult, type EngineToBrowserMessage, type EngineTransport, type HttpEffectRequest, type NavigationEffectRequest, type NavigationOutcome, type SemanticEvent, type StorageEffectRequest, type StorageOutcome, type ViewItem, type ViewState, type ViewValue } from "../protocol.js";
import { noopDiagnostics, type DiagnosticsSink } from "./diagnostics.js";

/**
 * Opts this kernel into browser navigation. Omit it and the kernel touches
 * neither the URL nor history, does not announce the Navigation capability,
 * and behaves exactly as it did before navigation existed.
 */
export type NavigationBinding = {
  /**
   * The `SemanticEvent` name to dispatch when the browser moves the user
   * within session history — back, forward, or a hash edited in the address
   * bar. The kernel does not invent this name: it is the application's own
   * vocabulary, supplied here the same way `data-event` supplies one from
   * markup. The event carries the new location in `value`.
   *
   * The kernel's own pushes and replaces do not fire it. `pushState` and
   * `replaceState` never emit `popstate`, and the engine asked for those
   * moves, so telling it about them would only invite a loop.
   */
  readonly historyEvent: string;

  /**
   * Optional. The `SemanticEvent` name to dispatch when the user activates an
   * *eligible* in-application link, instead of letting the browser perform a
   * full page load. The event carries the link's href in `value`.
   *
   * The kernel does not navigate here and does not decide what the href means.
   * It reports an intent; the engine decides whether that destination is legal
   * and, if so, asks for a `Navigate` effect. A link the engine ignores simply
   * does nothing, which is the correct outcome for a route that does not exist.
   *
   * Eligibility is deliberately narrow — see `isEnhanceableLink`. Anything the
   * browser would do better is left to the browser: other origins, downloads,
   * `target`, and every modifier-click that means "open this somewhere else".
   * Omit this and no link is ever intercepted.
   */
  readonly linkEvent?: string;
};

/**
 * Opts this kernel into clipboard access. Omit it and the kernel never touches
 * the clipboard and does not announce the Clipboard capability.
 *
 * There is nothing to configure: unlike navigation, the clipboard has no
 * inbound direction and so needs no application-supplied event name. The
 * object exists so that enabling the capability is an explicit act.
 */
export type ClipboardBinding = {
  /** Reserved so the shape can gain options without a breaking change. */
  readonly enabled: true;
};

/**
 * Everything optional about a kernel, in one place.
 *
 * This is the third constructor argument. A `DiagnosticsSink` is also still
 * accepted there, exactly as before, so every existing call site keeps
 * working unchanged — see the constructor.
 */
export type BrowserKernelOptions = {
  readonly diagnostics?: DiagnosticsSink;
  readonly navigation?: NavigationBinding;
  readonly clipboard?: ClipboardBinding;
};

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
  readonly #navigation: NavigationBinding | null;
  readonly #clipboard: ClipboardBinding | null;
  readonly transport: EngineTransport;
  readonly document: Document;

  /**
   * The third argument is either a `DiagnosticsSink` — the original shape,
   * still accepted verbatim — or an options object carrying the sink and any
   * capabilities this kernel should have.
   *
   * Two optional capabilities would have meant a fourth and fifth positional
   * argument, and a sixth for the next one. The union keeps every released
   * call site (`(transport, document)` and `(transport, document, sink)`)
   * compiling and behaving identically, and gives capabilities somewhere to
   * live that is named rather than counted.
   */
  constructor(
    transport: EngineTransport,
    document: Document,
    options: DiagnosticsSink | BrowserKernelOptions = noopDiagnostics,
  ) {
    // A sink is identified by the method it must have; an options object never
    // has one. Nothing else can be confused for either.
    const settings: BrowserKernelOptions = "report" in options ? { diagnostics: options } : options;
    this.transport = transport;
    this.document = document;
    this.#diagnostics = settings.diagnostics ?? noopDiagnostics;
    this.#navigation = settings.navigation ?? null;
    this.#clipboard = settings.clipboard ?? null;
  }

  // The window that owns the injected document — not the ambient global, so
  // a kernel driven against one document never reads another's history.
  get #window(): Window | null {
    return this.document.defaultView;
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
    const view = this.#window;
    // Navigation needs a window: with no window there is no history to bind
    // to and no location to report, so the capability is not announced and
    // the engine is never told URLs are available when they are not.
    const navigation = view === null ? null : this.#navigation;
    if (view !== null && navigation !== null) this.#bindHistory(view, navigation);
    // Every capability is announced only if it is genuinely present, so an
    // engine can branch on `capabilities` instead of guessing.
    const capabilities: readonly Capability[] = [
      "Http",
      "Storage",
      ...(navigation !== null ? (["Navigation"] as const) : []),
      ...(this.#clipboard !== null ? (["Clipboard"] as const) : []),
    ];
    await this.#send({
      kind: "Initialize",
      protocolVersion: PROTOCOL_VERSION,
      capabilities,
      // The URL the page was opened at. Present exactly when the capability
      // is, so "no location field" and "no navigation" are the same fact.
      ...(view !== null && navigation !== null ? { location: currentLocation(view) } : {}),
    });
  }

  // Two listeners at most, for the two ways a location reaches the kernel
  // without the engine having asked: the browser moving through history, and
  // the user activating a link. Neither decides what a URL means.
  #bindHistory(view: Window, navigation: NavigationBinding): void {
    // The one thing the browser does entirely on its own. The resulting
    // location is handed over as evidence, exactly like a form field's value.
    view.addEventListener("popstate", () => {
      void this.#send({ kind: "Event", event: makeEvent(navigation.historyEvent, undefined, currentLocation(view)) });
    });

    const linkEvent = navigation.linkEvent;
    if (linkEvent === undefined) return;

    // Delegated from the document, so links inside a data-if or data-each that
    // mounted later are covered without rebinding anything.
    this.document.addEventListener("click", (domEvent) => {
      const anchor = enhanceableAnchor(domEvent, view);
      if (anchor === null) return;
      // Only now, having decided the browser has nothing better to do with
      // this click, does the kernel take it. The engine still decides whether
      // the destination is a real route; an href it does not recognise simply
      // produces no navigation, which is the right answer for a dead link.
      domEvent.preventDefault();
      void this.#send({ kind: "Event", event: makeEvent(linkEvent, undefined, relativize(anchor.href, view)) });
    });
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
    const result = await this.#runEffect(effect);
    this.#diagnostics.report({ kind: "EffectTiming", correlationId: effect.correlationId, durationMs: performance.now() - started });
    await this.#send({ kind: "EffectResult", result });
  }

  async #runEffect(effect: EffectRequest): Promise<EffectResult> {
    switch (effect.kind) {
      case "Http": return this.#executeHttp(effect);
      case "Storage": return this.#executeStorage(effect);
      case "Navigate": return this.#executeNavigation(effect);
      case "Clipboard": return this.#executeClipboard(effect);
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

  // Synchronous like Storage: a same-document history entry either exists
  // after the call or the call threw, and a traversal is either queued or it
  // is not. Nothing is dispatched to a remote party, so there is no in-flight
  // state to cancel and no "dispatched but uncertain" to report.
  #executeNavigation(effect: NavigationEffectRequest): EffectResult {
    const view = this.#window;
    const outcome: NavigationOutcome =
      this.#navigation === null || view === null
        ? { kind: "Failure", reason: "unavailable" }
        : runNavigation(view, effect);
    return { kind: "NavigationResult", correlationId: effect.correlationId, outcome };
  }

  // Asynchronous, unlike every other non-Http effect: the browser may prompt,
  // consult a permission, or refuse. It is still not cancellable — there is no
  // abort signal on the Clipboard API — and a refusal is an ordinary outcome
  // rather than an error.
  async #executeClipboard(effect: ClipboardEffectRequest): Promise<EffectResult> {
    const outcome: ClipboardOutcome =
      this.#clipboard === null
        ? { kind: "Failure", reason: "unsupported" }
        : await runClipboard(effect);
    return { kind: "ClipboardResult", correlationId: effect.correlationId, outcome };
  }
}

// Everything the boundary carries as a URL uses this one spelling, inbound
// and outbound alike, so an engine comparing "where am I" against "where did
// I ask to be" is comparing like with like. The origin is deliberately left
// off: it cannot vary within an application, and the engine has no business
// with it.
function currentLocation(view: Window): string {
  const { pathname, search, hash } = view.location;
  return `${pathname}${search}${hash}`;
}

/** The same normalized spelling the kernel reports inbound. */
function relativize(href: string, view: Window): string {
  const target = resolve(href, view.location.href);
  return target === null ? href : `${target.pathname}${target.search}${target.hash}`;
}

function runNavigation(view: Window, effect: NavigationEffectRequest): NavigationOutcome {
  // A traversal is a request to the browser, not an edit the kernel performs.
  // Where it lands — or whether it lands anywhere, at the end of the stack —
  // is not knowable here, so the outcome acknowledges and says no more. The
  // history event that follows is what actually tells the engine where it is.
  if (effect.operation === "back" || effect.operation === "forward") {
    try {
      if (effect.operation === "back") view.history.back();
      else view.history.forward();
      return { kind: "Accepted" };
    } catch {
      return { kind: "Failure", reason: "unavailable" };
    }
  }

  const target = resolve(effect.url, view.location.href);
  if (target === null) return { kind: "Failure", reason: "invalid-url" };
  // A same-document history entry is same-origin by definition, and the
  // engine must not be able to reach through this effect to move the page to
  // another site. Refusing here rather than letting pushState throw makes it
  // an explicit outcome the engine can handle instead of an opaque failure.
  if (target.origin !== view.location.origin) return { kind: "Failure", reason: "cross-origin" };
  try {
    const entry = `${target.pathname}${target.search}${target.hash}`;
    if (effect.operation === "push") view.history.pushState(null, "", entry);
    else view.history.replaceState(null, "", entry);
    return { kind: "Success", url: currentLocation(view) };
  } catch {
    // pushState is unavailable in a few real places — a sandboxed frame, an
    // opaque origin, a page opened from file:// in some browsers.
    return { kind: "Failure", reason: "unavailable" };
  }
}

function resolve(url: string, base: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/**
 * The anchor this click should be taken away from the browser for, or null.
 *
 * Every rule here exists to *not* break something the browser already does
 * well. A link the kernel takes must be an ordinary left-click, unmodified,
 * on a same-origin anchor that the author has not marked for other handling.
 * Anything else — a new tab, a download, a different origin, a framed target
 * — belongs to the browser, and silently swallowing it would be a regression
 * the user experiences as a broken page.
 */
function enhanceableAnchor(domEvent: Event, view: Window): HTMLAnchorElement | null {
  // Bare globals, as everywhere else in this file — see the note in
  // test/dom-helpers.ts about why they are installed for tests.
  if (!(domEvent instanceof MouseEvent)) return null;
  // Not a plain primary-button click: middle-click opens a tab, right-click
  // opens the context menu, and Ctrl/Cmd/Shift/Alt each mean "somewhere else".
  if (domEvent.button !== 0) return null;
  if (domEvent.ctrlKey || domEvent.metaKey || domEvent.shiftKey || domEvent.altKey) return null;
  // Something earlier already handled it; do not handle it twice.
  if (domEvent.defaultPrevented) return null;

  const target = domEvent.target;
  if (!(target instanceof Element)) return null;
  const anchor = target.closest("a");
  if (!(anchor instanceof HTMLAnchorElement)) return null;

  // No href, or an explicit opt-out the author wrote.
  if (!anchor.hasAttribute("href")) return null;
  if (anchor.hasAttribute("download")) return null;
  if (anchor.hasAttribute("data-native-link")) return null;
  // A target other than this frame is a deliberate instruction to the browser.
  const frame = anchor.getAttribute("target");
  if (frame !== null && frame !== "" && frame !== "_self") return null;
  if ((anchor.getAttribute("rel") ?? "").split(/\s+/).includes("external")) return null;

  const destination = resolve(anchor.getAttribute("href") ?? "", view.location.href);
  if (destination === null) return null;
  // Another origin, or a scheme the browser owns entirely: mailto:, tel:,
  // blob:, a download served from elsewhere.
  if (destination.origin !== view.location.origin) return null;
  if (destination.protocol !== view.location.protocol) return null;
  return anchor;
}

// Normalized browser conditions, never a browser exception string: an engine
// has to be able to branch on these exhaustively. The copied text is never
// read, never logged, and never appears in any value returned from here.
async function runClipboard(effect: ClipboardEffectRequest): Promise<ClipboardOutcome> {
  const api = globalThis.navigator?.clipboard;
  // `isSecureContext` is the specific, checkable reason the API is commonly
  // missing, and it is worth telling apart from a browser that simply has no
  // Clipboard API: one is fixed by deploying over HTTPS, the other is not.
  if (api === undefined || typeof api.writeText !== "function") {
    return { kind: "Failure", reason: globalThis.isSecureContext === false ? "not-secure-context" : "unsupported" };
  }
  try {
    await api.writeText(effect.text);
    return { kind: "Success" };
  } catch (error) {
    return { kind: "Failure", reason: isPermissionDenied(error) ? "permission-denied" : "failed" };
  }
}

function isPermissionDenied(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError");
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
