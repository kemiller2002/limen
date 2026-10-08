// Limen routing: the TypeScript implementation of the language-neutral
// semantics in conformance/routing/README.md (kemiller2002/limen#20, LCP-005,
// and the URL-state cluster LCP-088..112). The F# library
// (libraries/fsharp/Limen.Routing) implements the same semantics; both pass
// the same vectors.
//
// Routing is application meaning, so it lives in the engine. This module
// resolves a location the browser reported, builds the canonical location for
// a destination, and decides the one Navigation effect (push, replace or none)
// that keeps the browser's history consistent with the engine. It never
// touches the browser: the kernel performs the effect.
//
// Every function is pure and total. Malformed input is a value, never an
// exception. Guards decide what the interface shows; they are not security.

import { distinct, percentDecode, percentEncode } from "./text.js";
import { convert, convertSet, expected, render, same, type Kind, type ParamType, type RouteValue } from "./values.js";

export type { ParamType, RouteValue } from "./values.js";

/** Locations longer than this (path and query together) are refused before decoding (LCP-095). */
export const MAX_LOCATION_LENGTH = 8192;

export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

const ok = <T>(value: T): { readonly ok: true; readonly value: T } => ({ ok: true, value });
const fail = <E>(error: E): { readonly ok: false; readonly error: E } => ({ ok: false, error });

// ---------------------------------------------------------------------------
// Definitions: the neutral JSON shape of conformance/routing/README.md
// ---------------------------------------------------------------------------

export type QueryParamDefinition = {
  readonly name: string;
  readonly type: ParamType;
  /** Enum and set values. An empty set list allows any non-empty member. */
  readonly values?: readonly string[];
  readonly required?: boolean;
  /** Reported when the key is absent, and omitted from the canonical form. A date or month may be given as its text. */
  readonly default?: RouteValue;
};

export type RouteDefinition = {
  readonly name: string;
  /** Segments relative to the parent: literal, {name}, {name:int|string|date|month|enum:a|b}, or a final {*name}. */
  readonly path: string;
  readonly query?: readonly QueryParamDefinition[];
  readonly children?: readonly RouteDefinition[];
  /** Parameter templates: "{sourceParam}" copies a source parameter; anything else is literal. */
  readonly redirect?: { readonly to: string; readonly params?: Readonly<Record<string, string>> };
  readonly guard?: string;
  readonly requires?: readonly string[];
  /** Whether a sign-in may return here (LCP-101). Default true. */
  readonly returnTarget?: boolean;
};

/** An old URL pattern that now lives elsewhere (LCP-105). */
export type LegacyRouteDefinition = { readonly path: string; readonly to: string; readonly params?: Readonly<Record<string, string>> };

/** The routes that play a part the module knows about. */
export type Roles = { readonly home: string; readonly signIn?: string; readonly notFound?: string };

export type DefinitionError =
  | { readonly kind: "InvalidSegment"; readonly route: string; readonly segment: string }
  | { readonly kind: "DuplicateName"; readonly route: string }
  | { readonly kind: "DuplicateParameter"; readonly route: string; readonly parameter: string }
  | { readonly kind: "ReservedName"; readonly route: string; readonly parameter: string }
  | { readonly kind: "InvalidValues"; readonly route: string; readonly parameter: string }
  | { readonly kind: "InvalidDefault"; readonly route: string; readonly parameter: string }
  | { readonly kind: "RequiredWithDefault"; readonly route: string; readonly parameter: string }
  | { readonly kind: "UnknownTarget"; readonly route: string; readonly target: string }
  | { readonly kind: "UnknownParameter"; readonly route: string; readonly parameter: string }
  | { readonly kind: "UnknownRole"; readonly role: string; readonly route: string };

// ---------------------------------------------------------------------------
// The validated table
// ---------------------------------------------------------------------------

export type Segment =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "param"; readonly name: string; readonly param: Kind }
  | { readonly kind: "wildcard"; readonly name: string };

type Template = { readonly from: string } | { readonly literal: string };

export type QueryParam = { readonly name: string; readonly param: Kind; readonly required: boolean; readonly default: RouteValue | null };

export type Route = {
  readonly name: string;
  readonly path: readonly Segment[];
  readonly query: readonly QueryParam[];
  readonly children: readonly Route[];
  readonly redirect: { readonly to: string; readonly params: readonly (readonly [string, Template])[] } | null;
  readonly guard: string | null;
  readonly requires: readonly string[];
  readonly returnTarget: boolean;
};

/** A validated table, built only by defineRoutes. */
export type RouteTable = {
  readonly kind: "RouteTable";
  /** The routes as matched: the table's own, with the legacy entries before the first top-level wildcard. */
  readonly routes: readonly Route[];
  readonly roles: Roles;
};

const full = (prefix: string, name: string): string => (prefix === "" ? name : `${prefix}.${name}`);

const PATH_TYPES: Readonly<Record<string, ParamType>> = { string: "string", int: "int", date: "date", month: "month" };

