// Pure rules for the IndexedDB store pack (kemiller2002/limen#28): request
// validation, schema comparison, key paths, JSON equality and abort reasons.
// No browser object is touched here, so every rule is tested without one.

import type { AbortReason, KeyRange, Operation, StoreRequest, StoreSchema } from "./generated/store.js";

export const MAX_QUERY_LIMIT = 1000;

// A valid IndexedDB key, as JSON can carry one: a string, a finite number, or
// a list of keys.
export const isKey = (value: unknown): boolean =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || (Array.isArray(value) && value.every(isKey));

// The value at a dotted key path, or undefined.
export const atKeyPath = (value: unknown, keyPath: string): unknown =>
  keyPath.split(".").reduce<unknown>((current, segment) => (typeof current === "object" && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>)[segment] : undefined), value);

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

const schemaProblem = (stores: readonly StoreSchema[]): string | undefined => {
  const repeated = duplicates(stores.map((store) => store.name));
  if (repeated.length > 0) return `store ${repeated[0]} is declared twice`;
  const bad = stores.find((store) => store.name === "" || store.keyPath === "");
  if (bad !== undefined) return "a store needs a name and a keyPath";
  const store = stores.find((candidate) => duplicates(candidate.indexes.map((index) => index.name)).length > 0 || candidate.indexes.some((index) => index.name === "" || index.keyPath === ""));
  return store === undefined ? undefined : `store ${store.name} has an unnamed, pathless or repeated index`;
};

const rangeProblem = (range: KeyRange | undefined): string | undefined => {
  if (range === undefined) return undefined;
  if (range.lower !== undefined && !isKey(range.lower)) return "a range bound is not a valid key";
  if (range.upper !== undefined && !isKey(range.upper)) return "a range bound is not a valid key";
  return range.lower === undefined && range.upper === undefined ? "a range needs a lower or an upper bound" : undefined;
};

const operationProblem = (operation: Operation, index: number, readonly: boolean): string | undefined => {
  const writes = operation.op === "put" || operation.op === "putIf" || operation.op === "delete";
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
  }
};

// Everything checkable before touching the database. undefined: valid.
export const requestProblem = (request: StoreRequest): string | undefined => {
  if (request.database === "") return "a database needs a name";
  switch (request.operation) {
    case "open":
      if (!Number.isInteger(request.version) || request.version < 1) return "version must be a positive integer";
      return schemaProblem(request.stores) ?? (request.dropStores.some((name) => request.stores.some((store) => store.name === name)) ? "a store cannot be both declared and dropped" : undefined);
    case "transact":
      if (request.operations.length === 0) return "a transaction needs at least one operation";
      return request.operations.map((operation, index) => operationProblem(operation, index, request.mode === "readonly")).find((problem) => problem !== undefined);
    case "close":
    case "deleteDatabase":
      return undefined;
  }
};

// What a database actually holds, read from it.
export type StoredSchema = StoreSchema;

const indexKey = (index: { readonly keyPath: string; readonly unique: boolean; readonly multiEntry: boolean }): string => `${index.keyPath}|${String(index.unique)}|${String(index.multiEntry)}`;

// Differences between the declared and the stored schema, one line each.
export const schemaProblems = (declared: readonly StoreSchema[], stored: readonly StoredSchema[]): readonly string[] => [
  ...declared.flatMap((store): readonly string[] => {
    const found = stored.find((candidate) => candidate.name === store.name);
    if (found === undefined) return [`store ${store.name} is declared but not stored`];
    return [
      ...(found.keyPath !== store.keyPath ? [`store ${store.name} keyPath is ${found.keyPath}, declared ${store.keyPath}`] : []),
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
