// The overlay pack's real-browser scenarios. The engine below is a scripted
// stand-in: before each action the page queues the overlay requests the engine
// will send with its next projection, then acts like a user and waits for the
// pack's answers. Native dismissals arrive as facts. scripts/smoke-packs.ts
// reads window.__limenPackResult and performs the trusted key presses and
// clicks the page asks for.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { overlayCapability, OVERLAY_CAPABILITY, decodeOverlayResult, decodeOverlayFact } from "../../../../dist/capabilities/overlay/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: OVERLAY_CAPABILITY.id, version: OVERLAY_CAPABILITY.version, fingerprint: OVERLAY_CAPABILITY.fingerprint };
const state = { queued: [], answers: [], facts: [], waiting: null, sequence: 0 };

const settle = () => {
  if (state.waiting !== null && state.answers.length >= state.waiting.count) {
    const answers = state.answers.splice(0);
    const resolve = state.waiting.resolve;
    state.waiting = null;
    resolve(answers);
  }
};

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "CapabilityFact") {
      const decoded = decodeOverlayFact(message.fact);
      state.facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" });
      return { view: {}, effects: [], cancellations: [] };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeOverlayResult(outcome.result) : { ok: false };
      state.answers.push(decoded.ok ? decoded.value : { kind: "Outcome:" + outcome.kind });
      settle();
      return { view: {}, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => {
      state.sequence += 1;
      return { kind: "Capability", correlationId: "overlay-" + state.sequence, capability: offer.id, version: 1, request };
    });
    state.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};

// The engine sends `requests` in answer to a click on #opener.
const ask = (requests) => new Promise((resolve) => {
  state.queued = requests;
  state.waiting = { count: requests.length, resolve };
  document.getElementById("opener").click();
});

// Trusted input performed by the runner.
const trusted = (action) => new Promise((resolve) => {
  window.__limenPackActionDone = resolve;
  window.__limenPackAction = action;
});
const press = (selector, key) => trusted({ kind: "press", selector, key });
const clickAt = (x, y) => trusted({ kind: "drag", from: [x, y], to: [x, y], steps: 1 });
const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 20))));
const takeFacts = async () => { await frames(); return state.facts.splice(0); };

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const target = (name) => ({ name });
const dialog = document.getElementById("rename");
const centre = (element) => { const rect = element.getBoundingClientRect(); return [rect.x + rect.width / 2, rect.y + rect.height / 2]; };
const topmostIsInside = (element) => { const [x, y] = centre(element); return element.contains(document.elementFromPoint(x, y)); };

await new BrowserKernel(engine, document, undefined, { capabilities: [overlayCapability()], requireHandshake: true }).start();

const [support] = await ask([{ operation: "support" }]);
expect("Chromium supports both native primitives", support.kind === "Support" && support.dialog && support.popover, support);

// --- Modal dialog: top layer, inert background, focus entry and return -----
document.getElementById("opener").focus();
const [shown] = await ask([{ operation: "showModal", target: target("rename") }]);
await frames();
expect("showModal lifts the dialog out of a clipped, zero-height, low z-index box into the top layer", shown.kind === "Shown" && dialog.matches(":modal") && topmostIsInside(dialog), { shown, modal: dialog.matches(":modal") });
expect("focus enters the dialog natively (its autofocus control)", document.activeElement?.id === "rename-name", document.activeElement?.id);
const behind = document.getElementById("behind");
const [bx, by] = centre(behind);
expect("the rest of the page is inert: the topmost element over a background button is not that button", document.elementFromPoint(bx, by) !== behind, document.elementFromPoint(bx, by)?.id);

const [again] = await ask([{ operation: "showModal", target: target("rename") }]);
expect("showModal on an open dialog is AlreadyOpen", again.kind === "AlreadyOpen", again);

await press("#rename-name", "Escape");
const cancelled = await takeFacts();
expect("Escape closes the dialog natively and the engine hears one cancel dismissal", !dialog.open && cancelled.length === 1 && cancelled[0].kind === "Dismissed" && cancelled[0].target.name === "rename" && cancelled[0].reason === "cancel", cancelled);
expect("focus returns natively to the element that had it before the dialog opened", document.activeElement?.id === "opener", document.activeElement?.id);

const [notOpen] = await ask([{ operation: "close", target: target("rename") }]);
expect("closing an already-dismissed dialog is NotOpen, not an error", notOpen.kind === "NotOpen", notOpen);

