// Routing, with the browser's history as a capability rather than an
// authority. Three rules carry the whole example:
//
//   1. A Route is a type, not a string comparison scattered through the code.
//   2. The engine decides what a URL *means*; the kernel only pushes and pops.
//   3. A move the engine asked for and a move the browser made on its own are
//      different facts, and are handled by different code paths.
//
// Rule 3 is the one that bites. Pushing a new URL in response to
// LocationChanged is the classic routing bug: Back fires popstate, the engine
// pushes the old URL back on, and the user is trapped on the page.
import type {
  BrowserLocation,
  BrowserToEngineMessage,
  CorrelationId,
  EffectRequest,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  ViewState,
} from "../../dist/protocol.js";

// ---------------------------------------------------------------------------
// Routes — a closed set, including the failure
// ---------------------------------------------------------------------------

// "NotFound" is a route, not an error. A URL nobody recognises is an ordinary
// thing for a user to arrive at, and it has a screen like any other.
export type Route =
  | { readonly kind: "Home" }
  | { readonly kind: "Invoices" }
  | { readonly kind: "Invoice"; readonly id: string }
  | { readonly kind: "NotFound"; readonly raw: string };

export type Invoice = { readonly id: string; readonly customer: string; readonly total: string };

export const invoices: readonly Invoice[] = [
  { id: "1001", customer: "Ridgeline Supply", total: "$4,120.00" },
  { id: "1002", customer: "Harbor Analytics", total: "$980.50" },
  { id: "1003", customer: "Pell & Sons", total: "$12,300.00" },
];

// Routes live in the query string (`?route=/invoices/1002`), not the path.
// That is a deployment decision, not an architectural one: query routing loads
// correctly from any static host — including GitHub Pages — with no rewrite
// rule, because the server only ever sees this one file. Path routing gives
// prettier URLs and needs the server to serve index.html for unknown paths.
// Everything below except these two functions is identical either way.
export const ROUTE_PARAM = "route=";

export function parseRoute(location: BrowserLocation): Route {
  const raw = readRouteParam(location.query);
  if (raw === "" || raw === "/") return { kind: "Home" };
  if (raw === "/invoices") return { kind: "Invoices" };
  const invoice = /^\/invoices\/([A-Za-z0-9-]+)$/.exec(raw);
  // A syntactically valid URL naming a row that does not exist is still
  // NotFound. The alternative — an "Invoice" screen with nothing in it — is a
  // state the projection would have to apologise for later.
  if (invoice?.[1] !== undefined && invoices.some((candidate) => candidate.id === invoice[1])) {
    return { kind: "Invoice", id: invoice[1] };
  }
  return { kind: "NotFound", raw };
}

const readRouteParam = (query: string): string => {
  const entry = query.replace(/^\?/, "").split("&").find((pair) => pair.startsWith(ROUTE_PARAM));
  return entry === undefined ? "" : decodeURIComponent(entry.slice(ROUTE_PARAM.length));
};

// The inverse of parseRoute. Keeping both here, next to each other, is what
// makes "does every route round-trip?" a question a test can answer — see
// test/examples.test.ts.
export function routeToPath(route: Route): string {
  switch (route.kind) {
    case "Home": return "/";
    case "Invoices": return "/invoices";
    case "Invoice": return `/invoices/${route.id}`;
    case "NotFound": return route.raw;
  }
}

// `base` is the page's own path, captured from Initialize. Without it the
// example would push URLs at the site root and break the moment it is served
// from a subdirectory — which is how every GitHub Pages deployment serves it.
export const routeToUrl = (base: string, route: Route): string =>
  route.kind === "Home" ? base : `${base}?${ROUTE_PARAM}${encodeURIComponent(routeToPath(route))}`;

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

export type State = {
  readonly route: Route;
  readonly base: string;
  // Set when the kernel could not perform a navigation the engine asked for.
  // The screen still changed — the engine's route is authoritative — but the
  // address bar now disagrees with it, and pretending otherwise would leave
  // the user with a URL that reopens the wrong screen.
  readonly urlOutOfSync: boolean;
};

export const initialState: State = { route: { kind: "Home" }, base: "/", urlOutOfSync: false };

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  // The application decided to go somewhere. Changes state *and* asks the
  // browser to catch up.
  | { readonly kind: "Navigate"; readonly route: Route; readonly correlationId: CorrelationId }
  | { readonly kind: "GoBack"; readonly correlationId: CorrelationId }
  // The browser went somewhere on its own (Back, Forward). Changes state and
  // asks for nothing: the address bar is already correct.
  | { readonly kind: "AdoptLocation"; readonly location: BrowserLocation }
  | { readonly kind: "RecordNavigation"; readonly failed: boolean };

