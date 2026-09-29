// Accessible interaction reference patterns (kemiller2002/limen#31, LCP-008).
// Pure pattern transitions first — keyboard happy path, Escape/cancel,
// disabled items, focus order, right-to-left — then the example through the
// real kernel with the events and focus capabilities: ARIA state is
// projection, and focus moves only when the engine asks. Real keyboard
// behaviour in Chromium: examples/09-accessible-patterns/checks.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { focusCapability } from "../dist/capabilities/focus/index.js";
import { eventsCapability } from "../dist/capabilities/events/index.js";
import {
  comboInput, comboKey, dialogClose, dialogOpen, gridKey, listboxKey, menuKey, menuOpen, tabsKey, treeKey, visibleNodes,
} from "../examples/09-accessible-patterns/patterns.ts";
import { createPatternsTransport, initialState } from "../examples/09-accessible-patterns/engine.ts";
import { exampleBody, withDom } from "./dom-helpers.ts";
import { conforming, assertEveryProjectionConformed } from "./view-conformance.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });
const keys = <S>(start: S, apply: (state: S, key: string) => S, sequence: readonly string[]): readonly S[] =>
  sequence.reduce<readonly S[]>((trail, key) => [...trail, apply(trail.at(-1) ?? start, key)], []);

// ---------------------------------------------------------------------------
// Pure patterns
// ---------------------------------------------------------------------------

test("tabs: arrows move and select, skipping the disabled tab and wrapping; Home/End; right-to-left reverses the arrows", () => {
  const ltr = keys(initialState.tabs, (tabs, key) => tabsKey(tabs, key, "ltr"), ["ArrowRight", "ArrowRight", "ArrowLeft", "End", "Home"]);
  assert.deepEqual(ltr.map((tabs) => tabs.selected), ["history", "overview", "history", "history", "overview"]);
  assert.equal(tabsKey(initialState.tabs, "ArrowLeft", "rtl").selected, "history", "in RTL, ArrowLeft is next");
  assert.equal(tabsKey(initialState.tabs, "a", "ltr"), initialState.tabs, "other keys change nothing");
});

test("menu: opens on its first item; arrows skip the disabled item; Enter activates and returns focus; Escape cancels and returns focus", () => {
  const open = menuOpen(initialState.menu, "first");
  assert.equal(open.active, "copy");
  const down = menuKey(open, "ArrowDown");
  assert.deepEqual([down.menu.active, down.focus], ["delete", { kind: "item", id: "delete" }], "paste is disabled and skipped");
  assert.deepEqual(menuKey(down.menu, "ArrowDown").menu.active, "copy", "wraps");
  const chosen = menuKey(down.menu, "Enter");
  assert.deepEqual([chosen.menu.open, chosen.menu.activated, chosen.focus], [false, "delete", { kind: "button" }]);
  const cancelled = menuKey(open, "Escape");
  assert.deepEqual([cancelled.menu.open, cancelled.menu.activated, cancelled.focus], [false, undefined, { kind: "button" }]);
  const onDisabled = menuKey({ ...open, active: "paste" }, " ");
  assert.deepEqual([onDisabled.menu.open, onDisabled.focus], [true, { kind: "unchanged" }], "a disabled item cannot be activated");
});

test("listbox: arrows clamp at the ends and skip disabled options; Space/Enter select only an enabled active option", () => {
  const trail = keys(initialState.listbox, listboxKey, ["ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown", " ", "Home", "Enter"]);
  assert.deepEqual(trail.map((listbox) => [listbox.active, listbox.selected]), [
    ["red", undefined], ["blue", undefined], ["yellow", undefined], ["yellow", undefined], ["yellow", "yellow"], ["red", "yellow"], ["red", "red"],
  ]);
  assert.equal(listboxKey({ ...initialState.listbox, active: "green" }, "Enter").selected, undefined);
});

test("combobox: typing filters and opens; ArrowDown/Enter pick; Escape closes first, then clears", () => {
  const typed = comboInput(initialState.combo, "do");
  assert.equal(typed.open, true, "Dominica and Dominican Republic match; Denmark does not");
  const picked = keys(typed, comboKey, ["ArrowDown", "ArrowDown", "Enter"]).at(-1);
  assert.deepEqual([picked?.text, picked?.selected, picked?.open], ["Dominican Republic", "dominican-republic", false]);
  const closed = comboKey(typed, "Escape");
  assert.deepEqual([closed.open, closed.text], [false, "do"]);
  assert.deepEqual(comboKey(closed, "Escape").text, "", "a second Escape clears the text");
  assert.equal(comboInput(initialState.combo, "xyz").open, false, "no match, no popup");
});

