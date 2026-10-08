// @echelon-foundry/limen/routing against the language-neutral routing vectors
// (conformance/routing/routing.vectors.json and url-state.vectors.json) — the
// same files the F# library runs in `npm run test:libraries` — then the
// round-trip, canonical-form and totality properties (LCP-094), the typed
// codec (LCP-093) and the route inventory schema (LCP-107, LCP-108).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  adopt, allowAll, build, captureReturnTo, createRouteCodec, defineRoutes, hrefFor, initialRouterState, isRelativeLocation,
  locationFromBrowser, navigate, refine, renderRouteInventory, replaceLocation, resolve, resumeReturnTo, routeOutcome,
  shareLink, signInLocation,
  type DefinitionError, type Guard, type GuardDecision, type LegacyRouteDefinition, type NavigationEffect, type PageLocation,
  type Params, type Result, type Roles, type RouteDefinition, type RouteMatch, type RouterState, type RouteTable, type RouteValue, type Target,
} from "../dist/routing/index.js";

// ------------------------------------------------------------------ vectors

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type Obj = { readonly [key: string]: Json };

const load = async (name: string): Promise<Obj> => {
  const parsed: unknown = JSON.parse(await readFile(new URL(`../conformance/routing/${name}`, import.meta.url), "utf8"));
  assert.ok(isObj(parsed));
  return parsed;
};

const isObj = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: Json | undefined): readonly Json[] => (Array.isArray(value) ? value : []);
const obj = (value: Json | undefined): Obj => (isObj(value) ? value : {});
const str = (value: Json | undefined): string => (typeof value === "string" ? value : "");
const has = (o: Obj, key: string): boolean => Object.hasOwn(o, key);

// The vectors' JSON tables, legacy lists and values are this library's own
// input shape, so they pass straight through; only the JSON type is narrowed.
const routesOf = (value: Json | undefined): readonly RouteDefinition[] => {
  const routes: unknown = value;
  return Array.isArray(routes) ? routes.filter((route): route is RouteDefinition => isObj(route)) : [];
};
const legacyOf = (value: Json | undefined): readonly LegacyRouteDefinition[] => list(value).filter((entry): entry is LegacyRouteDefinition & Obj => isObj(entry));
const rolesOf = (value: Json | undefined): Roles => {
  const roles = obj(value);
  return {
    home: str(roles["home"]),
    ...(typeof roles["signIn"] === "string" ? { signIn: roles["signIn"] } : {}),
    ...(typeof roles["notFound"] === "string" ? { notFound: roles["notFound"] } : {}),
  };
};
const isValue = (value: Json): value is Json & RouteValue => value !== null;
const paramsOf = (value: Json | undefined): Params => Object.fromEntries(Object.entries(obj(value)).filter((entry): entry is [string, Json & RouteValue] => isValue(entry[1])));

const files = [await load("routing.vectors.json"), await load("url-state.vectors.json")];
const rawTables = Object.fromEntries(files.flatMap((file) => Object.entries(obj(file["tables"]))));
const definitions = Object.fromEntries(files.flatMap((file) => Object.entries(obj(file["definitions"]))));

const unwrap = <T, E>(result: Result<T, E>, what: string): T => {
  if (!result.ok) assert.fail(`${what}: ${JSON.stringify(result.error)}`);
  return result.value;
};

// A table with no definition entry (the LCP-005 tables) is defined with its
// home route as its only role.
const tables: Readonly<Record<string, RouteTable>> = Object.fromEntries(Object.entries(rawTables).map(([name, routes]) => {
  const definition = obj(definitions[name]);
  return [name, unwrap(defineRoutes({ routes: routesOf(routes), legacy: legacyOf(definition["legacy"]), roles: has(definition, "roles") ? rolesOf(definition["roles"]) : { home: "home" } }), `table ${name}`)];
}));
const tableOf = (name: Json | undefined): RouteTable => tables[str(name)] ?? assert.fail(`no table ${str(name)}`);

