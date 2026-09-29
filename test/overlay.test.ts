// The overlay and top-layer pack (kemiller2002/limen#49, LCP-013). jsdom has
// no <dialog> methods and no popover API, which is itself the Unsupported
// case. The dismissal bookkeeping — which closes are the engine's and which
// are the browser's — is driven here through scripted dialog and popover
// methods; the real top layer, focus entry and return, light dismiss and
// nested close order are proven in Chromium (test/browser/packs/overlay/).

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import {
  OVERLAY_CAPABILITY, choosePlacement, decodeOverlayFact, decodeOverlayResult, overlayCapability, type OverlayFact, type OverlayRequest, type OverlayResult,
} from "../dist/capabilities/overlay/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineTransport } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const offer = { id: OVERLAY_CAPABILITY.id as CapabilityId, version: OVERLAY_CAPABILITY.version, fingerprint: OVERLAY_CAPABILITY.fingerprint };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------------------
// Placement is a pure choice over rectangles
// ---------------------------------------------------------------------------

const box = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const viewport = { width: 800, height: 600 };
const popup = { width: 200, height: 100 };

test("placement: the first requested side that fits wins; below flips above near the bottom edge", () => {
  assert.deepEqual(choosePlacement(box(100, 100, 80, 20), popup, viewport, ["below", "above"], false), { side: "below", x: 100, y: 120, fits: true });
  assert.deepEqual(choosePlacement(box(100, 550, 80, 20), popup, viewport, ["below", "above"], false), { side: "above", x: 100, y: 450, fits: true });
});

test("placement: after and before follow the text direction; the cross axis is clamped into the viewport", () => {
  assert.deepEqual(choosePlacement(box(100, 580, 80, 20), popup, viewport, ["after"], false), { side: "after", x: 180, y: 500, fits: true });
  assert.deepEqual(choosePlacement(box(300, 100, 80, 20), popup, viewport, ["after"], true), { side: "after", x: 100, y: 100, fits: true }, "in RTL, after is to the left");
  assert.deepEqual(choosePlacement(box(700, 100, 80, 20), popup, viewport, ["below"], false).x, 600, "clamped to the right edge");
});

test("placement: when nothing fits, the first side is used and says so; an empty list means below", () => {
  const tiny = { width: 150, height: 90 };
  assert.deepEqual(choosePlacement(box(10, 40, 50, 20), popup, tiny, ["below", "above"], false), { side: "below", x: 0, y: 60, fits: false });
  assert.equal(choosePlacement(box(100, 100, 80, 20), popup, viewport, [], false).side, "below");
});

// ---------------------------------------------------------------------------
// Direct provider: resolution, unsupported browsers, dismissal bookkeeping
// ---------------------------------------------------------------------------

const PAGE = `
  <dialog id="d" data-overlay-target="rename"><form method="dialog"><button value="ok">OK</button></form></dialog>
  <div id="p" popover data-overlay-target="menu"></div>
  <button id="anchor" data-overlay-target="menuButton">Menu</button>
  <div data-overlay-target="plain"></div>
  <ul><li data-overlay-key="a"><div popover data-overlay-target="row"></div></li><li data-overlay-key="b"><div popover data-overlay-target="row"></div></li></ul>
  <span data-overlay-target="twice"></span><span data-overlay-target="twice"></span>`;

type Provider = ReturnType<typeof overlayCapability>;
const ask = async (provider: Provider, document: Document, request: OverlayRequest): Promise<OverlayResult> => {
  const answer = await provider.execute(request, { correlationId: "o" as CorrelationId, signal: new AbortController().signal, document });
  assert.equal(answer.kind, "Completed");
  const decoded = answer.kind === "Completed" ? decodeOverlayResult(answer.result) : undefined;
  assert.ok(decoded?.ok === true, "every result decodes with the generated decoder");
  return decoded.value;
};

// Browser-shaped methods on a jsdom element: they change state synchronously
// and dispatch the non-bubbling events a browser queues, a task later.
const scriptDialog = (dialog: Element): void => {
  const window = dialog.ownerDocument.defaultView;
  assert.ok(window !== null);
  const fire = (type: string): void => { setTimeout(() => dialog.dispatchEvent(new window.Event(type, { cancelable: type === "cancel" })), 0); };
  Object.defineProperties(dialog, {
    returnValue: { value: "", writable: true },
    showModal: { value: () => { Reflect.set(dialog, "open", true); } },
    show: { value: () => { Reflect.set(dialog, "open", true); } },
    close: { value: (value?: string) => { if (value !== undefined) Reflect.set(dialog, "returnValue", value); Reflect.set(dialog, "open", false); fire("close"); } },
  });
};
const scriptPopover = (popover: Element): void => {
  const window = popover.ownerDocument.defaultView;
  assert.ok(window !== null);
  const state = { open: false };
  const toggle = (newState: string): void => {
    state.open = newState === "open";
    const event = new window.Event("toggle");
    Object.defineProperty(event, "newState", { value: newState });
    setTimeout(() => popover.dispatchEvent(event), 0);
  };
  const matches = popover.matches.bind(popover);
  Object.defineProperties(popover, {
    matches: { value: (selector: string) => (selector === ":popover-open" ? state.open : matches(selector)) },
    showPopover: { value: () => toggle("open") },
    hidePopover: { value: () => toggle("closed") },
  });
};