test("tree: the horizontal axis expands, enters, collapses and climbs; vertical follows the visible order; RTL reverses the axis", () => {
  const trail = keys(initialState.tree, (tree, key) => treeKey(tree, key, "ltr"), ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowUp", "ArrowLeft", "End"]);
  assert.deepEqual(trail.map((tree) => [tree.active, tree.expanded.join()]), [
    ["fruit", "fruit"], ["apple", "fruit"], ["banana", "fruit"], ["vegetables", "fruit"], ["vegetables", "fruit"], ["banana", "fruit"], ["fruit", "fruit"], ["vegetables", "fruit"],
  ]);
  assert.deepEqual(visibleNodes(trail[1] ?? initialState.tree).map((node) => node.id), ["fruit", "apple", "banana", "vegetables"]);
  assert.deepEqual(treeKey(initialState.tree, "ArrowLeft", "rtl").expanded, ["fruit"], "in RTL, ArrowLeft expands");
});

test("grid: arrows move and clamp; Home/End in the row; Ctrl+Home/End to the corners; RTL reverses left and right", () => {
  const start = initialState.grid;
  assert.deepEqual(gridKey(start, "ArrowRight", false, "ltr"), { ...start, column: 1 });
  assert.deepEqual(gridKey(start, "ArrowRight", false, "rtl"), start, "in RTL, ArrowRight moves back and clamps at the start");
  assert.deepEqual(gridKey(start, "ArrowLeft", false, "rtl"), { ...start, column: 1 });
  assert.deepEqual(gridKey({ ...start, row: 1, column: 1 }, "End", false, "ltr"), { ...start, row: 1, column: 2 });
  assert.deepEqual(gridKey(start, "End", true, "ltr"), { ...start, row: 2, column: 2 });
  assert.deepEqual(gridKey({ ...start, row: 2 }, "ArrowDown", false, "ltr"), { ...start, row: 2 });
});

test("dialog: opening records the opener; closing records how", () => {
  const opened = dialogOpen(initialState.dialog, "dialogOpener");
  assert.deepEqual(opened, { open: true, opener: "dialogOpener", result: undefined });
  assert.deepEqual(dialogClose(opened, "cancelled").result, "cancelled");
});

// ---------------------------------------------------------------------------
// The example through the real kernel and both capabilities
// ---------------------------------------------------------------------------

const run = async (act: (document: Document, press: (id: string, key: string, extra?: Record<string, unknown>) => void) => Promise<void>): Promise<void> => {
  const body = await exampleBody("09-accessible-patterns");
  await withDom(body, async (document) => {
    await new BrowserKernel(conforming("09-accessible-patterns", createPatternsTransport()), document, undefined, { capabilities: [focusCapability(), eventsCapability()], requireHandshake: true }).start();
    await sleep(0);
    const window = document.defaultView;
    assert.ok(window !== null);
    const press = (id: string, key: string, extra: Record<string, unknown> = {}): void => {
      const target = document.getElementById(id);
      assert.ok(target !== null, `#${id}`);
      const event = new window.Event("keydown", { bubbles: true, cancelable: true });
      Object.entries({ key, code: key, ...extra }).forEach(([name, value]) => Object.defineProperty(event, name, { value }));
      target.dispatchEvent(event);
    };
    await act(document, press);
  });
};

const settle = (): Promise<void> => sleep(20);
const attr = (document: Document, id: string, name: string): string | null => document.getElementById(id)?.getAttribute(name) ?? null;

test("tabs through the kernel: ARIA selection and the roving tabindex are projected, and focus follows", async () => {
  await run(async (document, press) => {
    assert.deepEqual([attr(document, "overview", "aria-selected"), attr(document, "overview", "tabindex"), attr(document, "billing", "aria-disabled")], ["true", "0", "true"]);
    document.getElementById("overview")?.focus();
    press("overview", "ArrowRight");
    await settle();
    assert.deepEqual([attr(document, "history", "aria-selected"), attr(document, "history", "tabindex"), attr(document, "overview", "tabindex")], ["true", "0", "-1"]);
    assert.equal(document.activeElement?.id, "history");
    assert.equal(document.getElementById("tab-panel")?.textContent, "History panel");
  });
});

test("menu through the kernel: ArrowDown opens and focuses the first item; Escape closes and returns focus to the button", async () => {
  await run(async (document, press) => {
    press("menu-button", "ArrowDown");
    await settle();
    assert.equal(attr(document, "menu-button", "aria-expanded"), "true");
    assert.equal(document.activeElement?.id, "copy");
    press("copy", "ArrowDown");
    await settle();
    assert.equal(document.activeElement?.id, "delete", "the disabled item is skipped");
    press("delete", "Escape");
    await settle();
    assert.equal(attr(document, "menu-button", "aria-expanded"), "false");
    assert.equal(document.getElementById("actions"), null, "the menu is unmounted");
    assert.equal(document.activeElement?.id, "menu-button");
  });
});

test("listbox and combobox through the kernel: aria-activedescendant is projected; focus stays on the widget", async () => {
  await run(async (document, press) => {
    document.getElementById("colours")?.focus();
    press("colours", "ArrowDown");
    press("colours", "ArrowDown");
    await settle();
    assert.equal(attr(document, "colours", "aria-activedescendant"), "option-blue");
    assert.equal(document.activeElement?.id, "colours");
    press("colours", " ");
    await settle();
    assert.equal(attr(document, "option-blue", "aria-selected"), "true");
    const country = document.getElementById("country");
    assert.ok(country instanceof HTMLInputElement);
    country.value = "e";
    country.dispatchEvent(new (document.defaultView?.Event ?? Event)("input", { bubbles: true }));
    await settle();
    press("country", "ArrowDown");
    await settle();
    assert.deepEqual([attr(document, "country", "aria-expanded"), attr(document, "country", "aria-activedescendant")], ["true", "country-egypt"]);
    press("country", "Escape");
    await settle();
    assert.deepEqual([attr(document, "country", "aria-expanded"), country.value], ["false", "e"]);
  });
});

test("dialog through the kernel: focus enters on open, the background is inert, Escape cancels and focus returns to the opener", async () => {
  await run(async (document, press) => {
    document.getElementById("dialog-opener")?.click();
    await settle();
    assert.equal(document.activeElement?.id, "new-name");
    assert.equal(document.querySelector("main")?.hasAttribute("inert"), true);
    press("rename", "Escape");
    await settle();
    assert.equal(document.getElementById("rename"), null);
    assert.equal(document.querySelector("main")?.hasAttribute("inert"), false);
    assert.equal(document.activeElement?.id, "dialog-opener");
    assert.equal(document.getElementById("dialog-result")?.textContent, "cancelled");
  });
});

test("every projection the patterns example made matched its view contract", () => {
  assertEveryProjectionConformed(["09-accessible-patterns"]);
});