const guardsFrom = (value: Json | undefined): Guard => {
  const decisions = obj(value);
  return (name): GuardDecision => {
    const decision = has(decisions, name) ? decisions[name] : undefined;
    if (decision === undefined || decision === null) return { kind: "Allow" };
    if (typeof decision === "string") return decision === "deny" ? { kind: "Deny" } : { kind: "Allow" };
    const redirect = obj(obj(decision)["redirect"]);
    return { kind: "Redirect", route: str(redirect["to"]), params: paramsOf(redirect["params"]), query: paramsOf(redirect["query"]) };
  };
};

const repeated = (o: Obj, plain: string, repeat: string): string => {
  const r = obj(o[repeat]);
  return has(o, repeat) ? str(r["prefix"]) + str(r["text"]).repeat(Number(r["times"])) : str(o[plain]);
};

const targetOf = (value: Json | undefined): Target => {
  const o = obj(value);
  return { route: str(o["route"]), params: paramsOf(o["params"]), query: paramsOf(o["query"]) };
};

const effectJson = (effect: NavigationEffect | null): Json =>
  effect === null ? null : effect.kind === "Push" ? { push: effect.location } : { replace: effect.location };

let vectorCount = 0;
const agree = (name: string, actual: unknown, expected: unknown): void => {
  assert.deepStrictEqual(actual, expected, name);
  vectorCount += 1;
};

