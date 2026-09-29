// The engine for the accessible interaction patterns example
// (kemiller2002/limen#31). It owns every widget's state; the browser reports
// keys through the events capability (limen.events) and clicks through plain
// data-event; the engine answers with a projection — including every ARIA
// state — and, where focus must move, a request to the focus capability
// (limen.focus). Nothing in the kernel or in either capability knows what a
// tab, a menu or a tree is.

import type { BrowserToEngineMessage, CapabilityId, CorrelationId, EffectRequest, EngineToBrowserMessage, EngineTransport, ViewItem, ViewState } from "../../dist/protocol.js";
import { CORE_CONTRACT_IDENTITY } from "../../dist/protocol.js";
import { CAPABILITY_OFFER as FOCUS } from "../../dist/capabilities/focus/generated/focus.js";
import type { FocusRequest } from "../../dist/capabilities/focus/generated/focus.js";
import { CAPABILITY_OFFER as EVENTS } from "../../dist/capabilities/events/generated/events.js";
import { decodeRichEvent } from "../../dist/capabilities/events/generated/events.codec.js";
import {
  comboInput, comboKey, comboMatches, dialogClose, dialogOpen, gridKey, hasChildren, levelOf, listboxKey, menuKey, menuOpen, tabsKey, treeKey, visibleNodes,
  type Combobox, type Dialog, type Direction, type Grid, type Listbox, type Menu, type Tabs, type Tree,
} from "./patterns.js";

export type State = {
  readonly tabs: Tabs;
  readonly menu: Menu;
  readonly listbox: Listbox;
  readonly combo: Combobox;
  readonly tree: Tree;
  readonly grid: Grid;
  readonly dialog: Dialog;
};

export const initialState: State = {
  tabs: { items: [{ id: "overview", label: "Overview" }, { id: "billing", label: "Billing", disabled: true }, { id: "history", label: "History" }], selected: "overview" },
  menu: { items: [{ id: "copy", label: "Copy" }, { id: "paste", label: "Paste", disabled: true }, { id: "delete", label: "Delete" }], open: false, active: undefined, activated: undefined },
  listbox: { items: [{ id: "red", label: "Red" }, { id: "green", label: "Green", disabled: true }, { id: "blue", label: "Blue" }, { id: "yellow", label: "Yellow" }], active: undefined, selected: undefined },
  combo: { options: ["Denmark", "Dominica", "Dominican Republic", "Egypt", "Estonia"].map((label) => ({ id: label.toLowerCase().replaceAll(" ", "-"), label })), text: "", open: false, active: undefined, selected: undefined },
  tree: {
    nodes: [
      { id: "fruit", label: "Fruit" }, { id: "apple", label: "Apple", parent: "fruit" }, { id: "banana", label: "Banana", parent: "fruit" },
      { id: "vegetables", label: "Vegetables" }, { id: "carrot", label: "Carrot", parent: "vegetables" }, { id: "leek", label: "Leek", parent: "vegetables" },
    ],
    expanded: [],
    active: "fruit",
  },
  grid: { rows: 3, columns: 3, row: 0, column: 0 },
  dialog: { open: false, opener: undefined, result: undefined },
};

// ---------------------------------------------------------------------------
// Projection: every ARIA state is a projected value, never DOM-derived
// ---------------------------------------------------------------------------

const optionId = (prefix: string, id: string | undefined): string => (id === undefined ? "" : `${prefix}-${id}`);

export const project = (state: State): ViewState => {
  const { tabs, menu, listbox, combo, tree, grid, dialog } = state;
  const visible = visibleNodes(tree);
  const cells = Object.fromEntries(Array.from({ length: grid.rows * grid.columns }, (_, index) => {
    const row = Math.floor(index / grid.columns);
    const column = index % grid.columns;
    return [`cell_${row}_${column}`, row === grid.row && column === grid.column ? 0 : -1];
  }));
  return {
    tabs: tabs.items.map((item): ViewItem => ({ id: item.id, label: item.label, selected: item.id === tabs.selected, tabindex: item.id === tabs.selected ? 0 : -1, disabled: item.disabled === true })),
    tabPanel: `${tabs.items.find((item) => item.id === tabs.selected)?.label ?? ""} panel`,
    menuOpen: menu.open,
    menuItems: menu.items.map((item): ViewItem => ({ id: item.id, label: item.label, disabled: item.disabled === true })),
    menuResult: menu.activated === undefined ? "Nothing chosen" : `Chose ${menu.activated}`,
    options: listbox.items.map((item): ViewItem => ({ id: item.id, domId: optionId("option", item.id), label: item.label, selected: item.id === listbox.selected, disabled: item.disabled === true, active: item.id === listbox.active })),
    listboxActive: optionId("option", listbox.active),
    listboxResult: listbox.selected === undefined ? "No colour" : `Colour: ${listbox.selected}`,
    comboText: combo.text,
    comboOpen: combo.open,
    comboOptions: comboMatches(combo).map((item): ViewItem => ({ id: item.id, domId: optionId("country", item.id), label: item.label, active: item.id === combo.active })),
    comboActive: optionId("country", combo.active),
    comboResult: combo.selected === undefined ? "No country" : `Country: ${combo.selected}`,
    treeItems: visible.map((node): ViewItem => ({
      id: node.id, label: node.label, level: levelOf(tree, node), tabindex: node.id === tree.active ? 0 : -1,
      isParent: hasChildren(tree, node.id), isLeaf: !hasChildren(tree, node.id), expanded: tree.expanded.includes(node.id),
    })),
    ...cells,
    dialogOpen: dialog.open,
    backgroundInert: dialog.open,
    dialogResult: dialog.result ?? "Dialog not used",
  };
};

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

