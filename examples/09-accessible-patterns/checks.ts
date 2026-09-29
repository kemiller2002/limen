// Real-browser checks for the accessible patterns, run only with ?check by
// scripts/smoke-packs.ts: trusted key presses (performed by the runner) must
// move real focus and change projected ARIA state exactly as the patterns say.
// Never loaded in normal use.

type Check = { readonly name: string; readonly ok: boolean; readonly detail: string };
type Action = { readonly kind: "press"; readonly selector: string; readonly key: string };

const checks: Check[] = [];
const expect = (name: string, ok: boolean, detail: unknown): void => { checks.push({ name, ok, detail: JSON.stringify(detail) }); };
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 60); });

// Ask the runner for a trusted key press on an element, and wait for it.
const press = (selector: string, key: string): Promise<void> => new Promise((resolve) => {
  const action: Action = { kind: "press", selector, key };
  Reflect.set(window, "__limenPackActionDone", () => { void settle().then(resolve); });
  Reflect.set(window, "__limenPackAction", action);
});

const active = (): string => document.activeElement?.id ?? "";
const attr = (id: string, name: string): string | null => document.getElementById(id)?.getAttribute(name) ?? null;

await press("#overview", "ArrowRight");
expect("tabs: ArrowRight skips the disabled tab, selects and focuses the next", active() === "history" && attr("history", "aria-selected") === "true" && attr("overview", "tabindex") === "-1", { active: active(), panel: document.getElementById("tab-panel")?.textContent });
await press("#history", "Home");
expect("tabs: Home returns to the first tab", active() === "overview" && attr("overview", "aria-selected") === "true", active());
await press("#overview", "Tab");
expect("focus order: Tab leaves the tab list after the one selected tab (roving tabindex)", active() === "menu-button", active());

await press("#menu-button", "ArrowDown");
expect("menu: ArrowDown opens it and focuses the first item", attr("menu-button", "aria-expanded") === "true" && active() === "copy", active());
await press("#copy", "ArrowDown");
expect("menu: the disabled item is skipped", active() === "delete", active());
await press("#delete", "Escape");
expect("menu: Escape cancels, closes and returns focus to the button", attr("menu-button", "aria-expanded") === "false" && document.getElementById("actions") === null && active() === "menu-button" && document.getElementById("menu-result")?.textContent === "Nothing chosen", active());
await press("#menu-button", "ArrowUp");
await press("#delete", "Enter");
expect("menu: Enter activates the item and returns focus", document.getElementById("menu-result")?.textContent === "Chose delete" && active() === "menu-button", document.getElementById("menu-result")?.textContent);

await press("#colours", "ArrowDown");
await press("#colours", "ArrowDown");
await press("#colours", "Space");
expect("listbox: arrows move aria-activedescendant past the disabled option; Space selects; focus stays on the listbox", attr("colours", "aria-activedescendant") === "option-blue" && attr("option-blue", "aria-selected") === "true" && active() === "colours", { descendant: attr("colours", "aria-activedescendant") });

await press("#country", "e");
await press("#country", "ArrowDown");
await press("#country", "ArrowDown");
await press("#country", "Enter");
const country = document.getElementById("country");
expect("combobox: real typing filters; arrows and Enter pick; the popup closes", country instanceof HTMLInputElement && country.value === "Estonia" && attr("country", "aria-expanded") === "false", country instanceof HTMLInputElement ? country.value : null);
await press("#country", "Escape");
expect("combobox: Escape with the popup closed clears the text", country instanceof HTMLInputElement && country.value === "", country instanceof HTMLInputElement ? country.value : null);

await press("#fruit", "ArrowRight");
await press("#fruit", "ArrowRight");
expect("tree: ArrowRight expands, then enters the first child", attr("fruit", "aria-expanded") === "true" && active() === "apple" && attr("apple", "aria-level") === "2", active());
await press("#apple", "ArrowLeft");
expect("tree: ArrowLeft on a child climbs to its parent", active() === "fruit", active());

await press("#cell-0-0", "ArrowLeft");
expect("grid (dir=rtl, a real computed direction): ArrowLeft moves to the next column", active() === "cell-0-1", active());
await press("#cell-0-1", "Control+End");
expect("grid: Ctrl+End moves to the last cell", active() === "cell-2-2", active());

await press("#dialog-opener", "Enter");
expect("dialog: opening moves focus inside and makes the background inert", active() === "new-name" && document.querySelector("main")?.hasAttribute("inert") === true, active());
await press("#new-name", "Escape");
expect("dialog: Escape cancels and returns focus to the opener", document.getElementById("rename") === null && active() === "dialog-opener" && document.getElementById("dialog-result")?.textContent === "cancelled", active());

Reflect.set(window, "__limenPackResult", { pack: "patterns (Forma reference)", checks });

// A module, so the checks can await at the top level.
export {};
