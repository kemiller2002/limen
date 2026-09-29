// Accessible interaction patterns as pure state machines
// (kemiller2002/limen#31, LCP-008). Each takes a widget's state and one key
// (plus the element's text direction, where arrows are horizontal) and returns
// the next state. What the browser must *do* — move focus, keep the default
// action from happening — is decided elsewhere: the default is prevented
// declaratively in HTML (data-rich-prevent), and focus moves through the focus
// capability when the engine asks. ARIA state is only ever projected from
// these values.
//
// These are reference proofs for the Forma project, which owns reusable
// interaction patterns; they show that Limen's generic mechanics are enough.
// No widget meaning lives in the kernel or in any capability.

export type Item = { readonly id: string; readonly label: string; readonly disabled?: boolean };
export type Direction = "ltr" | "rtl";

const usable = (items: readonly Item[]): readonly Item[] => items.filter((item) => item.disabled !== true);

// The next usable item from `from`, `delta` steps away; wrapping or clamping.
export const move = (items: readonly Item[], from: string | undefined, delta: 1 | -1, wrap: boolean): string | undefined => {
  const list = usable(items);
  const count = list.length;
  if (count === 0) return undefined;
  const index = list.findIndex((item) => item.id === from);
  if (index < 0) return (delta > 0 ? list[0] : list[count - 1])?.id;
  const next = index + delta;
  const target = wrap ? (next + count) % count : Math.min(count - 1, Math.max(0, next));
  return list[target]?.id;
};

export const first = (items: readonly Item[]): string | undefined => usable(items)[0]?.id;
export const last = (items: readonly Item[]): string | undefined => usable(items).at(-1)?.id;

// "Next" along a horizontal axis is ArrowRight in LTR and ArrowLeft in RTL.
export const horizontal = (key: string, direction: Direction): 1 | -1 | undefined => {
  if (key === "ArrowRight") return direction === "rtl" ? -1 : 1;
  if (key === "ArrowLeft") return direction === "rtl" ? 1 : -1;
  return undefined;
};

// ---------------------------------------------------------------------------
// Tabs — automatic activation, roving tabindex, arrows wrap
// ---------------------------------------------------------------------------

export type Tabs = { readonly items: readonly Item[]; readonly selected: string };

export const tabsKey = (tabs: Tabs, key: string, direction: Direction): Tabs => {
  const step = horizontal(key, direction);
  const target = step !== undefined ? move(tabs.items, tabs.selected, step, true)
    : key === "Home" ? first(tabs.items)
    : key === "End" ? last(tabs.items)
    : undefined;
  return target === undefined ? tabs : { ...tabs, selected: target };
};

// ---------------------------------------------------------------------------
// Menu button — open on ArrowDown/Enter, Escape cancels, focus returns
// ---------------------------------------------------------------------------

export type Menu = { readonly items: readonly Item[]; readonly open: boolean; readonly active: string | undefined; readonly activated: string | undefined };
// Where focus should be after the key: an item, or back on the menu button.
export type MenuFocus = { readonly kind: "item"; readonly id: string } | { readonly kind: "button" } | { readonly kind: "unchanged" };

export const menuOpen = (menu: Menu, from: "first" | "last"): Menu => ({ ...menu, open: true, active: from === "first" ? first(menu.items) : last(menu.items) });

export const menuKey = (menu: Menu, key: string): { readonly menu: Menu; readonly focus: MenuFocus } => {
  const item = (next: Menu): { readonly menu: Menu; readonly focus: MenuFocus } =>
    ({ menu: next, focus: next.active === undefined ? { kind: "unchanged" } : { kind: "item", id: next.active } });
  switch (key) {
    case "ArrowDown": return item({ ...menu, active: move(menu.items, menu.active, 1, true) });
    case "ArrowUp": return item({ ...menu, active: move(menu.items, menu.active, -1, true) });
    case "Home": return item({ ...menu, active: first(menu.items) });
    case "End": return item({ ...menu, active: last(menu.items) });
    case "Escape": return { menu: { ...menu, open: false, active: undefined }, focus: { kind: "button" } };
    case "Enter":
    case " ": {
      const chosen = menu.items.find((candidate) => candidate.id === menu.active && candidate.disabled !== true);
      return chosen === undefined ? { menu, focus: { kind: "unchanged" } } : { menu: { ...menu, open: false, active: undefined, activated: chosen.id }, focus: { kind: "button" } };
    }
    default: return { menu, focus: { kind: "unchanged" } };
  }
};

// ---------------------------------------------------------------------------
// Listbox — aria-activedescendant, arrows clamp, Space/Enter select
// ---------------------------------------------------------------------------

export type Listbox = { readonly items: readonly Item[]; readonly active: string | undefined; readonly selected: string | undefined };

export const listboxKey = (listbox: Listbox, key: string): Listbox => {
  switch (key) {
    case "ArrowDown": return { ...listbox, active: move(listbox.items, listbox.active, 1, false) };
    case "ArrowUp": return { ...listbox, active: move(listbox.items, listbox.active, -1, false) };
    case "Home": return { ...listbox, active: first(listbox.items) };
    case "End": return { ...listbox, active: last(listbox.items) };
    case "Enter":
    case " ": return listbox.items.some((item) => item.id === listbox.active && item.disabled !== true) ? { ...listbox, selected: listbox.active } : listbox;
    default: return listbox;
  }
};

// ---------------------------------------------------------------------------
// Combobox — text filters, ArrowDown opens, Enter picks, Escape closes then clears
// ---------------------------------------------------------------------------