const parseKind = (text: string): Kind | null => {
  const colon = text.indexOf(":");
  const head = colon < 0 ? text : text.slice(0, colon);
  const rest = colon < 0 ? null : text.slice(colon + 1);
  if (rest === null) {
    const type = Object.hasOwn(PATH_TYPES, head) ? PATH_TYPES[head] : undefined;
    return type === undefined ? null : { type, values: [] };
  }
  return head === "enum" && rest !== "" ? { type: "enum", values: rest.split("|") } : null;
};

const parseSegment = (text: string): Segment | null => {
  if (text.startsWith("{*") && text.endsWith("}") && text.length > 3) return { kind: "wildcard", name: text.slice(2, -1) };
  if (text.startsWith("{") && text.endsWith("}")) {
    const body = text.slice(1, -1);
    const colon = body.indexOf(":");
    if (colon < 0) return body === "" ? null : { kind: "param", name: body, param: { type: "string", values: [] } };
    const param = parseKind(body.slice(colon + 1));
    return param !== null && colon > 0 ? { kind: "param", name: body.slice(0, colon), param } : null;
  }
  return text.includes("{") || text.includes("}") ? null : { kind: "literal", text };
};

/** "invoices/{id:int}" → segments, or the first segment that does not parse. "" is an index. */
const parsePath = (text: string): Result<readonly Segment[], string> => {
  const segments: Segment[] = [];
  for (const piece of text.split("/").filter((part) => part !== "")) {
    const segment = parseSegment(piece);
    if (segment === null) return fail(piece);
    segments.push(segment);
  }
  return ok(segments);
};

const templates = (params: Readonly<Record<string, string>> | undefined): readonly (readonly [string, Template])[] =>
  Object.entries(params ?? {}).map(([key, value]): readonly [string, Template] =>
    [key, value.startsWith("{") && value.endsWith("}") ? { from: value.slice(1, -1) } : { literal: value }]);

/** A default given as text for a date or month parameter is that date or month. */
const typedDefault = (type: ParamType, value: RouteValue): RouteValue =>
  typeof value === "string" && type === "date" ? { date: value } : typeof value === "string" && type === "month" ? { month: value } : value;

const KNOWN_TYPES: readonly string[] = ["string", "int", "bool", "date", "month", "enum", "set"];

type Compiled = { readonly route: Route; readonly errors: readonly DefinitionError[] };

const compile = (prefix: string, definition: RouteDefinition): Compiled => {
  const name = full(prefix, definition.name);
  const parsed = parsePath(definition.path);
  const children = (definition.children ?? []).map((child) => compile(name, child));
  const query = (definition.query ?? []).map((parameter): QueryParam => ({
    name: parameter.name,
    param: { type: KNOWN_TYPES.includes(parameter.type) ? parameter.type : "string", values: parameter.values ?? [] },
    required: parameter.required ?? false,
    default: parameter.default === undefined ? null : typedDefault(parameter.type, parameter.default),
  }));
  const unknownTypes = (definition.query ?? [])
    .filter((parameter) => !KNOWN_TYPES.includes(parameter.type))
    .map((parameter): DefinitionError => ({ kind: "InvalidValues", route: name, parameter: parameter.name }));
  return {
    route: {
      name: definition.name,
      path: parsed.ok ? parsed.value : [],
      query,
      children: children.map((child) => child.route),
      redirect: definition.redirect === undefined ? null : { to: definition.redirect.to, params: templates(definition.redirect.params) },
      guard: definition.guard ?? null,
      requires: definition.requires ?? [],
      returnTarget: definition.returnTarget ?? true,
    },
    errors: [...(parsed.ok ? [] : [{ kind: "InvalidSegment", route: name, segment: parsed.error } satisfies DefinitionError]), ...unknownTypes, ...children.flatMap((child) => child.errors)],
  };
};

/** The chain of a destination's full name: [full name, route] per level; null when it is not a destination. */
export const chainOf = (routes: readonly Route[], fullName: string): readonly (readonly [string, Route])[] | null => {
  const walk = (level: readonly Route[], names: readonly string[], prefix: string, acc: readonly (readonly [string, Route])[]): readonly (readonly [string, Route])[] | null => {
    const [name, ...rest] = names;
    if (name === undefined) return null;
    const route = level.find((candidate) => candidate.name === name);
    if (route === undefined) return null;
    const chain = [...acc, [full(prefix, name), route] as const];
    return rest.length === 0 ? (route.children.length === 0 ? chain : null) : walk(route.children, rest, full(prefix, name), chain);
  };
  return walk(routes, fullName.split("."), "", []);
};

const RESERVED: readonly string[] = [
  "token", "accesstoken", "idtoken", "refreshtoken", "password", "passwd", "secret", "clientsecret", "apikey", "key",
  "session", "sessionid", "auth", "authorization", "code", "credential", "credentials",
];

/** Whether a parameter name is reserved for credentials (LCP-109): compared lower-case, without - and _. */
export const isReservedName = (name: string): boolean => RESERVED.includes(name.toLowerCase().replace(/[-_]/g, ""));