const withProvider = async <T>(act: (provider: Provider, document: Document, facts: OverlayFact[]) => Promise<T>): Promise<T> =>
  withDom(PAGE, async (document) => {
    const facts: OverlayFact[] = [];
    const provider = overlayCapability();
    provider.activate({ document, emitFact: (fact) => {
      const decoded = decodeOverlayFact(fact);
      assert.ok(decoded.ok, "every fact decodes with the generated decoder");
      facts.push(decoded.value);
    } });
    return act(provider, document, facts);
  });

test("targets resolve as every pack's do: NotFound, Ambiguous, a row by key; the wrong element kind is refused", async () => {
  await withProvider(async (provider, document) => {
    assert.deepEqual(await ask(provider, document, { operation: "showModal", target: { name: "nope" } }), { kind: "NotFound" });
    assert.deepEqual(await ask(provider, document, { operation: "showModal", target: { name: "twice" } }), { kind: "Ambiguous", count: 2 });
    assert.deepEqual(await ask(provider, document, { operation: "showModal", target: { name: "plain" } }), { kind: "WrongElement" }, "not a <dialog>");
    assert.deepEqual(await ask(provider, document, { operation: "showPopover", target: { name: "plain" }, sides: [] }), { kind: "WrongElement" }, "no popover attribute");
    assert.deepEqual(await ask(provider, document, { operation: "showPopover", target: { name: "row" }, sides: [] }), { kind: "Ambiguous", count: 2 });
    assert.deepEqual(await ask(provider, document, { operation: "showPopover", target: { name: "menu" }, anchor: { name: "gone" }, sides: [] }), { kind: "NotFound" }, "a missing anchor");
  });
});

test("a browser without <dialog> methods or the popover API answers Unsupported, and support says so up front", async () => {
  await withProvider(async (provider, document) => {
    assert.deepEqual(await ask(provider, document, { operation: "support" }), { kind: "Support", dialog: false, popover: false });
    assert.deepEqual(await ask(provider, document, { operation: "showModal", target: { name: "rename" } }), { kind: "Unsupported" });
    assert.deepEqual(await ask(provider, document, { operation: "showPopover", target: { name: "row", key: "b" }, sides: [] }), { kind: "Unsupported" });
  });
});

test("dialog: show, AlreadyOpen, close; a close the engine asked for is not reported back", async () => {
  await withProvider(async (provider, document, facts) => {
    const dialog = document.getElementById("d");
    assert.ok(dialog !== null);
    scriptDialog(dialog);
    assert.deepEqual(await ask(provider, document, { operation: "showModal", target: { name: "rename" } }), { kind: "Shown" });
    assert.deepEqual(await ask(provider, document, { operation: "show", target: { name: "rename" } }), { kind: "AlreadyOpen" });
    assert.deepEqual(await ask(provider, document, { operation: "close", target: { name: "rename" }, returnValue: "saved" }), { kind: "Closed" });
    assert.deepEqual(await ask(provider, document, { operation: "close", target: { name: "rename" } }), { kind: "NotOpen" });
    await sleep(5);
    assert.deepEqual(facts, []);
  });
});

test("dialog: Escape (with or without a cancel event) is a cancel dismissal; a method=dialog form is a submitted dismissal with its return value", async () => {
  await withProvider(async (provider, document, facts) => {
    const dialog = document.getElementById("d");
    const window = document.defaultView;
    assert.ok(dialog !== null && window !== null);
    scriptDialog(dialog);
    await ask(provider, document, { operation: "showModal", target: { name: "rename" } });
    dialog.dispatchEvent(new window.Event("cancel", { cancelable: true }));
    Reflect.set(dialog, "open", false);
    dialog.dispatchEvent(new window.Event("close"));
    await ask(provider, document, { operation: "showModal", target: { name: "rename" } });
    Reflect.set(dialog, "open", false);
    dialog.dispatchEvent(new window.Event("close"));
    await ask(provider, document, { operation: "showModal", target: { name: "rename" } });
    const form = dialog.querySelector("form");
    assert.ok(form !== null);
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    Reflect.set(dialog, "returnValue", "ok");
    Reflect.set(dialog, "open", false);
    dialog.dispatchEvent(new window.Event("close"));
    assert.deepEqual(facts, [
      { kind: "Dismissed", target: { name: "rename" }, reason: "cancel" },
      { kind: "Dismissed", target: { name: "rename" }, reason: "cancel" },
      { kind: "Dismissed", target: { name: "rename" }, reason: "submitted", returnValue: "ok" },
    ]);
  });
});

