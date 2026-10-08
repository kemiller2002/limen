// Routing, with the browser's history as a capability rather than an
// authority, on @echelon-foundry/limen/routing in hash mode (LCP-111).
// Three rules carry the whole example:
//
//   1. A Route is a type, not a string comparison scattered through the code.
//      The route table is a value; a typed codec maps it onto Route.
//   2. The engine decides what a URL *means*; the kernel only pushes and pops.
//   3. A move the engine asked for and a move the browser made on its own are
//      different facts, and are handled by different code paths: navigate
//      pushes, adopt never does.
//
// Rule 3 is the one that bites. Pushing a new URL in response to
// LocationChanged is the classic routing bug: Back fires popstate, the engine
// pushes the old URL back on, and the user is trapped on the page.
import type {
  BrowserLocation,
  BrowserToEngineMessage,
  ClipboardOutcome,
  CorrelationId,
  EffectRequest,
  EngineToBrowserMessage,
  EngineTransport,
  SemanticEvent,
  ViewState,
} from "../../dist/protocol.js";
import {
  createRouteCodec,
  defineRoutes,
  hrefFor,
  initialRouterState,
  locationFromBrowser,
  shareLink,
  type NavigationEffect,
  type PageLocation,
  type Result,
  type RouteError,
  type RouteMatch,
  type RouterState,
  type RouteTable,
  type Target,
} from "../../dist/routing/index.js";

// ---------------------------------------------------------------------------
// Routes — a closed set, including the failures
// ---------------------------------------------------------------------------

// "NotFound" is a route, not an exception. A URL nobody recognises is an
// ordinary thing for a user to arrive at, and it has a screen like any other.
// So is a link whose identifier is not a number ("InvalidLink").
export type Route =
  | { readonly kind: "Home" }
  | { readonly kind: "Invoices" }
  | { readonly kind: "Invoice"; readonly id: string }
  | { readonly kind: "NotFound"; readonly raw: string }
  | { readonly kind: "InvalidLink"; readonly raw: string; readonly parameter: string };

export type Invoice = { readonly id: string; readonly customer: string; readonly total: string };

export const invoices: readonly Invoice[] = [
  { id: "1001", customer: "Ridgeline Supply", total: "$4,120.00" },
  { id: "1002", customer: "Harbor Analytics", total: "$980.50" },
  { id: "1003", customer: "Pell & Sons", total: "$12,300.00" },
];

// The URL space as a value. Hash mode puts the routed location in the
// fragment (#/invoices/1002), so any static host — GitHub Pages included —
// serves this one file for every deep link, a reload never 404s, and no
// <base href> or knowledge of the site's sub-path is needed.
const defined = defineRoutes({
  routes: [
    { name: "home", path: "" },
    { name: "invoices", path: "invoices", children: [{ name: "list", path: "" }, { name: "invoice", path: "{id:int}" }] },
    { name: "notFound", path: "{*rest}" },
  ],
  roles: { home: "home", notFound: "notFound" },
});
if (!defined.ok) throw new Error(`the route table is wrong: ${JSON.stringify(defined.error)}`);
export const table: RouteTable = defined.value;

const toTarget = (route: Route): Target => {
  switch (route.kind) {
    case "Home": return { route: "home" };
    case "Invoices": return { route: "invoices.list" };
    case "Invoice": return { route: "invoices.invoice", params: { id: route.id } };
    case "NotFound":
    case "InvalidLink": return { route: "notFound", params: { rest: route.raw } };
  }
};

// A syntactically valid URL naming a row that does not exist is still not
// found. The alternative — an "Invoice" screen with nothing in it — is a state
// the projection would have to apologise for later.
const ofMatch = (matched: RouteMatch): Result<Route, string> => {
  switch (matched.route) {
    case "home": return { ok: true, value: { kind: "Home" } };
    case "invoices.list": return { ok: true, value: { kind: "Invoices" } };
    case "invoices.invoice": {
      const id = String(matched.chain[1]?.params["id"] ?? "");
      return invoices.some((invoice) => invoice.id === id) ? { ok: true, value: { kind: "Invoice", id } } : { ok: false, error: "no such invoice" };
    }
    default: return { ok: false, error: `unmapped ${matched.route}` };
  }
};

const codec = createRouteCodec(table, { toTarget, ofMatch });

// Every route error has its own screen; none is a blank page or another
// route's view (LCP-098).
const ofError = (raw: string, error: RouteError): Route => {
  switch (error.kind) {
    case "Invalid": return { kind: "InvalidLink", raw, parameter: error.parameter };
    case "Malformed": return { kind: "InvalidLink", raw, parameter: error.part };
    case "NotFound":
    case "NotPermitted":
    case "RedirectLoop":
    case "Unmapped": return { kind: "NotFound", raw };
  }
};

const pageOf = (location: BrowserLocation): PageLocation =>
  ({ origin: location.origin, path: location.path, query: location.query, hash: location.hash });