const pathParams = (route: Route): readonly (readonly [string, Kind | null])[] =>
  route.path.flatMap((segment): readonly (readonly [string, Kind | null])[] =>
    segment.kind === "param" ? [[segment.name, segment.param]] : segment.kind === "wildcard" ? [[segment.name, null]] : []);

const valuesProblem = (kind: Kind): boolean =>
  (kind.type === "enum" && kind.values.length === 0)
  || ((kind.type === "enum" || kind.type === "set") && (kind.values.includes("") || distinct(kind.values).length !== kind.values.length));

const check = (table: readonly Route[], prefix: string, inherited: readonly string[], routes: readonly Route[]): readonly DefinitionError[] => {
  const names = routes.map((route) => route.name);
  const duplicates = distinct(names)
    .filter((name) => names.filter((other) => other === name).length > 1)
    .map((name): DefinitionError => ({ kind: "DuplicateName", route: full(prefix, name) }));

  const perRoute = (route: Route): readonly DefinitionError[] => {
    const name = full(prefix, route.name);
    const last = route.path.length - 1;
    const segmentErrors = route.path.flatMap((segment, index): readonly DefinitionError[] =>
      segment.kind === "wildcard" && (index !== last || route.children.length > 0) ? [{ kind: "InvalidSegment", route: name, segment: `{*${segment.name}}` }] : []);
    const local = [...pathParams(route).map(([parameter]) => parameter), ...route.query.map((parameter) => parameter.name)];
    const duplicateParams = local.flatMap((parameter, index): readonly DefinitionError[] =>
      inherited.includes(parameter) || local.slice(0, index).includes(parameter) ? [{ kind: "DuplicateParameter", route: name, parameter }] : []);
    const reservedNames = local.filter(isReservedName).map((parameter): DefinitionError => ({ kind: "ReservedName", route: name, parameter }));
    const pathTypes = pathParams(route).flatMap(([parameter, kind]): readonly DefinitionError[] =>
      kind !== null && (kind.type === "bool" || kind.type === "set" || valuesProblem(kind)) ? [{ kind: "InvalidValues", route: name, parameter }] : []);
    const queryErrors = route.query.flatMap((parameter): readonly DefinitionError[] => [
      ...(valuesProblem(parameter.param) ? [{ kind: "InvalidValues", route: name, parameter: parameter.name } as const] : []),
      ...(parameter.default !== null && parameter.required ? [{ kind: "RequiredWithDefault", route: name, parameter: parameter.name } as const]
        : parameter.default !== null && render(parameter.param, parameter.default) === null ? [{ kind: "InvalidDefault", route: name, parameter: parameter.name } as const]
        : []),
    ]);
    const sources = pathParams(route).map(([parameter]) => parameter);
    const redirectErrors: readonly DefinitionError[] = route.redirect === null ? [] : [
      ...(chainOf(table, route.redirect.to) === null ? [{ kind: "UnknownTarget", route: name, target: route.redirect.to } as const] : []),
      ...route.redirect.params.flatMap(([, template]): readonly DefinitionError[] =>
        "from" in template && !sources.includes(template.from) ? [{ kind: "UnknownParameter", route: name, parameter: template.from }] : []),
    ];
    return [...segmentErrors, ...duplicateParams, ...reservedNames, ...pathTypes, ...queryErrors, ...redirectErrors, ...check(table, name, [...inherited, ...local], route.children)];
  };

  return [...duplicates, ...routes.flatMap(perRoute)];
};

/** Legacy entries are matched after every current route and before the first top-level wildcard. */
const withLegacy = (routes: readonly Route[], legacy: readonly Route[]): readonly Route[] => {
  const isWildcard = (route: Route): boolean => route.path[0]?.kind === "wildcard";
  const split = routes.findIndex(isWildcard);
  return split < 0 ? [...routes, ...legacy] : [...routes.slice(0, split), ...legacy, ...routes.slice(split)];
};

/**
 * A validated table, or every problem found (LCP-090), in the order of
 * conformance/routing/README.md: per route, depth first, then legacy entries,
 * then roles. Never throws.
 */