test("popover: a hide the engine asked for is silent; a light dismiss is reported once with the row's key", async () => {
  await withProvider(async (provider, document, facts) => {
    const [first, second] = Array.from(document.querySelectorAll("[data-overlay-target=row]"));
    const menu = document.getElementById("p");
    assert.ok(first !== undefined && second !== undefined && menu !== null);
    [first, second, menu].forEach(scriptPopover);
    assert.deepEqual(await ask(provider, document, { operation: "showPopover", target: { name: "row", key: "b" }, sides: [] }), { kind: "Shown" });
    assert.deepEqual(await ask(provider, document, { operation: "showPopover", target: { name: "row", key: "b" }, sides: [] }), { kind: "AlreadyOpen" });
    assert.deepEqual(await ask(provider, document, { operation: "hidePopover", target: { name: "row", key: "b" } }), { kind: "Closed" });
    assert.deepEqual(await ask(provider, document, { operation: "hidePopover", target: { name: "row", key: "b" } }), { kind: "NotOpen" });
    await ask(provider, document, { operation: "showPopover", target: { name: "row", key: "a" }, sides: [] });
    await sleep(5);
    Reflect.get(first, "hidePopover").call(first);
    await sleep(5);
    const shown = await ask(provider, document, { operation: "showPopover", target: { name: "menu" }, anchor: { name: "menuButton" }, sides: ["below"] });
    assert.ok(shown.kind === "Shown" && shown.placement?.side === "below", "an anchored popover reports where it was placed");
    assert.deepEqual([menu instanceof window.HTMLElement && menu.style.left !== "", menu instanceof window.HTMLElement && menu.style.inset], [true, "auto"]);
    assert.deepEqual(facts, [{ kind: "Dismissed", target: { name: "row", key: "a" }, reason: "lightDismiss" }]);
  });
});

test("a browser that throws is answered Refused with the exception's name only", async () => {
  await withProvider(async (provider, document) => {
    const dialog = document.getElementById("d");
    assert.ok(dialog !== null);
    Object.defineProperty(dialog, "showModal", { value: () => { throw Object.assign(new Error("secret page detail"), { name: "InvalidStateError" }); } });
    assert.deepEqual(await ask(provider, document, { operation: "showModal", target: { name: "rename" } }), { kind: "Refused", reason: "InvalidStateError" });
  });
});

// ---------------------------------------------------------------------------
// Through the kernel: facts reach only an engine that selected the pack
// ---------------------------------------------------------------------------

const throughKernel = async (select: boolean): Promise<readonly unknown[]> => {
  const heard: unknown[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "CapabilityFact") heard.push(message.fact);
      return {
        view: {}, cancellations: [],
        effects: message.kind === "Initialize" && select ? [{ kind: "Capability", correlationId: "o1" as CorrelationId, capability: offer.id, version: 1, request: { operation: "showModal", target: { name: "rename" } } }] : [],
        ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: select ? [offer] : [] } } : {}),
      };
    },
  };
  return withDom(PAGE, async (document) => {
    const dialog = document.getElementById("d");
    const window = document.defaultView;
    assert.ok(dialog !== null && window !== null);
    scriptDialog(dialog);
    await new BrowserKernel(transport, document, undefined, { capabilities: [overlayCapability()], requireHandshake: true }).start();
    await sleep(0);
    dialog.dispatchEvent(new window.Event("cancel", { cancelable: true }));
    Reflect.set(dialog, "open", false);
    dialog.dispatchEvent(new window.Event("close"));
    await sleep(10);
    return [...heard];
  });
};

test("through the kernel, a native dismissal reaches the engine as a CapabilityFact; an engine that did not select the pack hears nothing", async () => {
  assert.deepEqual(await throughKernel(true), [{ kind: "Dismissed", target: { name: "rename" }, reason: "cancel" }]);
  assert.deepEqual(await throughKernel(false), []);
});

test("the overlay pack passes the shared provider conformance suite", async () => {
  await withDom(PAGE, async (document) => {
    assert.deepEqual(await runProviderConformance(overlayCapability(), {
      document,
      decodeResult: decodeOverlayResult,
      valid: [{ name: "support", payload: { operation: "support" } }, { name: "showModal", payload: { operation: "showModal", target: { name: "rename" } } }],
      malformed: [
        { name: "no sides", payload: { operation: "showPopover", target: { name: "menu" } } },
        { name: "unknown side", payload: { operation: "showPopover", target: { name: "menu" }, sides: ["left"] } },
        { name: "extra field", payload: { operation: "support", element: {} } },
      ],
      cancellable: { name: "support", payload: { operation: "support" } },
    }), []);
  });
});