for (const [index, file] of files.entries()) {
  const label = index === 0 ? "LCP-005" : "URL state";

  test(`${label}: resolve vectors`, () => {
    for (const vector of list(file["resolve"]).map(obj)) {
      const path = repeated(vector, "path", "pathRepeat");
      agree(`resolve: ${str(vector["name"])}`, resolve(tableOf(vector["table"]), { path, query: str(vector["query"]) }, guardsFrom(vector["guards"])), vector["expect"]);
    }
  });

  test(`${label}: build vectors`, () => {
    for (const vector of list(file["build"]).map(obj)) {
      const built = build(tableOf(vector["table"]), targetOf(vector));
      const actual = built.ok ? { ok: built.value } : { error: built.error.kind, parameter: built.error.kind === "UnknownRoute" ? "" : built.error.parameter };
      agree(`build: ${str(vector["name"])}`, actual, vector["expect"]);
    }
  });

  test(`${label}: session vectors (adopt, navigate, refine, Back, Forward, resume)`, () => {
    for (const session of list(file["sessions"]).map(obj)) {
      const table = tableOf(session["table"]);
      let state: RouterState = initialRouterState;
      let history: { readonly entries: readonly string[]; readonly index: number } = { entries: [], index: -1 };
      const apply = (effect: NavigationEffect | null): void => {
        if (effect === null) return;
        history = effect.kind === "Push"
          ? { entries: [...history.entries.slice(0, history.index + 1), effect.location], index: history.index + 1 }
          : { entries: history.entries.map((entry, i) => (i === history.index ? effect.location : entry)), index: history.index };
      };
      for (const [stepIndex, step] of list(session["steps"]).map(obj).entries()) {
        const guard = guardsFrom(step["guards"]);
        const actual: Record<string, Json> = {};
        const adoptAt = (location: string): void => {
          const adopted = adopt(table, state, location, guard);
          actual["route"] = adopted.resolution.kind === "Matched" ? adopted.resolution.route : null;
          actual["effect"] = effectJson(adopted.effect);
          state = adopted.state;
          apply(adopted.effect);
        };
        const moved = (delta: number): void => {
          const target = history.index + delta;
          const location = history.entries[target];
          if (location === undefined) { actual["left"] = true; return; }
          history = { ...history, index: target };
          actual["location"] = location;
          adoptAt(location);
        };
        if (has(step, "adopt")) {
          const location = str(step["adopt"]);
          if (history.entries.length === 0) history = { entries: [location], index: 0 };
          else apply({ kind: "Push", location });
          adoptAt(location);
        } else if (has(step, "navigate") || has(step, "refine")) {
          const operation = has(step, "navigate") ? navigate : refine;
          const target = targetOf(step["navigate"] ?? step["refine"]);
          const result = unwrap(operation(table, state, target), str(session["name"]));
          actual["route"] = target.route;
          actual["effect"] = effectJson(result.effect);
          state = result.state;
          apply(result.effect);
        } else if (has(step, "back")) moved(-1);
        else if (has(step, "forward")) moved(1);
        else {
          const location = resumeReturnTo(table, str(step["resume"]), guard);
          const result = replaceLocation(state, location);
          const resolution = resolve(table, location, guard);
          actual["route"] = resolution.kind === "Matched" ? resolution.route : null;
          actual["effect"] = effectJson(result.effect);
          state = result.state;
          apply(result.effect);
        }
        agree(`session ${str(session["name"])} step ${String(stepIndex + 1)}`, actual, step["expect"]);
      }
    }
  });

  test(`${label}: definition vectors (tables are values, refused as values)`, () => {
    for (const vector of list(file["definitionCases"]).map(obj)) {
      const routes = typeof vector["routes"] === "string" ? routesOf(rawTables[vector["routes"]] ?? []) : routesOf(vector["routes"]);
      const defined = defineRoutes({ routes, legacy: legacyOf(vector["legacy"]), roles: rolesOf(vector["roles"]) });
      const actual = defined.ok ? { ok: true } : { errors: defined.error.map((error: DefinitionError) => ({ ...error })) };
      agree(`definition: ${str(vector["name"])}`, actual, vector["expect"]);
    }
  });

  test(`${label}: return-target vectors (capture, sign-in, resume)`, () => {
    for (const vector of list(file["returnTo"]).map(obj)) {
      const table = tableOf(vector["table"]);
      const optional = (value: Json | undefined): string | null => (typeof value === "string" ? value : null);
      const actual = has(vector, "capture") ? captureReturnTo(table, str(vector["capture"]))
        : has(vector, "resume") ? resumeReturnTo(table, optional(vector["resume"]), guardsFrom(vector["guards"]))
        : (() => { const built = signInLocation(table, optional(vector["signIn"])); return built.ok ? built.value : `error ${built.error.kind}`; })();
      agree(`returnTo: ${str(vector["name"])}`, actual, vector["expect"]);
    }
  });

  test(`${label}: location vectors (hash and path modes, href, share)`, () => {
    for (const vector of list(file["locations"]).map(obj)) {
      const mode = vector["mode"] === "hash" ? "hash" : "path";
      const l = obj(vector["location"]);
      const page: PageLocation = { origin: str(l["origin"]), path: str(l["path"]), query: str(l["query"]), hash: str(l["hash"]) };
      const actual = has(vector, "href") ? hrefFor(str(vector["href"]), mode)
        : has(vector, "share") ? shareLink(page, str(vector["share"]), mode)
        : locationFromBrowser(page, mode);
      agree(`location: ${str(vector["name"])}`, actual, vector["expect"]);
    }
  });

  test(`${label}: outcome vectors (closed route errors)`, () => {
    for (const vector of list(file["outcomes"]).map(obj)) {
      const table = tableOf(vector["table"]);
      const outcome = routeOutcome(table, resolve(table, repeated(vector, "location", "locationRepeat"), guardsFrom(vector["guards"])));
      const actual = outcome.ok ? { ok: outcome.value.route }
        : outcome.error.kind === "RedirectLoop" ? { error: "RedirectLoop" }
        : (() => { const { kind, ...rest } = outcome.error; return { error: kind, ...rest }; })();
      agree(`outcome: ${str(vector["name"])}`, actual, vector["expect"]);
    }
  });

  test(`${label}: inventory vectors are byte-identical to the F# library's`, () => {
    for (const vector of list(file["inventory"]).map(obj)) {
      const mode = vector["mode"] === "hash" ? "hash" : "path";
      agree(`inventory: ${str(vector["name"])}`, renderRouteInventory(tableOf(vector["table"]), mode), vector["expect"]);
    }
  });
}

test("every vector in both files ran (165 at WI-0168)", () => {
  assert.ok(vectorCount >= 165, `only ${String(vectorCount)} vectors ran`);
});

// ------------------------------------------------------------ the schema (LCP-108)

// A small JSON Schema 2020-12 evaluator for the keywords routes.schema.json
// uses; the package has no dependency to do it, and none is added for a test.
type Schema = Obj;
const schemaFile: unknown = JSON.parse(await readFile(new URL("../contract/routes.schema.json", import.meta.url), "utf8"));
assert.ok(isObj(schemaFile));
const ROOT_SCHEMA: Schema = schemaFile;