export const defineRoutes = (definition: {
  readonly routes: readonly RouteDefinition[];
  readonly legacy?: readonly LegacyRouteDefinition[];
  readonly roles: Roles;
}): Result<RouteTable, readonly DefinitionError[]> => {
  const compiled = definition.routes.map((route) => compile("", route));
  const parseErrors = compiled.flatMap((route) => route.errors);
  const routes = compiled.map((route) => route.route);
  const legacy = (definition.legacy ?? []).map((entry, index) =>
    compile("", { name: `legacy-${String(index + 1)}`, path: entry.path, returnTarget: false, redirect: { to: entry.to, ...(entry.params === undefined ? {} : { params: entry.params }) } }));
  const legacyErrors = legacy.flatMap((entry) => entry.errors);
  const matching = withLegacy(routes, legacy.filter((entry) => entry.errors.length === 0).map((entry) => entry.route));
  const isDestination = (name: string): boolean => {
    const chain = chainOf(routes, name);
    return chain !== null && chain[chain.length - 1]?.[1].redirect === null;
  };
  const { home, signIn, notFound } = definition.roles;
  const roleErrors: readonly DefinitionError[] = [
    ...(isDestination(home) ? [] : [{ kind: "UnknownRole", role: "home", route: home } as const]),
    ...(signIn === undefined || isDestination(signIn) ? [] : [{ kind: "UnknownRole", role: "signIn", route: signIn } as const]),
    ...(notFound === undefined || isDestination(notFound) ? [] : [{ kind: "UnknownRole", role: "notFound", route: notFound } as const]),
  ];
  const errors = [...parseErrors, ...check(matching, "", [], matching), ...legacyErrors, ...roleErrors];
  return errors.length === 0 ? ok({ kind: "RouteTable", routes: matching, roles: definition.roles }) : fail(errors);
};

/** Every destination's full name with its route, in table order (legacy entries included). */
export const destinations = (table: RouteTable): readonly (readonly [string, Route])[] => {
  const walk = (prefix: string, routes: readonly Route[]): readonly (readonly [string, Route])[] =>
    routes.flatMap((route) => (route.children.length === 0 ? [[full(prefix, route.name), route] as const] : walk(full(prefix, route.name), route.children)));
  return walk("", table.routes);
};

// ---------------------------------------------------------------------------
// Resolving and building
// ---------------------------------------------------------------------------

export type Params = Readonly<Record<string, RouteValue>>;

export type Level = { readonly route: string; readonly params: Params };

export type RouteMatch = {
  readonly route: string;
  readonly chain: readonly Level[];
  readonly query: Params;
  readonly requires: readonly string[];
  readonly redirectedFrom: readonly string[];
};

export type Resolution =
  | ({ readonly kind: "Matched" } & RouteMatch)
  | { readonly kind: "NotFound" }
  | { readonly kind: "MalformedPath" }
  | { readonly kind: "MalformedQuery" }
  | { readonly kind: "TooLong" }
  | { readonly kind: "Invalid"; readonly route: string; readonly parameter: string; readonly value: string; readonly expected: string }
  | { readonly kind: "RedirectLoop"; readonly chain: readonly string[] }
  | { readonly kind: "Denied"; readonly route: string };

export type GuardDecision =
  | { readonly kind: "Allow" }
  | { readonly kind: "Deny" }
  | { readonly kind: "Redirect"; readonly route: string; readonly params?: Params; readonly query?: Params };

/** The engine's decision for a named guard. Interface policy, never an authorization boundary. */
export type Guard = (name: string, match: RouteMatch) => GuardDecision;

/** Allows every guard: for checks that must not depend on who is signed in. */
export const allowAll: Guard = () => ({ kind: "Allow" });

export type BuildError =
  | { readonly kind: "UnknownRoute" }
  | { readonly kind: "MissingParameter"; readonly parameter: string }
  | { readonly kind: "InvalidParameter"; readonly parameter: string };

/** Where an application route goes: a destination's full name and its typed values. */
export type Target = { readonly route: string; readonly params?: Params; readonly query?: Params };

const lookup = (values: Params | undefined, key: string): RouteValue | undefined =>
  values !== undefined && Object.hasOwn(values, key) ? values[key] : undefined;

/** As the F# reference's sequence: every result Ok, or the last error in order. */
const sequence = <T, E>(results: readonly Result<T, E>[]): Result<readonly T[], E> => {
  const errors = results.flatMap((result) => (result.ok ? [] : [result.error]));
  const last = errors[errors.length - 1];
  return last === undefined ? ok(results.flatMap((result) => (result.ok ? [result.value] : []))) : fail(last);
};

