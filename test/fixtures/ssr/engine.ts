// The fixture engine for server and static rendering (kemiller2002/limen#38):
// one engine for the browser and the server. It reads the route from the
// location it is initialized with, loads its data over Http, and projects the
// page — including its head metadata. It selects only capabilities the host
// offered, and treats an unavailable effect as absent, never as an error, so
// the same engine renders on a server that has no Storage.

import type { BrowserToEngineMessage, EffectRequest, EngineToBrowserMessage, EngineTransport, ViewState, CorrelationId, CapabilityOffer } from "../../../dist/protocol.js";
import { CORE_CONTRACT_IDENTITY } from "../../../dist/protocol.js";

export type Item = { readonly id: string; readonly name: string; readonly price: number; readonly text: string };

type Route = { readonly kind: "list" } | { readonly kind: "detail"; readonly id: string } | { readonly kind: "missing"; readonly path: string };
type Data = { readonly kind: "loading" } | { readonly kind: "list"; readonly items: readonly Item[] } | { readonly kind: "detail"; readonly item: Item } | { readonly kind: "failed" } | { readonly kind: "none" };
type State = { readonly origin: string; readonly route: Route; readonly data: Data; readonly recent: readonly string[] | null };

export const routeOf = (path: string): Route => {
  if (path === "/") return { kind: "list" };
  const detail = /^\/items\/([a-z0-9-]+)$/.exec(path);
  return detail?.[1] !== undefined ? { kind: "detail", id: detail[1] } : { kind: "missing", path };
};

const isItem = (value: unknown): value is Item => {
  const field = (name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);
  return typeof field("id") === "string" && typeof field("name") === "string" && typeof field("price") === "number" && typeof field("text") === "string";
};

export const project = (state: State): ViewState => {
  const { route, data } = state;
  const title = route.kind === "missing" ? "Not found — Catalogue" : data.kind === "detail" ? `${data.item.name} — Catalogue` : "Catalogue";
  const description = data.kind === "detail" ? data.item.text : route.kind === "missing" ? "No such page." : "Everything we sell.";
  const path = route.kind === "detail" ? `/items/${route.id}` : route.kind === "missing" ? route.path : "/";
  return {
    title,
    description,
    robots: route.kind === "missing" ? "noindex" : "index",
    canonical: `${state.origin}${path}`,
    heading: route.kind === "missing" ? "Not found" : data.kind === "detail" ? data.item.name : "Catalogue",
    status: data.kind === "loading" ? "Loading…" : data.kind === "failed" ? "The catalogue could not be loaded." : route.kind === "missing" ? "There is nothing here." : "",
    showList: data.kind === "list",
    items: data.kind === "list" ? data.items.map((item) => ({ id: item.id, name: item.name, href: `/items/${item.id}`, price: `£${item.price.toFixed(2)}` })) : [],
    showDetail: data.kind === "detail",
    detailName: data.kind === "detail" ? data.item.name : "",
    detailText: data.kind === "detail" ? data.item.text : "",
    recent: state.recent === null || state.recent.length === 0 ? "No recently viewed items." : `Recently viewed: ${state.recent.join(", ")}`,
  };
};

export const createCatalogueTransport = (options: { readonly wanted?: readonly string[] } = {}): EngineTransport => {
  const cell: { state: State; next: number } = { state: { origin: "", route: { kind: "list" }, data: { kind: "loading" }, recent: null }, next: 0 };
  const id = (): CorrelationId => `c${(cell.next += 1)}` as CorrelationId;
  const respond = (effects: readonly EffectRequest[] = []): EngineToBrowserMessage => ({ view: project(cell.state), effects: [...effects], cancellations: [] });
  return {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> => {
      switch (message.kind) {
        case "Initialize": {
          const route = routeOf(message.location.path);
          cell.state = { origin: message.location.origin, route, data: route.kind === "missing" ? { kind: "none" } : { kind: "loading" }, recent: null };
          const load: readonly EffectRequest[] = route.kind === "list" ? [{ kind: "Http", correlationId: id(), method: "GET", url: "/api/items", timeoutMs: 2000 }]
            : route.kind === "detail" ? [{ kind: "Http", correlationId: id(), method: "GET", url: `/api/items/${route.id}`, timeoutMs: 2000 }] : [];
          // Only what the host offered: on the server that is nothing.
          const offered: readonly CapabilityOffer[] = message.handshake?.capabilities ?? [];
          return {
            ...respond([...load, { kind: "Storage", correlationId: id(), operation: "get", key: "recent" }]),
            handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: offered.filter((offer) => (options.wanted ?? []).includes(offer.id)) },
          };
        }
        case "EffectResult": {
          const result = message.result;
          if (result.kind === "StorageResult") {
            const recent = result.outcome.kind === "Success" && result.outcome.value !== null ? result.outcome.value.split(",").filter((entry) => entry !== "") : null;
            cell.state = { ...cell.state, recent };
            return respond();
          }
          if (result.kind === "HttpResult") {
            const outcome = result.outcome;
            const body = outcome.kind === "Success" && outcome.status === 200 ? outcome.body : undefined;
            const data: Data = Array.isArray(body) && body.every(isItem) ? { kind: "list", items: body } : isItem(body) ? { kind: "detail", item: body } : { kind: "failed" };
            cell.state = { ...cell.state, data };
            return respond();
          }
          return respond();
        }
        case "Event": case "LocationChanged": case "CapabilityFact":
          return respond();
      }
    },
  };
};

export const ITEMS: readonly Item[] = [
  { id: "kettle", name: "Kettle", price: 24.5, text: "A 1.7 litre kettle." },
  { id: "teapot", name: "Teapot", price: 18, text: "A six-cup teapot." },
  { id: "cups", name: "Cups & saucers", price: 12.25, text: "Four <fine> cups." },
];

// The API both renderings load from, answered in-process.
export const catalogueFetch = async (url: string): Promise<{ readonly status: number; readonly headers: { get(name: string): string | null }; text(): Promise<string>; json(): Promise<unknown> }> => {
  const path = new URL(url).pathname;
  const one = /^\/api\/items\/(.+)$/.exec(path);
  const body = path === "/api/items" ? ITEMS : one !== null ? ITEMS.find((item) => item.id === one[1]) : undefined;
  const status = body === undefined ? 404 : 200;
  const text = JSON.stringify(body ?? { error: "not found" });
  return { status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) as unknown };
};