export type Combobox = { readonly options: readonly Item[]; readonly text: string; readonly open: boolean; readonly active: string | undefined; readonly selected: string | undefined };

export const comboMatches = (combo: Combobox): readonly Item[] =>
  combo.options.filter((option) => option.label.toLowerCase().startsWith(combo.text.trim().toLowerCase()));

export const comboInput = (combo: Combobox, text: string): Combobox => {
  const next = { ...combo, text, active: undefined, selected: undefined };
  return { ...next, open: text.trim() !== "" && comboMatches(next).length > 0 };
};

export const comboKey = (combo: Combobox, key: string): Combobox => {
  const matches = comboMatches(combo);
  switch (key) {
    case "ArrowDown": return combo.open ? { ...combo, active: move(matches, combo.active, 1, false) } : { ...combo, open: matches.length > 0, active: first(matches) };
    case "ArrowUp": return combo.open ? { ...combo, active: move(matches, combo.active, -1, false) } : combo;
    case "Enter": {
      const chosen = matches.find((option) => option.id === combo.active && option.disabled !== true);
      return chosen === undefined || !combo.open ? combo : { ...combo, text: chosen.label, selected: chosen.id, open: false, active: undefined };
    }
    // Escape cancels in two steps: first the popup, then the text.
    case "Escape": return combo.open ? { ...combo, open: false, active: undefined } : { ...combo, text: "", selected: undefined };
    default: return combo;
  }
};

// ---------------------------------------------------------------------------
// Tree — visible order, expand/collapse on the horizontal axis
// ---------------------------------------------------------------------------

export type TreeNode = Item & { readonly parent?: string };
export type Tree = { readonly nodes: readonly TreeNode[]; readonly expanded: readonly string[]; readonly active: string };

const childrenOf = (tree: Tree, id: string): readonly TreeNode[] => tree.nodes.filter((node) => node.parent === id);
const ancestorsExpanded = (tree: Tree, node: TreeNode): boolean =>
  node.parent === undefined || (tree.expanded.includes(node.parent) && ancestorsExpanded(tree, tree.nodes.find((candidate) => candidate.id === node.parent) ?? { id: "", label: "" }));

export const visibleNodes = (tree: Tree): readonly TreeNode[] => tree.nodes.filter((node) => ancestorsExpanded(tree, node));
export const levelOf = (tree: Tree, node: TreeNode): number => {
  const parent = tree.nodes.find((candidate) => candidate.id === node.parent);
  return parent === undefined ? 1 : 1 + levelOf(tree, parent);
};
export const hasChildren = (tree: Tree, id: string): boolean => childrenOf(tree, id).length > 0;

export const treeKey = (tree: Tree, key: string, direction: Direction): Tree => {
  const visible = visibleNodes(tree);
  const node = tree.nodes.find((candidate) => candidate.id === tree.active);
  const step = horizontal(key, direction);
  if (step === 1 && node !== undefined && hasChildren(tree, node.id)) {
    return tree.expanded.includes(node.id) ? { ...tree, active: first(childrenOf(tree, node.id)) ?? tree.active } : { ...tree, expanded: [...tree.expanded, node.id] };
  }
  if (step === -1 && node !== undefined) {
    if (tree.expanded.includes(node.id)) return { ...tree, expanded: tree.expanded.filter((id) => id !== node.id) };
    return node.parent === undefined ? tree : { ...tree, active: node.parent };
  }
  switch (key) {
    case "ArrowDown": return { ...tree, active: move(visible, tree.active, 1, false) ?? tree.active };
    case "ArrowUp": return { ...tree, active: move(visible, tree.active, -1, false) ?? tree.active };
    case "Home": return { ...tree, active: first(visible) ?? tree.active };
    case "End": return { ...tree, active: last(visible) ?? tree.active };
    default: return tree;
  }
};

// ---------------------------------------------------------------------------
// Grid — two-dimensional arrows, Home/End in the row, Ctrl+Home/End overall
// ---------------------------------------------------------------------------

export type Grid = { readonly rows: number; readonly columns: number; readonly row: number; readonly column: number };

export const gridKey = (grid: Grid, key: string, ctrl: boolean, direction: Direction): Grid => {
  const clamp = (value: number, size: number): number => Math.min(size - 1, Math.max(0, value));
  const step = horizontal(key, direction);
  if (step !== undefined) return { ...grid, column: clamp(grid.column + step, grid.columns) };
  switch (key) {
    case "ArrowDown": return { ...grid, row: clamp(grid.row + 1, grid.rows) };
    case "ArrowUp": return { ...grid, row: clamp(grid.row - 1, grid.rows) };
    case "Home": return ctrl ? { ...grid, row: 0, column: 0 } : { ...grid, column: 0 };
    case "End": return ctrl ? { ...grid, row: grid.rows - 1, column: grid.columns - 1 } : { ...grid, column: grid.columns - 1 };
    default: return grid;
  }
};

// ---------------------------------------------------------------------------
// Dialog — focus enters on open, Escape cancels and returns focus to the opener
// ---------------------------------------------------------------------------

export type Dialog = { readonly open: boolean; readonly opener: string | undefined; readonly result: string | undefined };

export const dialogOpen = (dialog: Dialog, opener: string): Dialog => ({ ...dialog, open: true, opener, result: undefined });
export const dialogClose = (dialog: Dialog, result: "confirmed" | "cancelled"): Dialog => ({ ...dialog, open: false, result });
