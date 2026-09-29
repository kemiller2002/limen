// A hand-written EngineTransport for this demo page — not a real engine,
// just enough state and command handling to exercise every bridge
// primitive. Nothing here is bridge code; BrowserKernel itself is imported
// unmodified from the real build.
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";

const STORAGE_KEY = "kitchen-sink-demo";
const QUOTA_DEMO_KEY = "kitchen-sink-quota-demo";

let effectSequence = 0;
function httpEffect(url, { timeoutMs = 3000, method = "GET", headers, body } = {}) {
  const effect = { kind: "Http", correlationId: `demo-${++effectSequence}`, method, url, timeoutMs };
  if (headers) effect.headers = headers;
  if (body !== undefined) effect.body = body;
  return effect;
}
function storageEffect(operation, key, value) {
  const effect = { kind: "Storage", correlationId: `demo-${++effectSequence}`, operation, key };
  if (operation === "set") effect.value = value;
  return effect;
}

class KitchenSinkEngine {
  #counter = 0;
  #panelOpen = false;
  #query = "";
  #items = [
    { id: "1", label: "Write the kernel" },
    { id: "2", label: "Write the tests" },
    { id: "3", label: "Ship it" },
  ];
  #nextItemId = 4;
  #selectedId = null;
  #log = [];
  #nextLogId = 1;
  #broken = false;
  #cancellableId = null;
  #showBrokenProjection = false;
  #storageDraft = "";
  #storedValue = "(not fetched yet — click Get)";
  #pendingStorageOps = new Map(); // correlationId -> "get" | "set" | "remove" | "quota-demo"

  async start() {}

  #pushLog(text) {
    this.#log = [{ id: String(this.#nextLogId++), text }, ...this.#log].slice(0, 12);
  }

  #view(overrides = {}) {
    const view = {
      counter: this.#counter,
      panelOpen: this.#panelOpen,
      query: this.#query,
      items: this.#items.map((item) => ({ ...item, selected: item.id === this.#selectedId })),
      log: this.#log,
      storedValue: this.#storedValue,
      deliberatelyMissing: "present — click “Trigger a malformed projection” to make it go stale",
      ...overrides.view,
    };
    if (this.#showBrokenProjection) delete view.deliberatelyMissing;
    return { view, effects: overrides.effects ?? [], cancellations: overrides.cancellations ?? [] };
  }

  async dispatch(message) {
    if (this.#broken && message.kind !== "Initialize") {
      throw new Error("simulated engine crash — the transport itself is throwing now");
    }
    if (message.kind === "Initialize") {
      this.#pushLog("Initialize");
      return this.#view();
    }
    if (message.kind === "Event") {
      const { name, key, value } = message.event;
      switch (name) {
        case "increment":
          this.#counter += 1;
          this.#pushLog(`increment → ${this.#counter}`);
          return this.#view();
        case "toggle":
          this.#panelOpen = !this.#panelOpen;
          this.#pushLog(`toggle → panelOpen=${this.#panelOpen}`);
          return this.#view();
        case "search":
          this.#query = value ?? "";
          this.#pushLog(`search (data-on="input") → "${this.#query}"`);
          return this.#view();
        case "addItem":
          this.#items = [...this.#items, { id: String(this.#nextItemId), label: `Item ${this.#nextItemId}` }];
          this.#nextItemId += 1;
          this.#pushLog("addItem");
          return this.#view();
        case "removeItem":
          this.#items = this.#items.filter((item) => item.id !== key);
          this.#pushLog(`removeItem key=${key}`);
          return this.#view();
        case "selectItem":
          this.#selectedId = key;
          this.#pushLog(`selectItem key=${key} (click on a plain <li>, default trigger)`);
          return this.#view();
        case "shuffle":
          this.#items = [...this.#items].reverse();
          this.#pushLog("shuffle — same DOM nodes, new order");
          return this.#view();
        case "triggerSuccess":
          this.#pushLog("→ effect requested: success");
          return this.#view({ effects: [httpEffect("/demo/success")] });
        case "triggerNetworkFailure":
          this.#pushLog("→ effect requested: network failure");
          return this.#view({ effects: [httpEffect("/demo/network-failure")] });
        case "triggerInvalidResponse":
          this.#pushLog("→ effect requested: invalid response");
          return this.#view({ effects: [httpEffect("/demo/invalid-response")] });
        case "triggerTimeout":
          this.#pushLog("→ effect requested: timeout (800ms, always OutcomeUnknown)");
          return this.#view({ effects: [httpEffect("/demo/hang", { timeoutMs: 800 })] });
        case "triggerCancellable": {
          const effect = httpEffect("/demo/hang", { timeoutMs: 30000 });
          this.#cancellableId = effect.correlationId;
          this.#pushLog(`→ effect requested: cancellable (${effect.correlationId})`);
          return this.#view({ effects: [effect] });
        }
        case "cancelEffect":
          if (!this.#cancellableId) {
            this.#pushLog("cancelEffect — nothing in flight");
            return this.#view();
          }
          this.#pushLog(`cancelEffect → ${this.#cancellableId}`);
          return this.#view({ cancellations: [this.#cancellableId] });
        case "triggerBrokenProjection":
          this.#showBrokenProjection = true;
          this.#pushLog("→ (deliberately) omitting a bound view key");
          return this.#view();
        case "breakTransport":
          this.#pushLog("breakTransport → every dispatch after this one throws");
          this.#broken = true;
          return this.#view();
        case "triggerPut": {
          const effect = httpEffect("/demo/echo", {
            method: "PUT",
            headers: { authorization: "token demo-secret-value", "x-demo-header": "hello" },
            body: JSON.stringify({ message: "hi from the kitchen sink" }),
          });
          this.#pushLog("→ effect requested: PUT with headers & body");
          return this.#view({ effects: [effect] });
        }
        case "storageDraft":
          this.#storageDraft = value ?? "";
          return this.#view();
        case "storageSet": {
          const effect = storageEffect("set", STORAGE_KEY, this.#storageDraft);
          this.#pendingStorageOps.set(effect.correlationId, "set");
          this.#pushLog(`→ effect requested: Storage set "${this.#storageDraft}"`);
          return this.#view({ effects: [effect] });
        }
        case "storageGet": {
          const effect = storageEffect("get", STORAGE_KEY);
          this.#pendingStorageOps.set(effect.correlationId, "get");
          this.#pushLog("→ effect requested: Storage get");
          return this.#view({ effects: [effect] });
        }
        case "storageRemove": {
          const effect = storageEffect("remove", STORAGE_KEY);
          this.#pendingStorageOps.set(effect.correlationId, "remove");
          this.#pushLog("→ effect requested: Storage remove");
          return this.#view({ effects: [effect] });
        }
        case "storageQuotaDemo": {
          const effect = storageEffect("set", QUOTA_DEMO_KEY, "x");
          this.#pendingStorageOps.set(effect.correlationId, "quota-demo");
          this.#pushLog("→ effect requested: Storage set (deliberately over quota)");
          return this.#view({ effects: [effect] });
        }
        default:
          this.#pushLog(`unrecognized event: ${name}`);
          return this.#view();
      }
    }
    if (message.kind === "EffectResult" && message.result.kind === "StorageResult") {
      const { outcome, correlationId } = message.result;
      const op = this.#pendingStorageOps.get(correlationId);
      this.#pendingStorageOps.delete(correlationId);
      const detail = outcome.kind === "Success" ? `value=${JSON.stringify(outcome.value)}` : `reason ${outcome.reason}`;
      this.#pushLog(`← StorageResult ${outcome.kind} (${op}, ${detail})`);
      if (outcome.kind === "Success" && op === "get") {
        this.#storedValue = outcome.value === null ? "(none)" : outcome.value;
        return this.#view();
      }
      if (outcome.kind === "Success" && (op === "set" || op === "remove")) {
        // Chase a successful write with a read, so the displayed value
        // always reflects what's actually in storage now.
        const getEffect = storageEffect("get", STORAGE_KEY);
        this.#pendingStorageOps.set(getEffect.correlationId, "get");
        return this.#view({ effects: [getEffect] });
      }
      return this.#view();
    }
    if (message.kind === "EffectResult") {
      const { outcome } = message.result;
      const detail = outcome.kind === "Success" ? `status ${outcome.status} ${JSON.stringify(outcome.body)}`
        : outcome.kind === "Failure" ? `reason ${outcome.reason}`
        : outcome.kind === "OutcomeUnknown" ? outcome.reason
        : "";
      this.#pushLog(`← EffectResult ${outcome.kind}${detail ? ` (${detail})` : ""}`);
      if (message.result.correlationId === this.#cancellableId) this.#cancellableId = null;
      return this.#view();
    }
    return this.#view();
  }
}

// Demo-only: fake fetch so this page needs no server. BrowserKernel's own
// fetch/timeout/AbortController/classification logic is exercised for real —
// only the network layer underneath it is simulated.
const realFetch = window.fetch?.bind(window);
window.fetch = async (url, init) => {
  if (url === "/demo/success") return { status: 200, json: async () => ({ message: "hello from the (fake) server" }) };
  if (url === "/demo/network-failure") throw new Error("simulated DNS failure");
  if (url === "/demo/invalid-response") return { status: 200, json: async () => { throw new Error("not valid JSON"); } };
  if (url === "/demo/hang") {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(String(init.signal?.reason))));
    });
  }
  if (url === "/demo/echo") {
    // Echoes back exactly what the kernel sent, so the extended Http effect
    // (method/headers/body) is visibly proven to have reached fetch() —
    // not asserted, shown.
    return { status: 200, json: async () => ({ method: init?.method, headers: init?.headers, body: init?.body }) };
  }
  if (realFetch) return realFetch(url, init);
  throw new Error(`kitchen-sink.js: no fake handler for ${url}`);
};