const typeOk = (type: string, value: Json): boolean =>
  type === "null" ? value === null
  : type === "array" ? Array.isArray(value)
  : type === "object" ? isObj(value)
  : type === "integer" ? typeof value === "number" && Number.isInteger(value)
  : typeof value === type;

const validate = (schema: Schema, value: Json, path: string): readonly string[] => {
  const ref = schema["$ref"];
  if (typeof ref === "string") {
    const target = ref.replace(/^#\//, "").split("/").reduce<Json>((node, key) => obj(node)[key] ?? null, ROOT_SCHEMA);
    return validate(obj(target), value, path);
  }
  const problems: string[] = [];
  const type = schema["type"];
  if (typeof type === "string" && !typeOk(type, value)) return [`${path}: not ${type}`];
  if (has(schema, "const") && JSON.stringify(schema["const"]) !== JSON.stringify(value)) problems.push(`${path}: not the constant`);
  if (Array.isArray(schema["enum"]) && !schema["enum"].some((option: Json) => option === value)) problems.push(`${path}: not in the enum`);
  if (typeof schema["minLength"] === "number" && typeof value === "string" && value.length < schema["minLength"]) problems.push(`${path}: too short`);
  if (typeof schema["pattern"] === "string" && typeof value === "string" && !new RegExp(schema["pattern"], "u").test(value)) problems.push(`${path}: does not match ${schema["pattern"]}`);
  if (Array.isArray(schema["oneOf"])) {
    const passing = schema["oneOf"].filter((option: Json) => validate(obj(option), value, path).length === 0).length;
    if (passing !== 1) problems.push(`${path}: matches ${String(passing)} of oneOf`);
  }
  if (isObj(value)) {
    for (const key of list(schema["required"])) if (typeof key === "string" && !has(value, key)) problems.push(`${path}: missing ${key}`);
    const properties = obj(schema["properties"]);
    for (const [key, item] of Object.entries(value)) {
      const property = has(properties, key) ? properties[key] : schema["additionalProperties"];
      if (isObj(property)) problems.push(...validate(property, item, `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && isObj(schema["items"])) {
    const items = schema["items"];
    value.forEach((item: Json, i: number) => problems.push(...validate(items, item, `${path}[${String(i)}]`)));
  }
  return problems;
};

const parsedInventory = (text: string): Json => {
  const parsed: unknown = JSON.parse(text);
  return isObj(parsed) ? parsed : null;
};

test("every vector table's inventory, in both modes, validates against contract/routes.schema.json", () => {
  for (const [name, table] of Object.entries(tables)) {
    for (const mode of ["hash", "path"] as const) {
      const text = renderRouteInventory(table, mode);
      assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"), `${name}: one final newline`);
      assert.deepStrictEqual(validate(ROOT_SCHEMA, parsedInventory(text), "$"), [], `${name} (${mode})`);
    }
  }
});

test("the schema refuses a document that is not an inventory", () => {
  const good = parsedInventory(renderRouteInventory(tableOf("views")));
  assert.ok(isObj(good));
  assert.notDeepStrictEqual(validate(ROOT_SCHEMA, { ...good, schema: "echelon.routes/v2" }, "$"), []);
  assert.notDeepStrictEqual(validate(ROOT_SCHEMA, { ...good, mode: "query" }, "$"), []);
  const { routes: _routes, ...withoutRoutes } = good;
  assert.notDeepStrictEqual(validate(ROOT_SCHEMA, withoutRoutes, "$"), []);
});

test("the package ships the schema", async () => {
  const pkg: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(isObj(pkg));
  assert.ok(list(pkg["files"]).includes("contract/routes.schema.json"));
  assert.equal(obj(pkg["exports"])["./contract/routes.schema.json"], "./contract/routes.schema.json");
  assert.deepStrictEqual(obj(pkg["exports"])["./routing"], { types: "./dist/routing/index.d.ts", import: "./dist/routing/index.js" });
});

// ------------------------------------------------- the typed codec (LCP-093)

// The views table as an application's own route type. Both mappings are
// exhaustive: a View case without a branch fails to compile (`never`).
type Filter = { readonly status: readonly string[]; readonly sort: string; readonly page: number; readonly archived: boolean; readonly q: string | null };

type View =
  | { readonly kind: "Home" }
  | { readonly kind: "Invoices"; readonly filter: Filter }
  | { readonly kind: "Invoice"; readonly id: number; readonly filter: Filter; readonly tab: string }
  | { readonly kind: "Report"; readonly period: string; readonly on: string | null; readonly tags: readonly string[] }
  | { readonly kind: "Day"; readonly on: string }
  | { readonly kind: "Board"; readonly view: string }
  | { readonly kind: "SignIn"; readonly returnTo: string | null }
  | { readonly kind: "Admin" };

const unreachable = (value: never): never => { throw new Error(`unmapped ${JSON.stringify(value)}`); };

const filterQuery = (f: Filter): Params => ({ status: f.status, sort: f.sort, page: f.page, archived: f.archived, ...(f.q === null ? {} : { q: f.q }) });

const toTarget = (view: View): Target => {
  switch (view.kind) {
    case "Home": return { route: "home" };
    case "Invoices": return { route: "invoices.list", query: filterQuery(view.filter) };
    case "Invoice": return { route: "invoices.invoice", params: { id: view.id }, query: { ...filterQuery(view.filter), tab: view.tab } };
    case "Report": return { route: "reports", params: { period: { month: view.period } }, query: { ...(view.on === null ? {} : { on: { date: view.on } }), tags: view.tags } };
    case "Day": return { route: "day", params: { on: { date: view.on } } };
    case "Board": return { route: "board", params: { view: view.view } };
    case "SignIn": return { route: "signIn", query: view.returnTo === null ? {} : { returnTo: view.returnTo } };
    case "Admin": return { route: "admin" };
    default: return unreachable(view);
  }
};

const get = (values: Params, key: string): RouteValue | undefined => (Object.hasOwn(values, key) ? values[key] : undefined);
const text = (value: RouteValue | undefined): string | null => (typeof value === "string" ? value : null);
const members = (value: RouteValue | undefined): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const dateText = (value: RouteValue | undefined): string | null => (typeof value === "object" && !Array.isArray(value) && value !== null && "date" in value ? value.date : null);
const monthText = (value: RouteValue | undefined): string | null => (typeof value === "object" && !Array.isArray(value) && value !== null && "month" in value ? value.month : null);

const ofMatch = (matched: RouteMatch): Result<View, string> => {
  const params: Params = Object.assign({}, ...matched.chain.map((level) => level.params));
  const q = matched.query;
  const filter = (): Filter | null => {
    const [sort, page, archived] = [get(q, "sort"), get(q, "page"), get(q, "archived")];
    return typeof sort === "string" && typeof page === "number" && typeof archived === "boolean"
      ? { status: members(get(q, "status")), sort, page, archived, q: text(get(q, "q")) } : null;
  };
  const okView = (value: View): Result<View, string> => ({ ok: true, value });
  const failed = (problem: string): Result<View, string> => ({ ok: false, error: problem });
  switch (matched.route) {
    case "home": return okView({ kind: "Home" });
    case "invoices.list": { const f = filter(); return f === null ? failed("filter") : okView({ kind: "Invoices", filter: f }); }
    case "invoices.invoice": {
      const [f, id, tab] = [filter(), get(params, "id"), text(get(q, "tab"))];
      return f !== null && typeof id === "number" && tab !== null ? okView({ kind: "Invoice", id, filter: f, tab }) : failed("invoice");
    }
    case "reports": {
      const period = monthText(get(params, "period"));
      return period === null ? failed("period") : okView({ kind: "Report", period, on: dateText(get(q, "on")), tags: members(get(q, "tags")) });
    }
    case "day": { const on = dateText(get(params, "on")); return on === null ? failed("day") : okView({ kind: "Day", on }); }
    case "board": { const view = text(get(params, "view")); return view === null ? failed("board") : okView({ kind: "Board", view }); }
    case "signIn": return okView({ kind: "SignIn", returnTo: text(get(q, "returnTo")) });
    case "admin": return okView({ kind: "Admin" });
    default: return failed(`unmapped ${matched.route}`);
  }
};

const views = tableOf("views");
const codec = createRouteCodec(views, { toTarget, ofMatch });

test("the codec parses and formats the typed route, and refuses with typed route errors", () => {
  assert.deepStrictEqual(codec.parse("/invoices/42?tab=history&status=paid,open"), {
    ok: true,
    value: { kind: "Invoice", id: 42, tab: "history", filter: { status: ["open", "paid"], sort: "due", page: 1, archived: false, q: null } },
  });
  assert.deepStrictEqual(codec.format({ kind: "Report", period: "2026-10", on: "2026-10-08", tags: ["b,c", "a"] }), { ok: true, value: "/reports/2026-10?on=2026-10-08&tags=a,b%2Cc" });
  assert.deepStrictEqual(codec.parse("/nowhere"), { ok: false, error: { kind: "NotFound" } });
  assert.deepStrictEqual(codec.parse("/admin", () => ({ kind: "Deny" })), { ok: false, error: { kind: "NotPermitted", route: "admin" } });
  assert.deepStrictEqual(codec.parse("/%zz"), { ok: false, error: { kind: "Malformed", part: "path" } });
  const partial = createRouteCodec(views, { toTarget, ofMatch: (m) => (m.route === "home" ? { ok: true, value: { kind: "Home" } } : { ok: false, error: "only home" }) });
  assert.deepStrictEqual(partial.parse("/admin"), { ok: false, error: { kind: "Unmapped", route: "admin", problem: "only home" } });
  // A value the table refuses (no 29 February in 2026): format says so instead of producing a URL.
  assert.deepStrictEqual(codec.format({ kind: "Day", on: "2026-02-29" }), { ok: false, error: { kind: "InvalidParameter", parameter: "on" } });
});

test("the codec's adopt, navigate and refine choose replace, push and replace", () => {
  const adopted = codec.adopt(initialRouterState, "/invoices?page=1&sort=due");
  assert.deepStrictEqual(adopted.effect, { kind: "Replace", location: "/invoices" });
  assert.equal(adopted.route.ok, true);
  const pushed = unwrap(codec.navigate(adopted.state, { kind: "Invoice", id: 7, tab: "summary", filter: { status: [], sort: "due", page: 1, archived: false, q: null } }), "navigate");
  assert.deepStrictEqual(pushed.effect, { kind: "Push", location: "/invoices/7" });
  const refined = unwrap(codec.refine(pushed.state, { kind: "Invoice", id: 7, tab: "lines", filter: { status: [], sort: "due", page: 1, archived: false, q: null } }), "refine");
  assert.deepStrictEqual(refined.effect, { kind: "Replace", location: "/invoices/7?tab=lines" });
  assert.equal(unwrap(codec.refine(refined.state, { kind: "Invoice", id: 7, tab: "lines", filter: { status: [], sort: "due", page: 1, archived: false, q: null } }), "again").effect, null);
});

// -------------------------------------------------------- properties (LCP-094)

// A seeded generator (mulberry32), so a failure reproduces exactly.
const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const random = seeded(20261008);
const below = (n: number): number => Math.floor(random() * n);
const pick = <T>(items: readonly T[]): T => items[below(items.length)] ?? assert.fail("empty pick");
const ALPHABET = ["a", "b", "Z", "0", " ", ",", "&", "=", "?", "#", "/", "%", "+", "~", "é", "日本", "😀", "-", "_", ".", "'", "\"", "\t"];
const word = (): string => Array.from({ length: 1 + below(6) }, () => pick(ALPHABET)).join("");
const maybe = <T>(make: () => T): T | null => (below(2) === 0 ? null : make());
const sorted = (items: readonly string[]): readonly string[] => [...new Set(items)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
const safeInt = (): number => pick([0, 1, -1, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, below(2 ** 31), -below(2 ** 31)]);
const pad = (n: number, width: number): string => String(n).padStart(width, "0");
const date = (): string => {
  const [year, month] = [1 + below(9999), 1 + below(12)];
  const days = month === 2 ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(1 + below(days), 2)}`;
};
const month = (): string => `${pad(1 + below(9999), 4)}-${pad(1 + below(12), 2)}`;
const filter = (): Filter => ({
  status: sorted(["draft", "open", "overdue", "paid"].filter(() => below(2) === 0)),
  sort: pick(["due", "amount", "number"]), page: safeInt(), archived: below(2) === 0, q: maybe(word),
});
const view = (): View => {
  switch (below(8)) {
    case 0: return { kind: "Home" };
    case 1: return { kind: "Invoices", filter: filter() };
    case 2: return { kind: "Invoice", id: safeInt(), filter: filter(), tab: pick(["summary", "history", "lines"]) };
    case 3: return { kind: "Report", period: month(), on: maybe(date), tags: sorted(Array.from({ length: below(4) }, word)) };
    case 4: return { kind: "Day", on: date() };
    case 5: return { kind: "Board", view: pick(["week", "month"]) };
    case 6: return { kind: "SignIn", returnTo: maybe(() => `/${word()}`) };
    default: return { kind: "Admin" };
  }
};

const CASES = 3000;

test(`property: parse(format(v)) = Ok v for ${String(CASES)} generated routes`, () => {
  for (let i = 0; i < CASES; i += 1) {
    const v = view();
    const location = unwrap(codec.format(v), `format ${JSON.stringify(v)}`);
    assert.deepStrictEqual(codec.parse(location), { ok: true, value: v }, `round trip via ${location}`);
  }
});

const mutate = (location: string): string => {
  const join = location.includes("?") ? "&" : "?";
  switch (below(7)) {
    case 0: return `${location}${join}utm=${String(below(100))}`;
    case 1: return `${location}/`;
    case 2: return location.split(",").join(",,");
    case 3: { const at = below(location.length + 1); return location.slice(0, at) + pick(["%", "%zz", "%C3", "+", "&&", "="]) + location.slice(at); }
    case 4: return location.toUpperCase();
    case 5: return `${location}${join}page=1&page=1`;
    default: return location.split("sort=").join("sort=due&sort=");
  }
};

test(`property: the canonical form of ${String(CASES)} mutated locations is stable`, () => {
  for (let i = 0; i < CASES; i += 1) {
    const formatted = codec.format(view());
    if (!formatted.ok) continue;
    const candidate = mutate(formatted.value);
    const first = resolve(views, candidate);
    if (first.kind !== "Matched") continue;
    const canonicalForm = unwrap(build(views, { route: first.route, params: Object.assign({}, ...first.chain.map((level) => level.params)), query: first.query }), `canonical of ${candidate}`);
    const again = resolve(views, canonicalForm);
    assert.equal(again.kind, "Matched", `canonical ${canonicalForm} of ${candidate} does not resolve`);
    const adopted = adopt(views, initialRouterState, canonicalForm);
    assert.equal(adopted.effect, null, `adopting canonical ${canonicalForm} asks for ${JSON.stringify(adopted.effect)}`);
  }
});

const noise = (): string => Array.from({ length: below(40) }, () =>
  String.fromCharCode(pick([below(128), 0xd800 + below(0x800), 0x80 + below(0x2f80), 0x25, 0x2f]))).join("");

test(`property: ${String(CASES)} arbitrary strings resolve, parse, capture and resume without throwing`, () => {
  for (let i = 0; i < CASES; i += 1) {
    const candidate = below(2) === 0 ? `/${noise()}` : noise();
    resolve(views, candidate, guardsFrom(null));
    codec.parse(candidate);
    adopt(views, initialRouterState, candidate);
    captureReturnTo(views, candidate);
    const resumed = resumeReturnTo(views, candidate, allowAll);
    assert.ok(isRelativeLocation(resumed), `resume gave ${resumed}`);
  }
});

test("definitions never throw, whatever the input", () => {
  const junk: readonly RouteDefinition[] = [
    { name: "", path: "{" }, { name: "a", path: "{*}" }, { name: "b", path: "{:int}/{x:nope}" },
    { name: "c", path: "x", query: [{ name: "p", type: "enum", values: ["", ""] }], redirect: { to: "zz", params: { q: "{nope}" } } },
  ];
  const defined = defineRoutes({ routes: junk, legacy: [{ path: "{", to: "" }], roles: { home: "" } });
  assert.equal(defined.ok, false);
});
