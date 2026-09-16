// Multiple screens in one engine.
//
// There is no router and no per-screen "component". A screen is just a value
// in the authoritative state, and each screen's markup is a `data-if`
// template keyed off the projection. Navigation is an ordinary state
// transition — which means it obeys the same rules as everything else and can
// reject an illegal move.
//
// NOTE: browser history/URL integration is NOT implemented by the kernel
// (docs/ROADMAP.md item 8, deliberately deferred). Back/forward buttons do
// not move between these screens. See docs/08-multi-screen-applications.md.
import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  ViewState,
} from "../../dist/protocol.js";

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

export const SCREENS = ["home", "customers", "settings"] as const;
export type Screen = (typeof SCREENS)[number];

const isScreen = (value: string): value is Screen => (SCREENS as readonly string[]).includes(value);

export type State = {
  readonly screen: Screen;
  // Shared state: set on Settings, displayed on Home, survives navigation.
  readonly displayName: string;
  // Screen-local state: meaningful only while its screen is showing.
  // It still lives here, in the one authoritative place — "screen-local"
  // describes its lifetime, not a second store.
  readonly customerFilter: string;
  readonly settingsDraft: string;
};

export const initialState: State = {
  screen: "home",
  displayName: "Guest",
  customerFilter: "",
  settingsDraft: "Guest",
};

const ALL_CUSTOMERS = [
  { id: "1", name: "Ada Lovelace" },
  { id: "2", name: "Grace Hopper" },
  { id: "3", name: "Katherine Johnson" },
] as const;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  | { readonly kind: "Navigate"; readonly screen: Screen }
  | { readonly kind: "FilterCustomers"; readonly value: string }
  | { readonly kind: "EditDisplayName"; readonly value: string }
  | { readonly kind: "SaveDisplayName" };

export function eventToCommand(event: SemanticEvent): Command {
  switch (event.name) {
    case "navigate": {
      // The nav bar is rendered with data-each, so the clicked item's key
      // arrives as SemanticEvent.key. It is a string from the DOM and is
      // validated here — the engine never trusts an incoming key.
      const target = event.key ?? "";
      if (!isScreen(target)) throw new Error(`Unknown screen: ${target}`);
      return { kind: "Navigate", screen: target };
    }
    case "filterCustomers":
      return { kind: "FilterCustomers", value: event.value ?? "" };
    case "editDisplayName":
      return { kind: "EditDisplayName", value: event.value ?? "" };
    case "saveDisplayName":
      return { kind: "SaveDisplayName" };
    default:
      throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export function transition(state: State, command: Command): State {
  switch (command.kind) {
    case "Navigate": {
      if (command.screen === state.screen) return state;
      return {
        ...state,
        screen: command.screen,
        // Leaving a screen discards its local state. This is a deliberate
        // domain decision written down in one place, not an accident of
        // components unmounting. Preserving it instead would be a one-line
        // change here — and nowhere else.
        customerFilter: "",
        settingsDraft: state.displayName,
      };
    }
    case "FilterCustomers":
      return state.screen === "customers" ? { ...state, customerFilter: command.value } : state;
    case "EditDisplayName":
      return state.screen === "settings" ? { ...state, settingsDraft: command.value } : state;
    case "SaveDisplayName": {
      const name = state.settingsDraft.trim();
      if (state.screen !== "settings" || name === "") return state;
      return { ...state, displayName: name };
    }
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

const LABELS: Readonly<Record<Screen, string>> = {
  home: "Home",
  customers: "Customers",
  settings: "Settings",
};

export function project(state: State): ViewState {
  const filter = state.customerFilter.trim().toLowerCase();
  const visible = filter === ""
    ? ALL_CUSTOMERS
    : ALL_CUSTOMERS.filter((customer) => customer.name.toLowerCase().includes(filter));

  return {
    // One nav item per screen, each carrying its own id as the data-each key.
    // `active` lets CSS style the current tab without the DOM knowing which
    // screen is showing.
    navItems: SCREENS.map((screen) => ({
      id: screen,
      label: LABELS[screen],
      active: screen === state.screen,
    })),

    // One boolean per screen drives one data-if template.
    onHome: state.screen === "home",
    onCustomers: state.screen === "customers",
    onSettings: state.screen === "settings",

    greeting: `Hello, ${state.displayName}.`,
    displayName: state.displayName,

    customerFilter: state.customerFilter,
    // Filtering is a domain decision, so the engine does it and projects the
    // result. The kernel repeats whatever array it is given; it never filters.
    customers: visible.map((customer) => ({ ...customer })),
    noMatches: visible.length === 0,

    settingsDraft: state.settingsDraft,
    saveNameDisabled: state.settingsDraft.trim() === "" || state.settingsDraft.trim() === state.displayName,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createMultiScreenTransport(): EngineTransport {
  let state = initialState;
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (message.kind === "Event") state = transition(state, eventToCommand(message.event));
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}