const buildRoutes = (routes: readonly Route[], target: Target): Result<string, BuildError> => {
  const chain = chainOf(routes, target.route);
  if (chain === null) return fail({ kind: "UnknownRoute" });
  const levels = chain.map(([, route]) => route);

  const segment = (piece: Segment): Result<string, BuildError> => {
    switch (piece.kind) {
      case "literal": {
        const text = percentEncode(piece.text);
        return text === null ? fail({ kind: "InvalidParameter", parameter: piece.text }) : ok(text);
      }
      case "param": {
        const value = lookup(target.params, piece.name);
        if (value === undefined) return fail({ kind: "MissingParameter", parameter: piece.name });
        const text = render(piece.param, value);
        return text === null ? fail({ kind: "InvalidParameter", parameter: piece.name }) : ok(text);
      }
      case "wildcard": {
        const value = lookup(target.params, piece.name);
        if (value === undefined) return ok("");
        if (typeof value !== "string") return fail({ kind: "InvalidParameter", parameter: piece.name });
        const pieces = value.split("/").filter((part) => part !== "").map(percentEncode);
        const encoded = pieces.filter((part): part is string => part !== null);
        return encoded.length === pieces.length ? ok(encoded.join("/")) : fail({ kind: "InvalidParameter", parameter: piece.name });
      }
    }
  };

  const pair = (declared: QueryParam): readonly Result<string, BuildError>[] => {
    const absent = (): readonly Result<string, BuildError>[] => (declared.required ? [fail({ kind: "MissingParameter", parameter: declared.name })] : []);
    const value = lookup(target.query, declared.name);
    if (value === undefined) return absent();
    const [text, key] = [render(declared.param, value), percentEncode(declared.name)];
    if (text === null || key === null) return [fail({ kind: "InvalidParameter", parameter: declared.name })];
    if (text === "" && declared.param.type === "set") return absent();
    if (declared.default !== null && !declared.required && same(declared.param, declared.default, value)) return [];
    return [ok(`${key}=${text}`)];
  };

  const path = sequence(levels.flatMap((route) => route.path).map(segment));
  const pairs = sequence(levels.flatMap((route) => route.query).flatMap(pair));
  if (!path.ok) return path;
  if (!pairs.ok) return pairs;
  const joined = `/${path.value.filter((piece) => piece !== "").join("/")}`;
  return ok(pairs.value.length === 0 ? joined : `${joined}?${pairs.value.join("&")}`);
};

/** The canonical location ("/path?query") of a destination and its typed values (LCP-092). */
export const build = (table: RouteTable, target: Target): Result<string, BuildError> => buildRoutes(table.routes, target);

const decodePath = (path: string): readonly string[] | null => {
  const pieces = path.split("/").filter((piece) => piece !== "").map((piece) => percentDecode(false, piece));
  const decoded = pieces.filter((piece): piece is string => piece !== null);
  return decoded.length === pieces.length ? decoded : null;
};

type Pair = { readonly key: string; readonly raw: string; readonly decoded: string };

const decodeQuery = (query: string): readonly Pair[] | null => {
  const raw = query.startsWith("?") ? query.slice(1) : query;
  const pairs: Pair[] = [];
  for (const part of raw.split("&").filter((piece) => piece !== "")) {
    const index = part.indexOf("=");
    const [rawKey, value] = index < 0 ? [part, ""] : [part.slice(0, index), part.slice(index + 1)];
    const [key, decoded] = [percentDecode(true, rawKey), percentDecode(true, value)];
    if (key === null || decoded === null) return null;
    pairs.push({ key, raw: value, decoded });
  }
  return pairs;
};

/** "path?query" → [path, query], the query keeping its "?". */
export const splitLocation = (location: string): readonly [string, string] => {
  const index = location.indexOf("?");
  return index < 0 ? [location, ""] : [location.slice(0, index), location.slice(index)];
};

type Binding = { readonly level: string; readonly name: string; readonly param: Kind; readonly raw: string };

const consume = (level: string, pattern: readonly Segment[], segments: readonly string[], bound: readonly Binding[]): readonly [readonly Binding[], readonly string[]] | null => {
  const [head, ...pattern2] = pattern;
  if (head === undefined) return [bound, segments];
  if (head.kind === "wildcard" && pattern2.length === 0) return [[...bound, { level, name: head.name, param: { type: "string", values: [] }, raw: segments.join("/") }], []];
  const [segment, ...rest] = segments;
  if (segment === undefined) return null;
  if (head.kind === "literal" && segment === head.text) return consume(level, pattern2, rest, bound);
  if (head.kind === "param") return consume(level, pattern2, rest, [...bound, { level, name: head.name, param: head.param, raw: segment }]);
  return null;
};

type Structural = readonly [readonly (readonly [string, Route])[], readonly Binding[]];

const matchRoute = (prefix: string, route: Route, segments: readonly string[]): Structural | null => {
  const name = full(prefix, route.name);
  const consumed = consume(name, route.path, segments, []);
  if (consumed === null) return null;
  const [bound, rest] = consumed;
  if (route.children.length === 0) return rest.length === 0 ? [[[name, route]], bound] : null;
  for (const child of route.children) {
    const found = matchRoute(name, child, rest);
    if (found !== null) return [[[name, route], ...found[0]], [...bound, ...found[1]]];
  }
  return null;
};

const matchTable = (routes: readonly Route[], segments: readonly string[]): Structural | null => {
  for (const route of routes) {
    const found = matchRoute("", route, segments);
    if (found !== null) return found;
  }
  return null;
};

type Invalid = Extract<Resolution, { readonly kind: "Invalid" }>;

const invalid = (route: string, parameter: string, value: string, expectedText: string): Invalid =>
  ({ kind: "Invalid", route, parameter, value, expected: expectedText });

type Typed = { readonly level: string; readonly name: string; readonly value: RouteValue };

