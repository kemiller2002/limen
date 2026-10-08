// The route inventory (LCP-107): echelon.routes/v1, for .echelon/routes.json.
// Byte-identical to the F# library's Inventory.render: keys sorted by UTF-16
// code unit, two-space indentation, a final newline. The writer is spelled out
// (rather than JSON.stringify) so both libraries escape exactly alike.

import { chainOf, destinations, type LocationMode, type Route, type RouteTable, type Segment } from "./routing.js";
import { ordinal } from "./text.js";
import { plain, type Kind, type RouteValue } from "./values.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const escape = (text: string): string => {
  const pieces = Array.from(text, (char): string => {
    switch (char) {
      case "\"": return "\\\"";
      case "\\": return "\\\\";
      case "\b": return "\\b";
      case "\f": return "\\f";
      case "\n": return "\\n";
      case "\r": return "\\r";
      case "\t": return "\\t";
      default: return char < " " ? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : char;
    }
  });
  return `"${pieces.join("")}"`;
};

const write = (indent: string, json: Json): string => {
  const inner = `${indent}  `;
  if (json === null) return "null";
  if (typeof json === "boolean") return json ? "true" : "false";
  if (typeof json === "number") return String(json);
  if (typeof json === "string") return escape(json);
  if (Array.isArray(json)) {
    return json.length === 0 ? "[]" : `[\n${json.map((item: Json) => inner + write(inner, item)).join(",\n")}\n${indent}]`;
  }
  const fields = Object.entries(json).sort(([a], [b]) => ordinal(a, b));
  return fields.length === 0 ? "{}" : `{\n${fields.map(([key, value]) => `${inner}${escape(key)}: ${write(inner, value)}`).join(",\n")}\n${indent}}`;
};

const valueJson = (value: RouteValue): Json => plain(value);

const valuesJson = (kind: Kind): Json => (kind.type === "enum" || (kind.type === "set" && kind.values.length > 0) ? [...kind.values] : null);

const segmentText = (segment: Segment): string =>
  segment.kind === "literal" ? segment.text : segment.kind === "param" ? `{${segment.name}:${segment.param.type}}` : `{*${segment.name}}`;

const pattern = (segments: readonly Segment[]): string => `/${segments.map(segmentText).join("/")}`;

const parameter = (name: string, place: "path" | "query", kind: Kind, required: boolean, fallback: RouteValue | null): Json => ({
  name, in: place, type: kind.type, required, default: fallback === null ? null : valueJson(fallback), values: valuesJson(kind),
});

const STRING: Kind = { type: "string", values: [] };

const chainParams = (chain: readonly (readonly [string, Route])[]): readonly Json[] => [
  ...chain.flatMap(([, route]) => route.path).flatMap((segment): readonly Json[] =>
    segment.kind === "param" ? [parameter(segment.name, "path", segment.param, true, null)]
    : segment.kind === "wildcard" ? [parameter(segment.name, "path", STRING, false, null)]
    : []),
  ...chain.flatMap(([, route]) => route.query).map((declared) => parameter(declared.name, "query", declared.param, declared.required, declared.default)),
];

/** The inventory text for a table: deterministic and byte-identical in every conforming library. */
export const renderRouteInventory = (table: RouteTable, mode: LocationMode = "hash"): string => {
  const { home, signIn, notFound } = table.roles;
  const all = destinations(table);
  const chain = (name: string): readonly (readonly [string, Route])[] => chainOf(table.routes, name) ?? [];
  const segments = (name: string): readonly Segment[] => chain(name).flatMap(([, route]) => route.path);

  const routeJson = ([name, route]: readonly [string, Route]): Json => ({
    name,
    pattern: pattern(segments(name)),
    params: chainParams(chain(name)),
    guards: chain(name).flatMap(([, level]) => (level.guard === null ? [] : [level.guard])),
    requires: [...new Set(chain(name).flatMap(([, level]) => level.requires))],
    returnTarget: route.returnTarget && name !== signIn && name !== notFound,
  });

  const legacyJson = ([name, route]: readonly [string, Route]): Json => ({
    name,
    pattern: pattern(segments(name)),
    to: route.redirect?.to ?? "",
    params: Object.fromEntries((route.redirect?.params ?? []).map(([key, template]) => [key, "from" in template ? `{${template.from}}` : template.literal])),
  });

  const inventory: Json = {
    schema: "echelon.routes/v1",
    mode,
    home,
    signIn: signIn ?? null,
    notFound: notFound ?? null,
    routes: all.filter(([, route]) => route.redirect === null).map(routeJson),
    legacy: all.filter(([, route]) => route.redirect !== null).map(legacyJson),
  };
  return `${write("", inventory)}\n`;
};