/** The routed location of the page ("/invoices/1002"), from the fragment. */
export const routedLocation = (location: BrowserLocation): string => locationFromBrowser(pageOf(location));

export function parseRoute(location: BrowserLocation): Route {
  const raw = routedLocation(location);
  const parsed = codec.parse(raw);
  return parsed.ok ? parsed.value : ofError(raw, parsed.error);
}

/** The canonical routed location of a route. It and parseRoute are inverses — see test/examples.test.ts. */
export function routeToPath(route: Route): string {
  if (route.kind === "NotFound" || route.kind === "InvalidLink") return route.raw;
  const formatted = codec.format(route);
  return formatted.ok ? formatted.value : "/";
}

/** The relative URL to push, and to render as a link: "#/invoices/1002". */
export const routeToUrl = (route: Route): string => hrefFor(routeToPath(route));

// The absolute link to a screen: the page's origin, its own path and query
// (whatever sub-path the host serves it under), and the routed fragment. The
// origin comes from Initialize.location, which is the only reason an engine
// can build one at all — see BrowserLocation in ../../src/protocol.ts.
export const shareUrl = (page: PageLocation, route: Route): string => shareLink(page, routeToPath(route));

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

// Copying the link to the current screen is the one place this example uses two
// capabilities at once, and it is here deliberately: composing a shareable URL
// (Navigation) and putting it on the clipboard (Clipboard) is the main reason
// either capability exists, and demonstrating them only separately leaves the
// combination — including where the origin comes from — to guesswork.
export type CopyState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Copying"; readonly correlationId: CorrelationId }
  | { readonly kind: "Copied" }
  | { readonly kind: "CopyFailed"; readonly reason: "denied" | "unavailable" | "unknown" };

export type State = {
  readonly route: Route;
  // The location the engine last adopted, pushed or replaced: the library's
  // navigation state, so a move to where you already are is no move.
  readonly router: RouterState;
  // The page's own URL, captured at Initialize: the origin, and the document
  // path and query that a shared link keeps.
  readonly page: PageLocation;
  readonly copy: CopyState;
  // Set when the kernel could not perform a navigation the engine asked for.
  // The screen still changed — the engine's route is authoritative — but the
  // address bar now disagrees with it, and pretending otherwise would leave
  // the user with a URL that reopens the wrong screen.
  readonly urlOutOfSync: boolean;
};

