// Typed view parameter values (LCP-091): conversion from and to their
// canonical text. Pure and total.

import { distinct, ordinal, percentDecode, percentEncode } from "./text.js";

/** The parameter types. Path parameters may use string, int, date, month and enum. */
export type ParamType = "string" | "int" | "bool" | "date" | "month" | "enum" | "set";

/**
 * A typed value, in the same JSON shape the conformance vectors use:
 * text (string, enum), an integer within ±(2⁵³−1), a boolean, a set's members,
 * a calendar date `{ date: "YYYY-MM-DD" }` or a period `{ month: "YYYY-MM" }`.
 */
export type RouteValue = string | number | boolean | readonly string[] | { readonly date: string } | { readonly month: string };

/** A parameter's type with the values of an enum or set (empty otherwise). */
export type Kind = { readonly type: ParamType; readonly values: readonly string[] };

export const MAX_SAFE = 9007199254740991;

const isAsciiDigits = (text: string): boolean => /^[0-9]*$/.test(text);

export const parseInt53 = (text: string): number | null => {
  const digits = text.startsWith("-") ? text.slice(1) : text;
  const canonical = text === "0" || (digits.length > 0 && digits.length <= 16 && digits[0] !== "0" && isAsciiDigits(digits));
  if (!canonical) return null;
  const value = Number(text);
  return Math.abs(value) <= MAX_SAFE ? value : null;
};

const daysIn = (year: number, month: number): number =>
  month === 2 ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

export const isDate = (text: string): boolean => {
  if (text.length !== 10 || text[4] !== "-" || text[7] !== "-") return false;
  const [year, month, day] = [text.slice(0, 4), text.slice(5, 7), text.slice(8, 10)];
  if (!isAsciiDigits(year + month + day)) return false;
  const [y, m, d] = [Number(year), Number(month), Number(day)];
  return y >= 1 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
};

export const isMonth = (text: string): boolean => {
  if (text.length !== 7 || text[4] !== "-") return false;
  const [year, month] = [text.slice(0, 4), text.slice(5, 7)];
  if (!isAsciiDigits(year + month)) return false;
  const [y, m] = [Number(year), Number(month)];
  return y >= 1 && m >= 1 && m <= 12;
};

export const expected = (kind: Kind): string =>
  kind.type === "enum" ? `one of ${kind.values.join("|")}`
  : kind.type === "set" ? (kind.values.length === 0 ? "a set of non-empty values" : `a set of ${kind.values.join("|")}`)
  : kind.type;

const members = (values: readonly string[], items: readonly string[]): readonly string[] | null => {
  if (items.some((item) => item === "")) return null;
  if (values.length > 0 && items.some((item) => !values.includes(item))) return null;
  return [...distinct(items)].sort(ordinal);
};

/** A decoded path segment or query value → a typed value (a set from its decoded text). */
export const convert = (kind: Kind, text: string): RouteValue | null => {
  switch (kind.type) {
    case "string": return text;
    case "int": return parseInt53(text);
    case "bool": return text === "true" ? true : text === "false" ? false : null;
    case "date": return isDate(text) ? { date: text } : null;
    case "month": return isMonth(text) ? { month: text } : null;
    case "enum": return kind.values.includes(text) ? text : null;
    case "set": return members(kind.values, text.split(","));
  }
};

/** A set's raw (still encoded) query value: split on ",", then decode each member, so %2C stays inside. */
export const convertSet = (values: readonly string[], raw: string): RouteValue | null => {
  const pieces = raw.split(",").map((piece) => percentDecode(true, piece));
  const decoded = pieces.filter((piece): piece is string => piece !== null);
  return decoded.length === pieces.length ? members(values, decoded) : null;
};

const isStringArray = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

const dateOf = (value: RouteValue): string | null =>
  typeof value === "object" && !Array.isArray(value) && "date" in value && typeof value.date === "string" && isDate(value.date) ? value.date : null;

const monthOf = (value: RouteValue): string | null =>
  typeof value === "object" && !Array.isArray(value) && "month" in value && typeof value.month === "string" && isMonth(value.month) ? value.month : null;

/** A value → its canonical, percent-encoded text, or null when it is not a value of that type. An empty set is "". */
export const render = (kind: Kind, value: RouteValue): string | null => {
  switch (kind.type) {
    case "string": return typeof value === "string" ? percentEncode(value) : null;
    case "int":
      if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
      return typeof value === "string" && parseInt53(value) !== null ? value : null;
    case "bool": return typeof value === "boolean" ? (value ? "true" : "false") : null;
    case "date": return dateOf(value);
    case "month": return monthOf(value);
    case "enum": return typeof value === "string" && kind.values.includes(value) ? percentEncode(value) : null;
    case "set": {
      if (!isStringArray(value)) return null;
      const sorted = members(kind.values, value);
      if (sorted === null) return null;
      const pieces = sorted.map(percentEncode);
      const encoded = pieces.filter((piece): piece is string => piece !== null);
      return encoded.length === pieces.length ? encoded.join(",") : null;
    }
  }
};

/** Whether two values of one type have the same canonical text. */
export const same = (kind: Kind, a: RouteValue, b: RouteValue): boolean => {
  const [x, y] = [render(kind, a), render(kind, b)];
  return x !== null && y !== null && x === y;
};

/** A value as plain JSON for the route inventory: dates and months as their text, sets sorted. */
export const plain = (value: RouteValue): string | number | boolean | readonly string[] => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (isStringArray(value)) return [...value].sort(ordinal);
  return "date" in value ? value.date : "month" in value ? value.month : "";
};