// --- A close the engine asked for is not reported back ---------------------
await ask([{ operation: "showModal", target: target("rename") }]);
const [closed] = await ask([{ operation: "close", target: target("rename"), returnValue: "saved" }]);
const afterClose = await takeFacts();
expect("the engine's own close answers Closed, carries its return value, and produces no fact", closed.kind === "Closed" && dialog.returnValue === "saved" && afterClose.length === 0, { closed, returnValue: dialog.returnValue, afterClose });

// --- A method=dialog form -----------------------------------------------
await ask([{ operation: "showModal", target: target("rename") }]);
document.getElementById("rename-ok").click();
const submitted = await takeFacts();
expect("the dialog's own method=dialog form is a submitted dismissal with the form's value", submitted.length === 1 && submitted[0].reason === "submitted" && submitted[0].returnValue === "ok", submitted);

// --- Nested: a popover inside a modal dialog closes first ------------------
await ask([{ operation: "showModal", target: target("rename") }]);
const [hint] = await ask([{ operation: "showPopover", target: target("hint"), anchor: target("hintButton"), sides: ["after", "below"] }]);
await frames();
expect("a popover inside a modal dialog opens above it, anchored to its button", hint.kind === "Shown" && hint.placement !== undefined && topmostIsInside(document.getElementById("hint")), hint);
await press("#rename-name", "Escape");
const first = await takeFacts();
expect("the first Escape closes only the innermost overlay (the popover)", first.length === 1 && first[0].target.name === "hint" && first[0].reason === "lightDismiss" && dialog.open, { first, dialogOpen: dialog.open });
await press("#rename-name", "Escape");
const second = await takeFacts();
expect("the second Escape closes the dialog, reported as a cancel even without a cancel event", second.length === 1 && second[0].target.name === "rename" && second[0].reason === "cancel" && !dialog.open, second);

// --- Anchored popover: flips above an anchor near the bottom edge ---------
const [menu] = await ask([{ operation: "showPopover", target: target("menu"), anchor: target("lowAnchor"), sides: ["below", "above"] }]);
await frames();
const menuRect = document.getElementById("menu").getBoundingClientRect();
const anchorRect = document.getElementById("low-anchor").getBoundingClientRect();
expect("an anchored popover that cannot fit below is placed above its anchor, where the pack says", menu.kind === "Shown" && menu.placement?.side === "above" && menu.placement.fits && Math.abs(menuRect.bottom - anchorRect.top) < 1 && Math.abs(menuRect.top - menu.placement.y) < 1, { menu, menuRect, anchorTop: anchorRect.top });

// --- Nested popovers: the engine hides the parent; the child is dismissed --
const [sub] = await ask([{ operation: "showPopover", target: target("submenu"), anchor: target("menu"), sides: ["after"] }]);
await takeFacts();
const [hidden] = await ask([{ operation: "hidePopover", target: target("menu") }]);
const nested = await takeFacts();
expect("hiding a parent popover closes its child; only the child, which the engine did not ask to close, is reported", sub.kind === "Shown" && hidden.kind === "Closed" && nested.length === 1 && nested[0].target.name === "submenu" && nested[0].reason === "lightDismiss", { sub, hidden, nested });

// --- Light dismiss by a click outside --------------------------------------
await ask([{ operation: "showPopover", target: target("menu"), sides: [] }]);
await clickAt(5, 300);
const outside = await takeFacts();
expect("a click outside light-dismisses the popover; the engine hears it once", outside.length === 1 && outside[0].target.name === "menu" && outside[0].reason === "lightDismiss" && !document.getElementById("menu").matches(":popover-open"), outside);

// --- Refusals -------------------------------------------------------------
const [wrong] = await ask([{ operation: "showModal", target: target("plain") }]);
const [notPopover] = await ask([{ operation: "showPopover", target: target("plain"), sides: [] }]);
const [missing] = await ask([{ operation: "showModal", target: target("no-such-overlay") }]);
expect("the wrong element kind and an unknown name are answered, not guessed", wrong.kind === "WrongElement" && notPopover.kind === "WrongElement" && missing.kind === "NotFound", { wrong, notPopover, missing });

await ask([{ operation: "show", target: target("rename") }]);
const [upgrade] = await ask([{ operation: "showModal", target: target("rename") }]);
expect("a non-modal dialog is not silently upgraded to modal", upgrade.kind === "AlreadyOpen" && !dialog.matches(":modal"), upgrade);
await ask([{ operation: "close", target: target("rename") }]);

window.__limenPackResult = { pack: "limen.overlay", checks };