export const initialState: State = {
  route: { kind: "Home" },
  router: { current: "/" },
  page: { origin: "", path: "/", query: "", hash: "" },
  copy: { kind: "Idle" },
  urlOutOfSync: false,
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type Command =
  // The application decided to go somewhere. Changes state *and* asks the
  // browser to catch up.
  | { readonly kind: "Navigate"; readonly route: Route; readonly correlationId: CorrelationId }
  | { readonly kind: "GoBack"; readonly correlationId: CorrelationId }
  // The browser went somewhere on its own (a deep link, Back, Forward, a
  // followed link). Changes state and never pushes: at most a replace that
  // corrects the address bar to the canonical form.
  | { readonly kind: "AdoptLocation"; readonly location: BrowserLocation; readonly correlationId: CorrelationId }
  | { readonly kind: "RecordNavigation"; readonly failed: boolean }
  | { readonly kind: "CopyLink"; readonly correlationId: CorrelationId }
  | { readonly kind: "RecordCopy"; readonly correlationId: CorrelationId; readonly outcome: ClipboardOutcome };

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
    case "copyLink": return { kind: "CopyLink", correlationId };
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

const navigation = (effect: NavigationEffect, correlationId: CorrelationId): EffectRequest =>
  ({ kind: "Navigation", correlationId, operation: effect.kind === "Push" ? "push" : "replace", url: hrefFor(effect.location) });

export function transition(state: State, command: Command): TransitionResult {
  switch (command.kind) {
    case "Navigate": {
      // Navigating to where you already are would push a duplicate history
      // entry, so Back would appear to do nothing once per redundant click.
      // The library answers no effect for it.
      const moved = codec.navigate(state.router, command.route);
      if (!moved.ok || moved.value.effect === null) return stay(state);
      return go(
        { ...state, route: command.route, router: moved.value.state, urlOutOfSync: false },
        [navigation(moved.value.effect, command.correlationId)],
      );
    }

    case "GoBack":
      // Asks the browser to move. The engine does NOT change its route here:
      // whether there is anywhere to go back to is the browser's knowledge,
      // not the engine's, and the answer arrives as LocationChanged — or
      // never, which is also a correct outcome.
      return go(state, [{ kind: "Navigation", correlationId: command.correlationId, operation: "back" }]);

    case "AdoptLocation": {
      const raw = routedLocation(command.location);
      const adopted = codec.adopt(state.router, raw);
      const route = adopted.route.ok ? adopted.route.value : ofError(raw, adopted.route.error);
      // Never a push: the browser has already moved, and asking it to move
      // again is the history trap this file's header warns about. A replace
      // only corrects the entry to its canonical form (a trailing slash).
      return go(
        { ...state, route, router: adopted.state, urlOutOfSync: false },
        adopted.effect === null ? [] : [navigation(adopted.effect, command.correlationId)],
      );
    }

    case "RecordNavigation":
      return command.failed ? go({ ...state, urlOutOfSync: true }) : stay(state);

    case "CopyLink": {
      if (state.copy.kind === "Copying") return stay(state);
      // Copied from state, never read back out of the DOM: the link on screen
      // and the link on the clipboard are then the same value by construction.
      const url = shareUrl(state.page, state.route);
      return go(
        { ...state, copy: { kind: "Copying", correlationId: command.correlationId } },
        [{ kind: "Clipboard", correlationId: command.correlationId, operation: "writeText", text: url }],
      );
    }

    case "RecordCopy": {
      if (state.copy.kind !== "Copying" || state.copy.correlationId !== command.correlationId) return stay(state);
      return command.outcome.kind === "Success"
        ? go({ ...state, copy: { kind: "Copied" } })
        : go({ ...state, copy: { kind: "CopyFailed", reason: command.outcome.reason } });
    }
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

// Only "denied" is worth advising a retry for: browsers grant the clipboard
// while a user gesture is fresh. "unavailable" means there is no Clipboard API
// in this context, and a retry can never succeed.
const copyStatusOf = (copy: CopyState): string => {
  switch (copy.kind) {
    case "Idle": return "";
    case "Copying": return "Copying…";
    case "Copied": return "Link copied.";
    case "CopyFailed":
      switch (copy.reason) {
        case "denied": return "The browser refused the copy. Click Copy link again.";
        case "unavailable": return "This browser will not give the page clipboard access. Copy the link above manually.";
        case "unknown": return "The copy did not complete.";
      }
  }
};

export function project(state: State): ViewState {
  const current = invoiceOf(state);
  return {
    onHome: state.route.kind === "Home",
    onInvoices: state.route.kind === "Invoices",
    onInvoice: state.route.kind === "Invoice",
    onNotFound: state.route.kind === "NotFound",
    onInvalidLink: state.route.kind === "InvalidLink",
    // The absolute link, which is what a person can actually paste somewhere.
    currentUrl: shareUrl(state.page, state.route),
    copyDisabled: state.copy.kind === "Copying",
    showCopyStatus: state.copy.kind !== "Idle",
    copyStatus: copyStatusOf(state.copy),
    unknownPath: state.route.kind === "NotFound" || state.route.kind === "InvalidLink" ? state.route.raw : "",
    invalidParameter: state.route.kind === "InvalidLink" ? state.route.parameter : "",
    homeHref: routeToUrl({ kind: "Home" }),
    invoiceId: current?.id ?? "",
    invoiceCustomer: current?.customer ?? "",
    invoiceTotal: current?.total ?? "",
    urlOutOfSync: state.urlOutOfSync,
    // A real relative link per row (#/invoices/1001): open in a new tab,
    // middle-click and copy-link-address all work, and a plain click reaches
    // the engine as LocationChanged, which it adopts (LCP-104).
    invoices: invoices.map((invoice) => ({
      id: invoice.id,
      customer: invoice.customer,
      total: invoice.total,
      href: routeToUrl({ kind: "Invoice", id: invoice.id }),
    })),
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
        // This engine sends no handshake, so the kernel negotiates no optional
        // capability with it and never routes a fact here. One arriving anyway
        // is a contract violation, not evidence.
        case "CapabilityFact":
          throw new Error(`Unexpected CapabilityFact from ${message.capability}: this engine negotiated no capabilities.`);
        case "Initialize": {
          // The first screen comes from the address bar, not from a default
          // that is then corrected. A user who opened a bookmark to
          // #/invoices/1002 never sees Home flash first. Adopting it may
          // replace the entry with its canonical form; it never pushes.
          const page = { ...pageOf(message.location), hash: "" };
          const start = { ...initialState, page, router: initialRouterState };
          return respond(transition(start, { kind: "AdoptLocation", location: message.location, correlationId: nextCorrelationId() }));
        }

        case "Event":
          return respond(transition(state, eventToCommand(message.event, nextCorrelationId())));

        case "LocationChanged":
          // Back, Forward, a followed link, or any other browser-originated move.
          return respond(transition(state, { kind: "AdoptLocation", location: message.location, correlationId: nextCorrelationId() }));

        case "EffectResult": {
          if (message.result.kind === "ClipboardResult") {
            return respond(transition(state, {
              kind: "RecordCopy",
              correlationId: message.result.correlationId,
              outcome: message.result.outcome,
            }));
          }
          if (message.result.kind !== "NavigationResult") {
            throw new Error(`Unexpected ${message.result.kind}: this engine requests only Navigation and Clipboard effects.`);
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
