// The focus pack's real-browser scenarios. The engine below is a scripted
// stand-in: before each action the page queues the focus requests the engine
// will send with its next projection, then acts like a user (a click) and
// waits for the pack's answers. scripts/smoke-packs.ts reads
// window.__limenPackResult.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { focusCapability, FOCUS_CAPABILITY, decodeFocusResult } from "../../../../dist/capabilities/focus/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: FOCUS_CAPABILITY.id, version: FOCUS_CAPABILITY.version, fingerprint: FOCUS_CAPABILITY.fingerprint };
const rows = (ids) => ids.map((id) => ({ id, label: "row " + id }));

const state = { view: { dialogOpen: false, screen: "1", rows: rows(["1", "2", "3"]) }, queued: [], answers: [], waiting: null, sequence: 0 };

const transition = (event) => {
  const view = state.view;
  switch (event.name) {
    case "open": return { ...view, dialogOpen: true };
    case "next": return { ...view, screen: String(Number(view.screen) + 1) };
    case "remove": return { ...view, rows: view.rows.filter((row) => row.id !== event.key) };
    default: return view;
  }
};

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: state.view, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 1 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeFocusResult(outcome.result) : { ok: false };
      state.answers.push(decoded.ok ? decoded.value : { kind: "Outcome:" + outcome.kind });
      if (state.waiting !== null && state.answers.length >= state.waiting.count) state.waiting.resolve(state.answers.splice(0));
      return { view: state.view, effects: [], cancellations: [] };
    }
    if (message.kind === "Event") state.view = transition(message.event);
    const effects = state.queued.map((request) => {
      state.sequence += 1;
      return { kind: "Capability", correlationId: "focus-" + state.sequence, capability: offer.id, version: 1, request };
    });
    state.queued = [];
    return { view: state.view, effects, cancellations: [] };
  },
};

const act = (requests, action) => new Promise((resolve) => {
  state.queued = requests;
  state.waiting = { count: requests.length, resolve };
  action();
});

const click = (selector) => () => document.querySelector(selector).click();
const active = () => document.activeElement?.id || document.activeElement?.closest("li")?.getAttribute("data-focus-key") || document.activeElement?.tagName;
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const target = (name, extra = {}) => ({ name, ...extra });

await new BrowserKernel(engine, document, undefined, { capabilities: [focusCapability()], requireHandshake: true }).start();
document.getElementById("keep").focus();

const [opened] = await act([{ operation: "focusFirst", scope: target("dialog") }], click("#open"));
expect("dialog opens and focus moves to its first focusable control (a disabled one is skipped)", opened.kind === "Done" && active() === "dialog-name", { opened, active: active() });

const [last] = await act([{ operation: "focusLast", scope: target("dialog") }], click("#poke"));
expect("focusLast reaches the dialog's last control", last.kind === "Done" && active() === "dialog-save", { last, active: active() });

const [selected] = await act([{ operation: "select", target: target("name"), start: 0, end: 6 }], click("#poke"));
const name = document.getElementById("dialog-name");
expect("select sets a real text selection", selected.kind === "Done" && name.selectionStart === 0 && name.selectionEnd === 6 && active() === "dialog-name", { selected, start: name.selectionStart, end: name.selectionEnd });

const [email] = await act([{ operation: "select", target: target("email"), start: 0, end: 1 }], click("#poke"));
expect("an email input has no text selection in Chromium: NotSelectable", email.kind === "NotSelectable", email);

const [off] = await act([{ operation: "focus", target: target("off"), preventScroll: false }], click("#poke"));
expect("a disabled control is NotFocusable and focus stays put", off.kind === "NotFocusable" && active() === "dialog-email", { off, active: active() });

const [restored] = await act([{ operation: "focus", target: target("remove", { key: "3" }), preventScroll: true }], click("li:nth-child(2) button"));
expect("deleting row 2 restores focus to row 3's control", restored.kind === "Done" && active() === "3", { restored, active: active() });

const [gone] = await act([{ operation: "focus", target: target("remove", { key: "2" }), preventScroll: true }], click("#poke"));
expect("a deleted row's key is NotFound", gone.kind === "NotFound", gone);

const [stale] = await act([{ operation: "focus", target: target("add", { generation: "1" }), preventScroll: false }], click("#next"));
expect("a request made for screen 1 after the move to screen 2 is Stale, and focus does not move", stale.kind === "Stale" && stale.current === "2" && active() === "3", { stale, active: active() });

const [current] = await act([{ operation: "focus", target: target("add", { generation: "2" }), preventScroll: false }], click("#poke"));
expect("the same request for the current screen is performed", current.kind === "Done" && active() === "add", { current, active: active() });

const [scrolled] = await act([{ operation: "scrollIntoView", target: target("far"), block: "start", smooth: false }], click("#poke"));
const top = document.getElementById("far").getBoundingClientRect().top;
expect("scrollIntoView scrolls a far element to the top of the viewport", scrolled.kind === "Done" && window.scrollY > 1000 && Math.abs(top) < 2, { scrolled, scrollY: window.scrollY, top });

window.scrollTo(0, 0);
const [quiet] = await act([{ operation: "focus", target: target("far"), preventScroll: true }], click("#poke"));
expect("focus with preventScroll moves focus without scrolling", quiet.kind === "Done" && active() === "far" && window.scrollY === 0, { quiet, scrollY: window.scrollY });

const [missing] = await act([{ operation: "focus", target: target("no-such-target"), preventScroll: false }], click("#poke"));
expect("an unknown target is NotFound", missing.kind === "NotFound", missing);

window.__limenPackResult = { pack: "limen.focus", checks };
