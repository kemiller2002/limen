// Pure rules for how a host registers the store pack (LCP-048, LCP-050):
// the application namespace every database name resolves inside, and the
// serialized-size limits. No browser object is touched here.

import type { Operation, StoreLimits, StoreRequest } from "./generated/store.js";

// What a host passes to storeCapability(options). Registering with options
// selects contract version 2; registering with none keeps version 1.
export type StoreOptions = {
  // The application's namespace on this origin, for example "chrona". Every
  // database the engine names is stored as "<namespace>/<name>".
  readonly namespace: string;
  // Override a default limit, up to its hard maximum.
  readonly limits?: { readonly maxValueBytes?: number; readonly maxTransactionBytes?: number };
};

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: StoreLimits = { maxValueBytes: 1 * MiB, maxTransactionBytes: 8 * MiB };
export const MAX_LIMITS: StoreLimits = { maxValueBytes: 16 * MiB, maxTransactionBytes: 64 * MiB };

// Separates the namespace from the engine's name in the physical database
// name, so it may not appear in either.
export const NAMESPACE_SEPARATOR = "/";

const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const limitProblem = (name: keyof StoreLimits, value: number | undefined): string | undefined =>
  value === undefined || (Number.isInteger(value) && value >= 1 && value <= MAX_LIMITS[name])
    ? undefined
    : `${name} must be an integer from 1 to ${String(MAX_LIMITS[name])}`;

// Everything wrong with the options a host registered, or undefined.
export const storeOptionsProblem = (options: StoreOptions): string | undefined => {
  if (!NAMESPACE.test(options.namespace)) return "namespace must be 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit";
  return limitProblem("maxValueBytes", options.limits?.maxValueBytes) ?? limitProblem("maxTransactionBytes", options.limits?.maxTransactionBytes);
};

export const limitsOf = (options: StoreOptions): StoreLimits => ({
  maxValueBytes: options.limits?.maxValueBytes ?? DEFAULT_LIMITS.maxValueBytes,
  maxTransactionBytes: options.limits?.maxTransactionBytes ?? DEFAULT_LIMITS.maxTransactionBytes,
});

// The name the browser stores, never shown to the engine.
export const physicalName = (namespace: string, database: string): string => `${namespace}${NAMESPACE_SEPARATOR}${database}`;

// A database name an engine may give inside a namespace.
export const databaseNameProblem = (database: string): string | undefined =>
  database.includes(NAMESPACE_SEPARATOR) ? `a database name may not contain "${NAMESPACE_SEPARATOR}" (the namespace separator)` : undefined;

const encoder = new TextEncoder();

// The size the limits measure: bytes of the value's UTF-8 JSON.
export const serializedBytes = (value: unknown): number => encoder.encode(JSON.stringify(value) ?? "").length;

const valueOf = (operation: Operation): unknown => (operation.op === "put" || operation.op === "putIf" ? operation.value : undefined);

// A transaction over its limits, or undefined. Values are measured one by
// one; the transaction as the sum of its operations' JSON.
export const sizeProblem = (request: StoreRequest, limits: StoreLimits): string | undefined => {
  if (request.operation !== "transact") return undefined;
  const oversized = request.operations
    .map((operation, index) => ({ index, value: valueOf(operation) }))
    .filter((entry) => entry.value !== undefined)
    .map((entry) => ({ index: entry.index, bytes: serializedBytes(entry.value) }))
    .find((entry) => entry.bytes > limits.maxValueBytes);
  if (oversized !== undefined) return `operation ${String(oversized.index)} value is ${String(oversized.bytes)} bytes, over the limit of ${String(limits.maxValueBytes)}`;
  const total = request.operations.reduce((sum, operation) => sum + serializedBytes(operation), 0);
  return total > limits.maxTransactionBytes ? `the transaction is ${String(total)} bytes, over the limit of ${String(limits.maxTransactionBytes)}` : undefined;
};
