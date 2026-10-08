// Pure rules for the IndexedDB store pack (kemiller2002/limen#28): request
// validation, schema comparison, key paths, JSON equality and abort reasons.
// No browser object is touched here, so every rule is tested without one.

import type { AbortReason, IndexSchema, KeyRange, Operation, StoreRequest, StoreSchema } from "./generated/store.js";

export const MAX_QUERY_LIMIT = 1000;

// A valid IndexedDB key, as JSON can carry one: a string, a finite number, or
// a list of keys.
export const isKey = (value: unknown): boolean =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) && value.every(isKey));

// The value at a dotted key path, or undefined.
export const atKeyPath = (value: unknown, keyPath: string): unknown =>
  keyPath.split(".").reduce<unknown>((current, segment) => (typeof current === "object" && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>)[segment] : undefined), value);

// A store's or index's key path as IndexedDB takes it: one dotted path, or a
// compound list of them (LCP-047).
export type KeyPathValue = string | readonly string[];

type Pathed = { readonly keyPath: string; readonly keyPaths?: readonly string[] };

export const declaredKeyPath = (schema: Pathed): KeyPathValue => schema.keyPaths ?? schema.keyPath;

// How a key path is written in a problem: a.b, or [a,b] for a compound one.
export const keyPathLabel = (path: KeyPathValue): string => (typeof path === "string" ? path : `[${path.join(",")}]`);

export const sameKeyPath = (left: KeyPathValue, right: KeyPathValue): boolean => keyPathLabel(left) === keyPathLabel(right) && typeof left === typeof right;

// The schema fields for a key path read back from the browser.
export const pathFields = (path: string | readonly string[] | null): Pathed =>
  typeof path === "string" ? { keyPath: path } : Array.isArray(path) ? { keyPath: "", keyPaths: [...path] } : { keyPath: "" };

// A record's key at a key path: the value at the path, or for a compound path
// the list of values at each. undefined when any part is missing.
export const keyAt = (value: unknown, path: KeyPathValue): unknown => {
  if (typeof path === "string") return atKeyPath(value, path);
  const parts = path.map((part) => atKeyPath(value, part));
  return parts.every((part) => part !== undefined) ? parts : undefined;
};

export const jsonEqual = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]));
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return jsonEqual(leftKeys, rightKeys) && leftKeys.every((key) => jsonEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
};

export const abortReason = (errorName: string): AbortReason => {
  switch (errorName) {
    case "QuotaExceededError": return "quota";
    case "ConstraintError": return "constraint";
    case "DataError": return "invalidKey";
    case "NotFoundError": return "unknownStore";
    default: return "other";
  }
};

const duplicates = (names: readonly string[]): readonly string[] => names.filter((name, index) => names.indexOf(name) !== index);

// Exactly one of keyPath and keyPaths; a compound path has two or more
// non-empty parts.
const pathed = (schema: Pathed): boolean =>
  schema.keyPaths === undefined ? schema.keyPath !== "" : schema.keyPath === "" && schema.keyPaths.length >= 2 && schema.keyPaths.every((part) => part !== "");

const indexProblem = (store: StoreSchema, index: IndexSchema): string | undefined =>
  index.keyPaths !== undefined && index.multiEntry ? `index ${store.name}.${index.name} is compound and multiEntry; IndexedDB allows only one` : undefined;

const schemaProblem = (stores: readonly StoreSchema[]): string | undefined => {
  const repeated = duplicates(stores.map((store) => store.name));
  if (repeated.length > 0) return `store ${repeated[0]} is declared twice`;
  const bad = stores.find((store) => store.name === "" || !pathed(store));
  if (bad !== undefined) return bad.keyPaths === undefined ? "a store needs a name and a keyPath" : `store ${bad.name} needs two or more non-empty keyPaths, and an empty keyPath`;
  const store = stores.find((candidate) => duplicates(candidate.indexes.map((index) => index.name)).length > 0 || candidate.indexes.some((index) => index.name === "" || !pathed(index)));
  if (store !== undefined) return `store ${store.name} has an unnamed, pathless or repeated index`;
  return stores.flatMap((candidate) => candidate.indexes.map((index) => indexProblem(candidate, index))).find((problem) => problem !== undefined);
};

const rangeProblem = (range: KeyRange | undefined): string | undefined => {
  if (range === undefined) return undefined;
  if (range.lower !== undefined && !isKey(range.lower)) return "a range bound is not a valid key";
  if (range.upper !== undefined && !isKey(range.upper)) return "a range bound is not a valid key";
  return range.lower === undefined && range.upper === undefined ? "a range needs a lower or an upper bound" : undefined;
};