type Step = { readonly state: State; readonly focus?: FocusRequest };

const focusOn = (name: string, key?: string): FocusRequest => ({ operation: "focus", target: { name, ...(key !== undefined ? { key } : {}) }, preventScroll: false });

// A key the events capability reported: the declared listener's name, the key,
// the modifiers and the element's direction — mechanical facts only.
const onKey = (state: State, listener: string, key: string, ctrl: boolean, direction: Direction): Step => {
  switch (listener) {
    case "tabsKey": {
      const tabs = tabsKey(state.tabs, key, direction);
      return { state: { ...state, tabs }, focus: focusOn("tab", tabs.selected) };
    }
    case "menuButtonKey": {
      const menu = menuOpen(state.menu, key === "ArrowUp" ? "last" : "first");
      return { state: { ...state, menu }, ...(menu.active !== undefined ? { focus: focusOn("menuitem", menu.active) } : {}) };
    }
    case "menuKey": {
      const { menu, focus } = menuKey(state.menu, key);
      const request = focus.kind === "item" ? focusOn("menuitem", focus.id) : focus.kind === "button" ? focusOn("menuButton") : undefined;
      return { state: { ...state, menu }, ...(request !== undefined ? { focus: request } : {}) };
    }
    case "listboxKey": return { state: { ...state, listbox: listboxKey(state.listbox, key) } };
    case "comboKey": return { state: { ...state, combo: comboKey(state.combo, key) } };
    case "treeKey": {
      const tree = treeKey(state.tree, key, direction);
      return { state: { ...state, tree }, focus: focusOn("treeitem", tree.active) };
    }
    case "gridKey": {
      const grid = gridKey(state.grid, key, ctrl, direction);
      return { state: { ...state, grid }, focus: focusOn("cell", `${grid.row}-${grid.column}`) };
    }
    case "dialogKey":
      return key === "Escape" && state.dialog.open ? { state: { ...state, dialog: dialogClose(state.dialog, "cancelled") }, focus: focusOn("dialogOpener") } : { state };
    default: return { state };
  }
};

const onEvent = (state: State, name: string, key: string | undefined, value: string | undefined): Step => {
  switch (name) {
    case "selectTab": {
      const target = state.tabs.items.find((item) => item.id === key && item.disabled !== true);
      return target === undefined ? { state } : { state: { ...state, tabs: { ...state.tabs, selected: target.id } } };
    }
    case "toggleMenu": {
      const menu = state.menu.open ? { ...state.menu, open: false, active: undefined } : menuOpen(state.menu, "first");
      return { state: { ...state, menu }, ...(menu.active !== undefined ? { focus: focusOn("menuitem", menu.active) } : {}) };
    }
    case "activateItem": {
      const item = state.menu.items.find((candidate) => candidate.id === key && candidate.disabled !== true);
      return item === undefined ? { state } : { state: { ...state, menu: { ...state.menu, open: false, active: undefined, activated: item.id } }, focus: focusOn("menuButton") };
    }
    case "pickOption": {
      const item = state.listbox.items.find((candidate) => candidate.id === key && candidate.disabled !== true);
      return item === undefined ? { state } : { state: { ...state, listbox: { ...state.listbox, active: item.id, selected: item.id } } };
    }
    case "comboText": return { state: { ...state, combo: comboInput(state.combo, value ?? "") } };
    case "openDialog": return { state: { ...state, dialog: dialogOpen(state.dialog, "dialogOpener") }, focus: { operation: "focusFirst", scope: { name: "dialog" } } };
    case "confirmDialog": return { state: { ...state, dialog: dialogClose(state.dialog, "confirmed") }, focus: focusOn("dialogOpener") };
    case "cancelDialog": return { state: { ...state, dialog: dialogClose(state.dialog, "cancelled") }, focus: focusOn("dialogOpener") };
    default: return { state };
  }
};

// A pack's generated offer, with its id as the protocol's CapabilityId brand.
const offer = (capability: { readonly id: string; readonly version: number; readonly fingerprint: string }) =>
  ({ id: capability.id as CapabilityId, version: capability.version, fingerprint: capability.fingerprint });

export const createPatternsTransport = (): EngineTransport => {
  // The engine's one state cell; every change is a pure transition above.
  const cell = { state: initialState, effects: 0 };
  const respond = (step: Step): EngineToBrowserMessage => {
    cell.state = step.state;
    const effects: EffectRequest[] = step.focus === undefined ? [] : [{
      kind: "Capability", correlationId: `focus-${(cell.effects += 1)}` as CorrelationId, capability: offer(FOCUS).id, version: FOCUS.version, request: step.focus,
    }];
    return { view: project(cell.state), effects, cancellations: [] };
  };
  return {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> => {
      switch (message.kind) {
        case "Initialize":
          return {
            ...respond({ state: cell.state }),
            handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer(FOCUS), offer(EVENTS)] },
          };
        case "Event":
          return respond(onEvent(cell.state, message.event.name, message.event.key, message.event.value));
        case "CapabilityFact": {
          const fact = decodeRichEvent(message.fact);
          if (!fact.ok || fact.value.keyboard === undefined) return respond({ state: cell.state });
          return respond(onKey(cell.state, fact.value.name, fact.value.keyboard.key, fact.value.modifiers?.ctrl === true, fact.value.direction ?? "ltr"));
        }
        case "EffectResult":
        case "LocationChanged":
          return respond({ state: cell.state });
      }
    },
  };
};