const typedLevels = (chain: Structural[0], bindings: readonly Binding[]): Result<readonly [readonly Level[], readonly Typed[]], Invalid> => {
  const values: Typed[] = [];
  for (const binding of bindings) {
    const value = convert(binding.param, binding.raw);
    if (value === null) return fail(invalid(binding.level, binding.name, binding.raw, expected(binding.param)));
    values.push({ level: binding.level, name: binding.name, value });
  }
  const levels = chain.map(([name, route]): Level => ({
    route: route.name,
    params: Object.fromEntries(values.filter((typed) => typed.level === name).map((typed) => [typed.name, typed.value])),
  }));
  return ok([levels, values]);
};

const typedQuery = (chain: Structural[0], pairs: readonly Pair[]): Result<Params, Invalid> => {
  const declared = chain.flatMap(([name, route]) => route.query.map((parameter) => [name, parameter] as const));
  const checked = declared.map(([level, parameter]): Result<readonly (readonly [string, RouteValue])[], Invalid> => {
    const given = pairs.filter((pair) => pair.key === parameter.name);
    const [only] = given;
    if (only === undefined) {
      if (parameter.required) return fail(invalid(level, parameter.name, "", `${expected(parameter.param)} (required)`));
      return ok(parameter.default === null ? [] : [[parameter.name, parameter.default]]);
    }
    if (given.length > 1) return fail(invalid(level, parameter.name, given.map((pair) => pair.decoded).join(","), "a single value"));
    const value = parameter.param.type === "set" ? convertSet(parameter.param.values, only.raw) : convert(parameter.param, only.decoded);
    return value === null ? fail(invalid(level, parameter.name, only.decoded, expected(parameter.param))) : ok([[parameter.name, value]]);
  });
  const all = sequence(checked);
  return all.ok ? ok(Object.fromEntries(all.value.flat())) : all;
};

const resolveFrom = (routes: readonly Route[], guard: Guard, visited: readonly string[], path: string, query: string): Resolution => {
  const segments = decodePath(path);
  if (segments === null) return { kind: "MalformedPath" };
  const pairs = decodeQuery(query);
  if (pairs === null) return { kind: "MalformedQuery" };
  const structural = matchTable(routes, segments);
  if (structural === null) return { kind: "NotFound" };
  const [chain, bindings] = structural;
  const typed = typedLevels(chain, bindings);
  if (!typed.ok) return typed.error;
  const [levels, values] = typed.value;
  const [destination, route] = chain[chain.length - 1] ?? ["", undefined];
  if (route === undefined) return { kind: "NotFound" };
  const seen = [...visited, destination];
  if (visited.includes(destination)) return { kind: "RedirectLoop", chain: seen };

  if (route.redirect !== null) {
    const sources = new Map(values.map((value) => [value.name, value.value]));
    const params = Object.fromEntries(route.redirect.params.flatMap(([key, template]): readonly (readonly [string, RouteValue])[] => {
      if ("literal" in template) return [[key, template.literal]];
      const source = sources.get(template.from);
      return source === undefined ? [] : [[key, source]];
    }));
    const built = buildRoutes(routes, { route: route.redirect.to, params });
    return built.ok
      ? resolveFrom(routes, guard, seen, splitLocation(built.value)[0], query)
      : invalid(destination, route.redirect.to, "", "a buildable redirect target");
  }

  const typedQueryResult = typedQuery(chain, pairs);
  if (!typedQueryResult.ok) return typedQueryResult.error;
  const candidate: RouteMatch = {
    route: destination,
    chain: levels,
    query: typedQueryResult.value,
    requires: distinct(chain.flatMap(([, level]) => level.requires)),
    redirectedFrom: visited,
  };
  for (const [name, level] of chain) {
    if (level.guard === null) continue;
    const decision = guard(level.guard, candidate);
    switch (decision.kind) {
      case "Allow": continue;
      case "Deny": return { kind: "Denied", route: name };
      case "Redirect": {
        const built = buildRoutes(routes, { route: decision.route, params: decision.params ?? {}, query: decision.query ?? {} });
        if (!built.ok) return invalid(destination, decision.route, "", "a buildable guard redirect target");
        const [nextPath, nextQuery] = splitLocation(built.value);
        return resolveFrom(routes, guard, seen, nextPath, nextQuery);
      }
    }
  }
  return { kind: "Matched", ...candidate };
};

/**
 * Resolves a routed location ("/path?query", or its two parts). `guard` is
 * the engine's decision for a named guard (default: allow every guard).
 */
export const resolve = (table: RouteTable, location: string | { readonly path: string; readonly query: string }, guard: Guard = allowAll): Resolution => {
  const [path, query] = typeof location === "string" ? splitLocation(location) : [location.path, location.query];
  return path.length + query.length > MAX_LOCATION_LENGTH ? { kind: "TooLong" } : resolveFrom(table.routes, guard, [], path, query);
};

/** The canonical location of a match. */
export const canonical = (table: RouteTable, matched: RouteMatch): Result<string, BuildError> =>
  build(table, { route: matched.route, params: Object.fromEntries(matched.chain.flatMap((level) => Object.entries(level.params))), query: matched.query });