export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  switch (event.name) {
    case "goHome": return { kind: "Navigate", route: { kind: "Home" }, correlationId };
    case "goInvoices": return { kind: "Navigate", route: { kind: "Invoices" }, correlationId };
    // The row's data-key is the invoice id; the DOM carries an opaque string
    // and the engine decides it names an invoice.
    case "openInvoice":
      if (event.key === undefined) throw new Error("openInvoice requires an item key");
      return { kind: "Navigate", route: { kind: "Invoice", id: event.key }, correlationId };
    case "goBack": return { kind: "GoBack", correlationId };
    default: throw new Error(`Unrecognized event: ${event.name}`);
  }
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type TransitionResult = {
  readonly state: State;
  readonly effects: readonly EffectRequest[];
  readonly accepted: boolean;
};

const stay = (state: State): TransitionResult => ({ state, effects: [], accepted: false });
const go = (state: State, effects: readonly EffectRequest[] = []): TransitionResult =>
  ({ state, effects, accepted: true });

const sameRoute = (a: Route, b: Route): boolean => routeToPath(a) === routeToPath(b);

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "Navigate": {
      // Navigating to where you already are would push a duplicate history
      // entry, so Back would appear to do nothing once per redundant click.
      if (sameRoute(state.route, command.route)) return stay(state);
      return go(
        { ...state, route: command.route, urlOutOfSync: false },
        [{
          kind: "Navigation",
          correlationId: command.correlationId,
          operation: "push",
          url: routeToUrl(state.base, command.route),
        }],
      );
    }

    case "GoBack":
      // Asks the browser to move. The engine does NOT change its route here:
      // whether there is anywhere to go back to is the browser's knowledge,
      // not the engine's, and the answer arrives as LocationChanged — or
      // never, which is also a correct outcome.
      return go(state, [{ kind: "Navigation", correlationId: command.correlationId, operation: "back" }]);

    case "AdoptLocation": {
      const route = parseRoute(command.location);
      // No effect. The browser has already moved; asking it to move again is
      // the infinite loop this file's header warns about.
      return go({ ...state, route, urlOutOfSync: false });
    }

    case "RecordNavigation":
      return command.failed ? go({ ...state, urlOutOfSync: true }) : stay(state);
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

function invoiceOf(state: State): Invoice | undefined {
  const route = state.route;
  if (route.kind !== "Invoice") return undefined;
  return invoices.find((candidate) => candidate.id === route.id);
}

export function project(state: State): ViewState {
  const current = invoiceOf(state);
  return {
    onHome: state.route.kind === "Home",
    onInvoices: state.route.kind === "Invoices",
    onInvoice: state.route.kind === "Invoice",
    onNotFound: state.route.kind === "NotFound",
    // The address bar as the engine believes it should read. Projected so the
    // example can show it; a real application would not need to.
    currentUrl: routeToUrl(state.base, state.route),
    unknownPath: state.route.kind === "NotFound" ? state.route.raw : "",
    invoiceId: current?.id ?? "",
    invoiceCustomer: current?.customer ?? "",
    invoiceTotal: current?.total ?? "",
    urlOutOfSync: state.urlOutOfSync,
    invoices: invoices.map((invoice) => ({ id: invoice.id, customer: invoice.customer, total: invoice.total })),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export function createRoutingTransport(): EngineTransport {
  let state: State = initialState;
  let sequence = 0;
  const nextCorrelationId = (): CorrelationId => `nav-${++sequence}` as CorrelationId;

  const respond = (result: TransitionResult): EngineToBrowserMessage =>
    ({ view: project((state = result.state)), effects: result.effects, cancellations: [] });

  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      switch (message.kind) {
        case "Initialize":
          // The first screen comes from the address bar, not from a default
          // that is then corrected. A user who opened a bookmark to
          // ?route=/invoices/1002 never sees Home flash first.
          state = {
            route: parseRoute(message.location),
            base: message.location.path,
            urlOutOfSync: false,
          };
          return { view: project(state), effects: [], cancellations: [] };

        case "Event":
          return respond(transition(state, eventToCommand(message.event, nextCorrelationId())));

        case "LocationChanged":
          // Back, Forward, or any other browser-originated move.
          return respond(transition(state, { kind: "AdoptLocation", location: message.location }));

        case "EffectResult": {
          if (message.result.kind !== "NavigationResult") {
            throw new Error(`Unexpected ${message.result.kind}: this engine requests only Navigation effects.`);
          }
          // "Dispatched" is back/forward having been *asked for*; there is
          // nothing to record until the browser actually moves and sends
          // LocationChanged. Only an outright Failure changes state.
          return respond(transition(state, {
            kind: "RecordNavigation",
            failed: message.result.outcome.kind === "Failure",
          }));
        }
      }
    },
  };
}