// Demo-only: force a QuotaExceededError for one specific key, so the
// Storage-effect failure path is visible without actually filling up
// localStorage. Every other key — including the real demo key above —
// passes through to the real implementation untouched.
const realSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function setItem(key, value) {
  if (key === QUOTA_DEMO_KEY) throw new DOMException("simulated quota exceeded", "QuotaExceededError");
  return realSetItem.call(this, key, value);
};

const diagnosticsEl = document.getElementById("diagnostics");
const diagnosticsLines = [];
const diagnosticsSink = {
  report(event) {
    const stamp = new Date().toISOString().slice(11, 19);
    // Switch on kind, and say something for kinds this page does not know:
    // DiagnosticEvent grows (Handshake arrived in protocol 1.1).
    const line = (() => {
      switch (event.kind) {
        case "BridgeError": return `[${stamp}] BridgeError (${event.phase}): ${event.detail}`;
        case "EffectTiming": return `[${stamp}] EffectTiming ${event.correlationId}: ${event.durationMs.toFixed(1)}ms`;
        case "Handshake": return `[${stamp}] Handshake: ${event.verdict.kind}${event.verdict.kind === "Compatible" ? ` (${event.verdict.negotiation.kind})` : ` — ${event.verdict.reason.kind}`}`;
        default: return `[${stamp}] ${event.kind}`;
      }
    })();
    diagnosticsLines.unshift(line);
    diagnosticsLines.length = Math.min(diagnosticsLines.length, 12);
    diagnosticsEl.textContent = diagnosticsLines.join("\n");
  },
};

const kernel = new BrowserKernel(new KitchenSinkEngine(), document, diagnosticsSink);
await kernel.start();
