// The URL-state page's engine (LCP-097, LCP-103, LCP-104, LCP-106): an
// application whose whole navigable state is the URL, on
// @echelon-foundry/limen/routing in hash mode. It touches no browser API: it
// reads locations from Initialize and LocationChanged, and requests Navigation
// and Clipboard effects. main.js drives it in a real browser.
import {
  adopt, canonical, captureReturnTo, defineRoutes, hrefFor, initialRouterState, locationFromBrowser, navigate,
  refine, replaceLocation, resolve, resumeReturnTo, routeOutcome, shareLink,
} from "../../../../dist/routing/index.js";

const defined = defineRoutes({
  routes: [
    { name: "home", path: "" },
    {
      name: "invoices", path: "invoices",
      query: [{ name: "status", type: "set", values: ["draft", "open", "overdue", "paid"] }],
      children: [
        { name: "list", path: "" },
        { name: "invoice", path: "{id:int}", query: [{ name: "tab", type: "enum", values: ["summary", "history", "lines"], default: "summary" }] },
      ],
    },
    { name: "reports", path: "reports/{period:month}", guard: "signedIn", query: [{ name: "tags", type: "set", values: [] }] },
    { name: "signIn", path: "sign-in", returnTarget: false, query: [{ name: "returnTo", type: "string" }] },
    { name: "admin", path: "admin", guard: "adminOnly" },
    { name: "notFound", path: "{*rest}" },
  ],
  roles: { home: "home", signIn: "signIn", notFound: "notFound" },
});
if (!defined.ok) throw new Error(`route table: ${JSON.stringify(defined.error)}`);
const table = defined.value;

// Guards decide what the interface shows; the server is the authority.
const guardFor = (signedIn) => (name, match) => {
  if (name === "adminOnly") return { kind: "Deny" };
  if (name !== "signedIn" || signedIn) return { kind: "Allow" };
  const built = canonical(table, match);
  const target = built.ok ? captureReturnTo(table, built.value) : null;
  return { kind: "Redirect", route: "signIn", query: target === null ? {} : { returnTo: target } };
};

const sorted = (values) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const paramsOf = (match) => Object.assign({}, ...match.chain.map((level) => level.params));

const describe = (resolution) => {
  const outcome = routeOutcome(table, resolution);
  if (outcome.ok) return { route: outcome.value.route, detail: JSON.stringify({ params: sorted(paramsOf(outcome.value)), query: sorted(outcome.value.query) }) };
  const error = outcome.error;
  const detail = error.kind === "Invalid" ? error.parameter : error.kind === "Malformed" ? error.part : error.kind === "NotPermitted" ? error.route : "";
  return { route: error.kind, detail };
};

const initial = { router: initialRouterState, page: null, signedIn: false, resolution: { kind: "NotFound" }, copy: "", shared: "" };

const project = (state) => {
  const { route, detail } = describe(state.resolution);
  return {
    route, detail,
    location: state.router.current ?? "",
    signedIn: state.signedIn ? "yes" : "no",
    invoiceSevenHref: hrefFor("/invoices/7"),
    copyStatus: state.copy,
    sharedLink: state.shared,
  };
};

const navigation = (effect, id) => ({ kind: "Navigation", correlationId: id, operation: effect.kind === "Push" ? "push" : "replace", url: hrefFor(effect.location) });

const adoptPage = (state, location) => {
  const page = state.page ?? { origin: location.origin, path: location.path, query: location.query, hash: "" };
  const adopted = adopt(table, state.router, locationFromBrowser(location), guardFor(state.signedIn));
  return { state: { ...state, page, router: adopted.state, resolution: adopted.resolution }, effect: adopted.effect };
};

// A move the engine decides on: navigate (push) or refine (replace), then the
// new location resolved, so the view and the URL change together.
const move = (state, operation, target) => {
  const moved = operation(table, state.router, target);
  if (!moved.ok) return { state, effect: null };
  const resolution = resolve(table, moved.value.state.current ?? "/", guardFor(state.signedIn));
  return { state: { ...state, router: moved.value.state, resolution }, effect: moved.value.effect };
};

const onEvent = (state, name) => {
  const match = state.resolution.kind === "Matched" ? state.resolution : null;
  switch (name) {
    case "showLines":
      return match?.route === "invoices.invoice" ? move(state, refine, { route: match.route, params: paramsOf(match), query: { ...match.query, tab: "lines" } }) : { state, effect: null };
    case "showList":
      return match === null ? { state, effect: null } : move(state, navigate, { route: "invoices.list", query: { status: match.query.status ?? [] } });
    case "signIn": {
      const signedIn = { ...state, signedIn: true };
      const returnTo = match?.route === "signIn" && typeof match.query.returnTo === "string" ? match.query.returnTo : null;
      const target = resumeReturnTo(table, returnTo, guardFor(true));
      const moved = replaceLocation(state.router, target);
      return { state: { ...signedIn, router: moved.state, resolution: resolve(table, target, guardFor(true)) }, effect: moved.effect };
    }
    default:
      return { state, effect: null };
  }
};

export const createUrlStateEngine = () => {
  let state = initial;
  let sequence = 0;
  const id = () => `url-${++sequence}`;
  const answer = (result, extra = []) => {
    state = result.state;
    return { view: project(state), effects: [...(result.effect === null ? [] : [navigation(result.effect, id())]), ...extra], cancellations: [] };
  };
  return {
    start: async () => {},
    dispatch: async (message) => {
      switch (message.kind) {
        case "Initialize":
        case "LocationChanged":
          return answer(adoptPage(state, message.location));
        case "Event": {
          if (message.event.name !== "copyLink") return answer(onEvent(state, message.event.name));
          const link = shareLink(state.page, state.router.current ?? "/");
          return answer({ state: { ...state, copy: "copying", shared: link }, effect: null }, [{ kind: "Clipboard", correlationId: id(), operation: "writeText", text: link }]);
        }
        case "EffectResult": {
          const result = message.result;
          if (result.kind !== "ClipboardResult") return answer({ state, effect: null });
          const copy = result.outcome.kind === "Success" ? "copied" : `failed: ${result.outcome.reason}`;
          return answer({ state: { ...state, copy }, effect: null });
        }
        default:
          return answer({ state, effect: null });
      }
    },
  };
};