// ---------------------------------------------------------------------------
// Outcomes (LCP-093, LCP-098)
// ---------------------------------------------------------------------------

/** Why a location is not one of the application's routes. Every case has its own view. */
export type RouteError =
  | { readonly kind: "NotFound" }
  | { readonly kind: "NotPermitted"; readonly route: string }
  | { readonly kind: "Invalid"; readonly route: string; readonly parameter: string; readonly value: string; readonly expected: string }
  | { readonly kind: "Malformed"; readonly part: "path" | "query" | "length" }
  | { readonly kind: "RedirectLoop"; readonly chain: readonly string[] }
  /** The application's mapping refused a match. */
  | { readonly kind: "Unmapped"; readonly route: string; readonly problem: string };

/** A resolution as a match or a route error. A match of the table's not-found route is NotFound. */
export const routeOutcome = (table: RouteTable, resolution: Resolution): Result<RouteMatch, RouteError> => {
  switch (resolution.kind) {
    case "Matched": {
      const { kind: _kind, ...matched } = resolution;
      return matched.route === table.roles.notFound ? fail({ kind: "NotFound" }) : ok(matched);
    }
    case "NotFound": return fail({ kind: "NotFound" });
    case "MalformedPath": return fail({ kind: "Malformed", part: "path" });
    case "MalformedQuery": return fail({ kind: "Malformed", part: "query" });
    case "TooLong": return fail({ kind: "Malformed", part: "length" });
    case "Invalid": return fail(resolution);
    case "RedirectLoop": return fail(resolution);
    case "Denied": return fail({ kind: "NotPermitted", route: resolution.route });
  }
};

// ---------------------------------------------------------------------------
// History (LCP-096): adopt, navigate, refine
// ---------------------------------------------------------------------------

/** The engine's navigation state: the location it last adopted, pushed or replaced. */
export type RouterState = { readonly current: string | null };

export const initialRouterState: RouterState = { current: null };

export type NavigationEffect = { readonly kind: "Push"; readonly location: string } | { readonly kind: "Replace"; readonly location: string };

export type Adopted = { readonly state: RouterState; readonly resolution: Resolution; readonly effect: NavigationEffect | null };

export type Moved = { readonly state: RouterState; readonly effect: NavigationEffect | null };

/**
 * A location the browser reported (a deep link in Initialize; Back or Forward
 * in LocationChanged). Never answered with a push: at most a replace that
 * corrects the entry to its canonical form.
 */
export const adopt = (table: RouteTable, state: RouterState, location: string, guard: Guard = allowAll): Adopted => {
  const resolution = resolve(table, location, guard);
  if (resolution.kind !== "Matched") return { state: { current: location }, resolution, effect: null };
  const built = canonical(table, resolution);
  if (!built.ok) return { state: { ...state, current: location }, resolution, effect: null };
  return { state: { current: built.value }, resolution, effect: built.value === location ? null : { kind: "Replace", location: built.value } };
};

const move = (kind: NavigationEffect["kind"]) => (table: RouteTable, state: RouterState, target: Target): Result<Moved, BuildError> => {
  const built = build(table, target);
  if (!built.ok) return built;
  return ok(state.current === built.value ? { state, effect: null } : { state: { current: built.value }, effect: { kind, location: built.value } });
};

/** An in-app navigation to another place: push the built location unless it is already current. */
export const navigate: (table: RouteTable, state: RouterState, target: Target) => Result<Moved, BuildError> = move("Push");

/** An in-place refinement of the current view (a filter, sort, page, tab or date): replace, so Back steps between places. */
export const refine: (table: RouteTable, state: RouterState, target: Target) => Result<Moved, BuildError> = move("Replace");

/** Replace the current entry with a location the engine decided on, such as resumeReturnTo after sign-in. */
export const replaceLocation = (state: RouterState, location: string): Moved =>
  state.current === location ? { state, effect: null } : { state: { current: location }, effect: { kind: "Replace", location } };

// ---------------------------------------------------------------------------
// The typed codec (LCP-093)
// ---------------------------------------------------------------------------

export type RouteCodec<R> = {
  readonly table: RouteTable;
  /** A routed location → the application's route, or the route error to render. */
  readonly parse: (location: string, guard?: Guard) => Result<R, RouteError>;
  /** The application's route → its canonical location. Always ok for a correct mapping. */
  readonly format: (route: R) => Result<string, BuildError>;
  readonly adopt: (state: RouterState, location: string, guard?: Guard) => { readonly state: RouterState; readonly route: Result<R, RouteError>; readonly effect: NavigationEffect | null };
  readonly navigate: (state: RouterState, route: R) => Result<Moved, BuildError>;
  readonly refine: (state: RouterState, route: R) => Result<Moved, BuildError>;
};

/**
 * The table mapped onto the application's own route type: `toTarget` and
 * `ofMatch` are the application's two total functions (ofMatch answers an
 * error text for a match it does not map, which becomes Unmapped).
 */