const operationProblem = (operation: Operation, index: number, readonly: boolean): string | undefined => {
  const writes = operation.op === "put" || operation.op === "putIf" || operation.op === "delete" || operation.op === "deleteRange";
  if (readonly && writes) return `operation ${index} writes in a readonly transaction`;
  switch (operation.op) {
    case "get":
    case "delete":
      return isKey(operation.key) ? undefined : `operation ${index} has an invalid key`;
    case "put":
    case "putIf":
      return typeof operation.value === "object" && operation.value !== null && !Array.isArray(operation.value) ? undefined : `operation ${index} value is not a record`;
    case "query":
      if (!Number.isInteger(operation.limit) || operation.limit < 1 || operation.limit > MAX_QUERY_LIMIT) return `operation ${index} limit must be 1 to ${MAX_QUERY_LIMIT}`;
      return rangeProblem(operation.range);
    case "count":
    case "deleteRange":
      return rangeProblem(operation.range);
  }
};

// Whether a request uses anything version 2 added, which a version 1
// registration refuses as malformed, as 0.7.x's decoder did.
export const usesVersion2 = (request: StoreRequest): boolean => {
  switch (request.operation) {
    case "open":
      return request.stores.some((store) => store.keyPaths !== undefined || store.indexes.some((index) => index.keyPaths !== undefined));
    case "transact":
      return request.operations.some((operation) => operation.op === "count" || operation.op === "deleteRange");
    case "close":
    case "deleteDatabase":
      return false;
    case "persist":
    case "persisted":
    case "estimate":
    case "availability":
      return true;
  }
};

// The requests about a database, as opposed to the origin's storage.
export type DatabaseRequest = Extract<StoreRequest, { readonly database: string }>;
export const isDatabaseRequest = (request: StoreRequest): request is DatabaseRequest => "database" in request;

// How an open that failed classifies (LCP-064). A SecurityError, or the
// InvalidStateError some private modes give, means storage is refused here.
export const availabilityOf = (errorName: string): "Refused" | "Broken" =>
  errorName === "SecurityError" || errorName === "InvalidStateError" ? "Refused" : "Broken";

// A byte count the browser reported, or undefined when it did not.
export const byteCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

// Everything checkable before touching the database. undefined: valid.
export const requestProblem = (request: StoreRequest): string | undefined => {
  if (isDatabaseRequest(request) && request.database === "") return "a database needs a name";
  switch (request.operation) {
    case "open":
      if (!Number.isInteger(request.version) || request.version < 1) return "version must be a positive integer";
      return schemaProblem(request.stores) ?? (request.dropStores.some((name) => request.stores.some((store) => store.name === name)) ? "a store cannot be both declared and dropped" : undefined);
    case "transact":
      if (request.operations.length === 0) return "a transaction needs at least one operation";
      return request.operations.map((operation, index) => operationProblem(operation, index, request.mode === "readonly")).find((problem) => problem !== undefined);
    case "close":
    case "deleteDatabase":
    case "persist":
    case "persisted":
    case "estimate":
    case "availability":
      return undefined;
  }
};

// What a database actually holds, read from it.
export type StoredSchema = StoreSchema;

const indexKey = (index: IndexSchema): string => `${keyPathLabel(declaredKeyPath(index))}|${typeof declaredKeyPath(index)}|${String(index.unique)}|${String(index.multiEntry)}`;

// Differences between the declared and the stored schema, one line each.
export const schemaProblems = (declared: readonly StoreSchema[], stored: readonly StoredSchema[]): readonly string[] => [
  ...declared.flatMap((store): readonly string[] => {
    const found = stored.find((candidate) => candidate.name === store.name);
    if (found === undefined) return [`store ${store.name} is declared but not stored`];
    return [
      ...(sameKeyPath(declaredKeyPath(found), declaredKeyPath(store)) ? [] : [`store ${store.name} keyPath is ${keyPathLabel(declaredKeyPath(found))}, declared ${keyPathLabel(declaredKeyPath(store))}`]),
      ...store.indexes.flatMap((index): readonly string[] => {
        const existing = found.indexes.find((candidate) => candidate.name === index.name);
        if (existing === undefined) return [`index ${store.name}.${index.name} is declared but not stored`];
        return indexKey(existing) === indexKey(index) ? [] : [`index ${store.name}.${index.name} differs from its declaration`];
      }),
      ...found.indexes.filter((index) => !store.indexes.some((candidate) => candidate.name === index.name)).map((index) => `index ${store.name}.${index.name} is stored but not declared`),
    ];
  }),
  ...stored.filter((store) => !declared.some((candidate) => candidate.name === store.name)).map((store) => `store ${store.name} is stored but not declared`),
];

// The stores a transaction touches, each once, in first-use order.
export const storesOf = (operations: readonly Operation[]): readonly string[] =>
  operations.map((operation) => operation.store).filter((name, index, names) => names.indexOf(name) === index);
