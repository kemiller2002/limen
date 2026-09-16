// Multiple screens in one engine, with real URLs.
//
// There is no router and no per-screen "component". A screen is just a value
// in the authoritative state, and each screen's markup is a `data-if`
// template keyed off the projection. Navigation is an ordinary state
// transition — which means it obeys the same rules as everything else and can
// reject an illegal move.
//
// The URL is kept in step with that state, in both directions:
//
//   the user clicks a tab   → Navigate      → the engine pushes a history entry
//   the user presses Back   → RestoreRoute  → the engine does NOT push
//   the page is opened cold → Initialize.location decides the first screen
//
// The kernel owns the mechanism (location, pushState, popstate) and knows
// nothing about what a route means. This file owns the meaning and never
// touches a browser API. See docs/08-multi-screen-applications.md.
import type {
  BrowserToEngineMessage,
  CorrelationId,
  EffectRequest,
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
// Routes
//
// The only place in the application that knows a URL is a URL. Both functions
// are pure string manipulation — no `location`, no `history`, nothing the
// engine is forbidden to touch.
//
// These are hash routes (`#/customers`) rather than paths (`/customers`)
// purely so the example runs from any static file server without rewrite
// rules. The kernel does not care which you use: it resolves whatever string
// the engine hands it and reports whatever the browser ends up showing. Swap
// the two functions below for path routing and nothing else changes — except
// that your server must then serve index.html for unknown paths.
// ---------------------------------------------------------------------------

const ROUTES: Readonly<Record<Screen, string>> = {
  home: "#/",
  customers: "#/customers",
  settings: "#/settings",
};

export const urlFor = (screen: Screen): string => ROUTES[screen];

/** The route portion of a URL, so a full path and a bare route compare equal. */
const hashOf = (url: string): string => {
  const at = url.indexOf("#");
  return at < 0 ? "" : url.slice(at);
};

/**
 * Parse a URL into a route. Pure string work — no `location`, no `history`.
 *
 * `null` means "this URL names no screen". Callers decide what to do with
 * that, and they decide differently: arriving at an unknown URL falls back to
 * Home and corrects the address bar, while *clicking a link* to an unknown
 * URL does nothing at all. Collapsing both into "it's Home" would have made
 * every stray link silently navigate somewhere.
 */
export function routeFor(url: string): Screen | null {
  const hash = url.slice(url.indexOf("#") + 1);
  const name = hash.replace(/^\/+/, "");
  return isScreen(name) ? name : null;
}

/** Arriving at a URL: anything unrecognized is Home. */
export const screenFor = (url: string): Screen => routeFor(url) ?? "home";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  // The user chose to go somewhere: the move deserves a history entry.
  | { readonly kind: "Navigate"; readonly screen: Screen; readonly correlationId: CorrelationId }
  // The browser already moved the user (Back, Forward, an edited hash). The
  // engine catches up; it must NOT push, or Back would land the user right
  // back where they just left. Making that a separate command means the rule
  // is structural rather than a comment someone has to remember.
  //
  // `url` is where the browser actually is, which is not always the canonical
  // URL for the screen it resolves to — someone can type `#/nonsense`.
  | { readonly kind: "RestoreRoute"; readonly screen: Screen; readonly url: string; readonly correlationId: CorrelationId }
  // The user asked the browser to move within its own history. The engine does
  // not track where that goes — there is one history, the browser's, and this
  // asks it to move. Where it lands arrives afterwards as RestoreRoute.
  | { readonly kind: "GoBack"; readonly correlationId: CorrelationId }
  | { readonly kind: "GoForward"; readonly correlationId: CorrelationId }
  // A link the kernel took from the browser. `screen` is null when the href
  // names no route, and then nothing happens at all.
  | { readonly kind: "FollowLink"; readonly screen: Screen | null; readonly correlationId: CorrelationId }
  | { readonly kind: "FilterCustomers"; readonly value: string }
  | { readonly kind: "EditDisplayName"; readonly value: string }
  | { readonly kind: "SaveDisplayName" };

export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  switch (event.name) {
    case "navigate": {
      // The nav bar is rendered with data-each, so the clicked item's key
      // arrives as SemanticEvent.key. It is a string from the DOM and is
      // validated here — the engine never trusts an incoming key.
      const target = event.key ?? "";
      if (!isScreen(target)) throw new Error(`Unknown screen: ${target}`);
      return { kind: "Navigate", screen: target, correlationId };
    }
    // The name the kernel was configured with in main.ts. It is this
    // application's word, not the kernel's — the kernel dispatches whatever
    // name it was given, carrying the new location in `value`.
    case "urlChanged": {
      const url = event.value ?? "";
      return { kind: "RestoreRoute", screen: screenFor(url), url, correlationId };
    }
    // Also configured in main.ts. The kernel has decided the browser had
    // nothing better to do with this click; it has NOT decided the href means
    // anything. That decision is here.
    case "linkActivated":
      return { kind: "FollowLink", screen: routeFor(event.value ?? ""), correlationId };
    case "goBack":
      return { kind: "GoBack", correlationId };
    case "goForward":
      return { kind: "GoForward", correlationId };
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

export type TransitionResult = {
  readonly state: State;
  readonly effects: readonly EffectRequest[];
};

/** Arriving on a screen, wherever the decision came from. */
function arriveAt(state: State, screen: Screen): State {
  if (screen === state.screen) return state;
  return {
    ...state,
    screen,
    // Leaving a screen discards its local state. This is a deliberate
    // domain decision written down in one place, not an accident of
    // components unmounting. Preserving it instead would be a one-line
    // change here — and nowhere else.
    customerFilter: "",
    settingsDraft: state.displayName,
  };
}

/**
 * Arrive at a screen and make the address bar agree, if it does not already.
 *
 * The correction is always a `replace`: the user is already here, so it is not
 * a step to go Back from. `replaceState` does not fire `popstate`, so this
 * cannot feed itself.
 */
/**
 * What arriving on a screen costs, besides the state change.
 *
 * Focus moves on EVERY route change, including Back and Forward. Leaving a
 * screen destroys its DOM, so focus would otherwise fall to `<body>` and a
 * screen-reader user would get no indication that anything happened. Focusing
 * the new heading announces it, which is the whole point.
 *
 * Scroll is reset only when the USER navigated. `pushState` deliberately does
 * not scroll, so a new screen would otherwise open halfway down; but browsers
 * already restore scroll for history traversal, and redoing it by hand would
 * throw away the position the user came back to see.
 */
type Arrival = "initial" | "user" | "history";

function arrivalEffects(correlationId: CorrelationId, cause: Arrival): readonly EffectRequest[] {
  // A page that has only just loaded must not have focus yanked out of it —
  // including a deep link, which reaches its screen by "moving" there from the
  // initial state. The user has not navigated yet, and moving focus here would
  // jump them past the skip link and the header they were one Tab from.
  if (cause === "initial") return [];

  const focus = { kind: "Document", correlationId, operation: "focusTarget" } as const;
  return cause === "user"
    ? [{ kind: "Document", correlationId, operation: "scrollToTop" }, focus]
    : [focus];
}

function settle(state: State, screen: Screen, currentUrl: string, correlationId: CorrelationId, cause: Arrival): TransitionResult {
  const next = arriveAt(state, screen);
  const moved = next.screen !== state.screen;
  const correction: readonly EffectRequest[] = hashOf(currentUrl) === urlFor(screen)
    ? []
    : [{ kind: "Navigate", correlationId, operation: "replace", url: urlFor(screen) }];
  return { state: next, effects: [...correction, ...(moved ? arrivalEffects(correlationId, cause) : [])] };
}

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "Navigate": {
      // Navigating to the screen already showing is not an illegal move, but
      // it is not a move: no state change and, just as importantly, no
      // history entry. Otherwise clicking the current tab five times would
      // cost five presses of Back to escape.
      if (command.screen === state.screen) return { state, effects: [] };
      return {
        state: arriveAt(state, command.screen),
        effects: [
          { kind: "Navigate", correlationId: command.correlationId, operation: "push", url: urlFor(command.screen) },
          ...arrivalEffects(command.correlationId, "user"),
        ],
      };
    }
    case "FollowLink":
      // An href naming no route is not an error and not a navigation. The
      // link simply does nothing, which is the right answer for a dead link.
      return command.screen === null
        ? { state, effects: [] }
        : transition(state, { kind: "Navigate", screen: command.screen, correlationId: command.correlationId });

    case "GoBack":
      return { state, effects: [{ kind: "Navigate", correlationId: command.correlationId, operation: "back" }] };

    case "GoForward":
      return { state, effects: [{ kind: "Navigate", correlationId: command.correlationId, operation: "forward" }] };

    case "RestoreRoute":
      // Never a push — the browser is already here, it is what told us. Usually
      // no effect at all; the exception is a URL that names no screen, which
      // resolves to Home and gets corrected so the address bar cannot go on
      // claiming something the application is not showing.
      return settle(state, command.screen, command.url, command.correlationId, "history");
    case "FilterCustomers":
      return { state: state.screen === "customers" ? { ...state, customerFilter: command.value } : state, effects: [] };
    case "EditDisplayName":
      return { state: state.screen === "settings" ? { ...state, settingsDraft: command.value } : state, effects: [] };
    case "SaveDisplayName": {
      const name = state.settingsDraft.trim();
      if (state.screen !== "settings" || name === "") return { state, effects: [] };
      return { state: { ...state, displayName: name }, effects: [] };
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

// The page title is a *function of state*, so it is projected like anything
// else and bound with `<title data-text="pageTitle">`. It is not an effect:
// nothing has to remember to fire it, and it cannot drift out of step with the
// screen it names.
const TITLES: Readonly<Record<Screen, string>> = {
  home: "Home — Multi-screen example",
  customers: "Customers — Multi-screen example",
  settings: "Settings — Multi-screen example",
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

    pageTitle: TITLES[state.screen],
    screenHeading: LABELS[state.screen],

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
  let sequence = 0;
  const nextCorrelationId = (): CorrelationId => `nav-${++sequence}` as CorrelationId;

  const respond = (result: TransitionResult): EngineToBrowserMessage => {
    state = result.state;
    return { view: project(state), effects: result.effects, cancellations: [] };
  };

  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      switch (message.kind) {
        case "Initialize": {
          // No location means the host did not wire navigation (see
          // BrowserKernel's `navigation` argument). The application still
          // works — it just starts on Home and stays within one page load.
          if (message.location === undefined) return { view: project(state), effects: [], cancellations: [] };

          // Opening the page with no hash at all, or with one naming no
          // screen, should still leave the user on a URL that round-trips.
          // Same rule as a history move, so: same function.
          const location = message.location;
          return respond(settle(state, screenFor(location), location, nextCorrelationId(), "initial"));
        }
        case "Event":
          return respond(transition(state, eventToCommand(message.event, nextCorrelationId())));
        case "EffectResult": {
          if (message.result.kind !== "NavigationResult" && message.result.kind !== "DocumentResult") {
            throw new Error(`This engine never requests a ${message.result.kind} effect.`);
          }
          // A refused navigation leaves the screen where it is. The address
          // bar and the application then disagree, which is worth knowing
          // about — but this example has no error surface to show it in, and
          // inventing one here would obscure what it is teaching. A real
          // application would project the disagreement; see
          // docs/08-multi-screen-applications.md.
          return { view: project(state), effects: [], cancellations: [] };
        }
      }
    },
  };
}