export const createRouteCodec = <R>(table: RouteTable, mapping: {
  readonly toTarget: (route: R) => Target;
  readonly ofMatch: (matched: RouteMatch) => Result<R, string>;
}): RouteCodec<R> => {
  const typed = (resolution: Resolution): Result<R, RouteError> => {
    const outcome = routeOutcome(table, resolution);
    if (!outcome.ok) return outcome;
    const mapped = mapping.ofMatch(outcome.value);
    return mapped.ok ? mapped : fail({ kind: "Unmapped", route: outcome.value.route, problem: mapped.error });
  };
  return {
    table,
    parse: (location, guard = allowAll) => typed(resolve(table, location, guard)),
    format: (route) => build(table, mapping.toTarget(route)),
    adopt: (state, location, guard = allowAll) => {
      const adopted = adopt(table, state, location, guard);
      return { state: adopted.state, route: typed(adopted.resolution), effect: adopted.effect };
    },
    navigate: (state, route) => navigate(table, state, mapping.toTarget(route)),
    refine: (state, route) => refine(table, state, mapping.toTarget(route)),
  };
};

// ---------------------------------------------------------------------------
// Locations and links (LCP-102, LCP-104, LCP-106)
// ---------------------------------------------------------------------------

/** Where the routed location lives in the browser's URL. "hash" (the default) needs nothing from a static host. */
export type LocationMode = "hash" | "path";

/** The location the kernel reports (Initialize.location, LocationChanged). */
export type PageLocation = { readonly origin: string; readonly path: string; readonly query: string; readonly hash: string };

/** The routed location ("/path?query") of the page's URL. */
export const locationFromBrowser = (page: PageLocation, mode: LocationMode = "hash"): string => {
  if (mode === "path") return (page.path === "" ? "/" : page.path) + page.query;
  const body = page.hash.startsWith("#") ? page.hash.slice(1) : page.hash;
  return body === "" ? "/" : body.startsWith("/") ? body : `/${body}`;
};

/** The relative URL to request with Navigation, or to render as a link's href: "#/x" in hash mode. */
export const hrefFor = (location: string, mode: LocationMode = "hash"): string => (mode === "hash" ? `#${location}` : location);

/** The absolute URL of a canonical location, for "copy link". Write it with the Core Clipboard effect. */
export const shareLink = (page: PageLocation, location: string, mode: LocationMode = "hash"): string =>
  mode === "hash" ? `${page.origin}${page.path}${page.query}#${location}` : `${page.origin}${location}`;

// ---------------------------------------------------------------------------
// Return targets through sign-in (LCP-100, LCP-101)
// ---------------------------------------------------------------------------

/** The query parameter the sign-in route declares for the return target. */
export const RETURN_TO = "returnTo";

/** A single-slash relative location with no backslash or control character: the only shape a return target may have. */
export const isRelativeLocation = (location: string): boolean =>
  location.length > 0 && location.length <= MAX_LOCATION_LENGTH && location.startsWith("/") && !location.startsWith("//")
  && !location.includes("\\") && Array.from(location).every((char) => char >= " " && char !== "\u007f");

const eligible = (table: RouteTable, matched: RouteMatch): boolean => {
  const chain = chainOf(table.routes, matched.route);
  return matched.route !== table.roles.signIn && matched.route !== table.roles.notFound && chain !== null && chain[chain.length - 1]?.[1].returnTarget === true;
};

/**
 * The target to keep for a location that needs sign-in: its canonical form,
 * or null when it may not be returned to. Guards are not consulted here;
 * resumeReturnTo consults them after sign-in.
 */
export const captureReturnTo = (table: RouteTable, location: string): string | null => {
  if (!isRelativeLocation(location)) return null;
  const resolution = resolve(table, location, allowAll);
  if (resolution.kind !== "Matched" || !eligible(table, resolution)) return null;
  const built = canonical(table, resolution);
  return built.ok ? built.value : null;
};

/** The sign-in location carrying the target (#/sign-in?returnTo=…), or UnknownRoute without a sign-in role. */
export const signInLocation = (table: RouteTable, target: string | null): Result<string, BuildError> =>
  table.roles.signIn === undefined
    ? fail({ kind: "UnknownRoute" })
    : build(table, { route: table.roles.signIn, query: target === null ? {} : { [RETURN_TO]: target } });

const homeLocation = (table: RouteTable): string => {
  const built = build(table, { route: table.roles.home });
  return built.ok ? built.value : "/";
};

/**
 * Where to go after sign-in: the target's canonical location when it is still
 * eligible and its guards allow it now; otherwise home. Replace to it, so Back
 * does not return to the sign-in page.
 */
export const resumeReturnTo = (table: RouteTable, target: string | null, guard: Guard = allowAll): string => {
  if (target === null || !isRelativeLocation(target)) return homeLocation(table);
  const resolution = resolve(table, target, guard);
  if (resolution.kind !== "Matched" || !eligible(table, resolution)) return homeLocation(table);
  const built = canonical(table, resolution);
  return built.ok ? built.value : homeLocation(table);
};
