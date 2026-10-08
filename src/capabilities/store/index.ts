// The IndexedDB structured-storage capability pack (kemiller2002/limen#28,
// LCP-018).
//
// The engine declares each database's version, stores and indexes. The pack
// creates what is declared, drops only the stores the engine names, and
// reports every other difference as a typed outcome rather than repairing it.
// A transaction is one atomic batch of operations: Committed with every
// result, or Aborted with the operation that failed, and nothing applied.
// putIf is a mechanical compare-and-put, the guard against a stale write from
// another tab; what a record means, and how data migrates, is the engine's.
//
// Optional: nothing in Core imports this module, and Core's Storage effects
// (localStorage) are unchanged.
//
// Two contract versions (LCP-043). storeCapability(options) registers the
// pack inside an application namespace with serialized-size limits and offers
// limen.store version 2. storeCapability() with no options offers version 1
// with 0.7.x's fingerprint and behaviour, so engines built against 0.7.x keep
// negotiating. Version 2 is additive: every version 1 request means the same.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type AbortReason, type KeyRange, type Operation, type OperationResult, type StoreFact, type StoreLimits, type StoreRequest, type StoreResult, type StoreSchema } from "./generated/store.js";
import { decodeStoreRequest } from "./generated/store.codec.js";
import { abortReason, availabilityOf, byteCount, declaredKeyPath, isDatabaseRequest, isKey, jsonEqual, keyAt, keyPathLabel, pathFields, requestProblem, sameKeyPath, schemaProblems, storesOf, usesVersion2, type DatabaseRequest, type StoredSchema } from "./schema.js";
import { databaseNameProblem, limitsOf, physicalName, sizeProblem, storeOptionsProblem, type StoreOptions } from "./options.js";
import { STORE_CAPABILITY_V1 } from "./v1.js";

// STORE_CAPABILITY is version 1, what 0.7.x engines select; an engine that
// uses version 2 selects STORE_CAPABILITY_V2 and its host registers the pack
// with options.
export { STORE_CAPABILITY_V1 as STORE_CAPABILITY, STORE_CAPABILITY_V1 } from "./v1.js";
export { CAPABILITY_OFFER as STORE_CAPABILITY_V2 } from "./generated/store.js";
export type { AbortReason, IndexSchema, KeyRange, Operation, OperationResult, StoreFact, StoreLimits, StoreRequest, StoreResult, StoreSchema, TransactionMode } from "./generated/store.js";
export { decodeStoreFact, decodeStoreRequest, decodeStoreResult } from "./generated/store.codec.js";
export { MAX_QUERY_LIMIT, isKey, jsonEqual, requestProblem, schemaProblems } from "./schema.js";
export { DEFAULT_LIMITS, MAX_LIMITS, NAMESPACE_SEPARATOR, serializedBytes, storeOptionsProblem, type StoreOptions } from "./options.js";

// The document's own window, with its constructors (indexedDB, IDBKeyRange).
type View = Window & typeof globalThis;

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "unknown";

// A promise with one answer: later settlements are ignored.
const once = <T>(start: (settle: (value: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve) => {
    const state = { settled: false };
    start((value) => {
      if (state.settled) return;
      state.settled = true;
      resolve(value);
    });
  });

// What an open database holds, read from its stores (inside the upgrade
// transaction, or a short readonly one).
const storedSchema = (database: IDBDatabase, transaction: IDBTransaction): readonly StoredSchema[] =>
  Array.from(database.objectStoreNames, (name): StoredSchema => {
    const store = transaction.objectStore(name);
    return {
      name,
      ...pathFields(store.keyPath),
      indexes: Array.from(store.indexNames, (indexName) => {
        const index = store.index(indexName);
        return { name: indexName, ...pathFields(index.keyPath), unique: index.unique, multiEntry: index.multiEntry };
      }),
    };
  });

// IndexedDB takes a compound key path as a mutable array.
const idbPath = (path: string | readonly string[]): string | string[] => (typeof path === "string" ? path : [...path]);

// The upgrade: create what is declared and missing, rebuild an index whose
// definition changed, drop what the engine named. A store whose keyPath
// changed cannot be altered in place; that is a mismatch for the engine.
const upgrade = (database: IDBDatabase, transaction: IDBTransaction, stores: readonly StoreSchema[], dropStores: readonly string[]): readonly string[] => {
  dropStores.filter((name) => database.objectStoreNames.contains(name)).forEach((name) => database.deleteObjectStore(name));
  return stores.flatMap((declared): readonly string[] => {
    const exists = database.objectStoreNames.contains(declared.name);
    const store = exists ? transaction.objectStore(declared.name) : database.createObjectStore(declared.name, { keyPath: idbPath(declaredKeyPath(declared)) });
    const stored = declaredKeyPath(pathFields(store.keyPath));
    if (!sameKeyPath(stored, declaredKeyPath(declared))) return [`store ${declared.name} keyPath is ${keyPathLabel(stored)}, declared ${keyPathLabel(declaredKeyPath(declared))}; drop it to change it`];
    declared.indexes.forEach((index) => {
      const existing = store.indexNames.contains(index.name) ? store.index(index.name) : undefined;
      const same = existing !== undefined && sameKeyPath(declaredKeyPath(pathFields(existing.keyPath)), declaredKeyPath(index)) && existing.unique === index.unique && existing.multiEntry === index.multiEntry;
      if (same) return;
      if (existing !== undefined) store.deleteIndex(index.name);
      store.createIndex(index.name, idbPath(declaredKeyPath(index)), { unique: index.unique, multiEntry: index.multiEntry });
    });
    return [];
  });
};

const keyRange = (view: View, range: KeyRange | undefined): IDBKeyRange | undefined => {
  if (range === undefined) return undefined;
  if (range.lower !== undefined && range.upper !== undefined) return view.IDBKeyRange.bound(range.lower, range.upper, range.lowerOpen, range.upperOpen);
  return range.lower !== undefined ? view.IDBKeyRange.lowerBound(range.lower, range.lowerOpen) : view.IDBKeyRange.upperBound(range.upper, range.upperOpen);
};

type Failure = { readonly reason: AbortReason; readonly operation?: number; readonly current?: unknown };

// What one registration of the pack is: its contract version, and for
// version 2 the namespace and limits.
type Registration =
  | { readonly kind: "v1" }
  | { readonly kind: "v2"; readonly namespace: string; readonly limits: StoreLimits }
  | { readonly kind: "invalid"; readonly problem: string };

const registrationOf = (options: StoreOptions | undefined): Registration => {
  if (options === undefined) return { kind: "v1" };
  const problem = storeOptionsProblem(options);
  return problem === undefined ? { kind: "v2", namespace: options.namespace, limits: limitsOf(options) } : { kind: "invalid", problem };
};

// Version 2 checks, before the database is touched: names inside the
// namespace, and the size limits.
const registrationProblem = (registration: Registration, request: StoreRequest): string | undefined => {
  switch (registration.kind) {
    case "v1": return undefined;
    case "invalid": return `the host registered the store pack with invalid options: ${registration.problem}`;
    case "v2": return (isDatabaseRequest(request) ? databaseNameProblem(request.database) : undefined) ?? sizeProblem(request, registration.limits);
  }
};

// Version 1's decoder: what 0.7.x accepted, and nothing version 2 added.
const decodeVersion1 = (value: unknown, path?: string): ReturnType<typeof decodeStoreRequest> => {
  const decoded = decodeStoreRequest(value, path);
  return decoded.ok && usesVersion2(decoded.value) ? { ok: false, error: { path: path ?? "$", expected: "a limen.store version 1 request", found: "a version 2 field or operation" } } : decoded;
};

export const storeCapability = (options?: StoreOptions): CapabilityProvider => {
  const registration = registrationOf(options);
  // The engine's database name, as the browser stores it.
  const physical = (name: string): string => (registration.kind === "v2" ? physicalName(registration.namespace, name) : name);
  const limits = registration.kind === "v2" ? { limits: registration.limits } : {};
  // Owned by this provider instance: its open connections, by database name.
  const connections = new Map<string, IDBDatabase>();
  const wiring: { host?: CapabilityHost<StoreFact> } = {};

  const forget = (name: string): void => {
    connections.get(name)?.close();
    connections.delete(name);
  };

  const keep = (name: string, database: IDBDatabase): void => {
    // Another page upgrading or deleting this database: step aside, say so.
    database.onversionchange = (event) => {
      forget(name);
      wiring.host?.emitFact({ kind: "VersionChanged", database: name, newVersion: event.newVersion ?? 0 });
    };
    // The browser closing it under the page (storage cleared or evicted):
    // forget it, never reopen, say so (version 2 only; LCP-062).
    if (registration.kind === "v2") {
      database.onclose = () => {
        if (connections.get(name) !== database) return;
        connections.delete(name);
        wiring.host?.emitFact({ kind: "ConnectionLost", database: name });
      };
    }
    connections.set(name, database);
  };

  // The stored version of a database that refused an older one.
  const storedVersion = (view: View, name: string): Promise<number> => once((settle) => {
    const request = view.indexedDB.open(physical(name));
    request.onsuccess = () => { settle(request.result.version); request.result.close(); };
    request.onerror = () => settle(0);
  });

  const open = (view: View, request: Extract<StoreRequest, { operation: "open" }>): Promise<StoreResult> => {
    forget(request.database);
    return once<StoreResult>((settle) => {
      const state = { from: request.version, abandoned: false, problems: [] as readonly string[] };
      const opening = view.indexedDB.open(physical(request.database), request.version);
      opening.onupgradeneeded = (event) => {
        const transaction = opening.transaction;
        if (transaction === null) return;
        if (state.abandoned) { transaction.abort(); return; }
        state.from = event.oldVersion;
        state.problems = upgrade(opening.result, transaction, request.stores, request.dropStores);
        if (state.problems.length > 0) transaction.abort();
      };
      opening.onblocked = () => {
        state.abandoned = true;
        settle({ kind: "Blocked" });
      };
      opening.onsuccess = () => {
        const database = opening.result;
        if (state.abandoned) { database.close(); return; }
        const names = Array.from(database.objectStoreNames);
        const problems = names.length === 0 ? schemaProblems(request.stores, []) : schemaProblems(request.stores, storedSchema(database, database.transaction(names, "readonly")));
        if (problems.length > 0) {
          database.close();
          settle({ kind: "SchemaMismatch", problems: [...problems] });
          return;
        }
        keep(request.database, database);
        settle({ kind: "Opened", version: database.version, upgradedFrom: state.from, ...limits, ...(registration.kind === "v2" ? { created: state.from === 0 } : {}) });
      };
      opening.onerror = (event) => {
        event.preventDefault();
        const name = nameOf(opening.error);
        if (name === "VersionError") void storedVersion(view, request.database).then((stored) => settle({ kind: "VersionConflict", stored }));
        else if (name === "AbortError" && state.problems.length > 0) settle({ kind: "SchemaMismatch", problems: [...state.problems] });
        else settle({ kind: "Unavailable", reason: name });
      };
    });
  };

  const transact = (view: View, request: Extract<StoreRequest, { operation: "transact" }>, signal: AbortSignal): Promise<StoreResult> => {
    const database = connections.get(request.database);
    if (database === undefined) return Promise.resolve({ kind: "NotOpen" });
    const stores = storesOf(request.operations);
    const unknown = request.operations.findIndex((operation) => !database.objectStoreNames.contains(operation.store));
    if (unknown >= 0) return Promise.resolve({ kind: "Aborted", reason: "unknownStore", operation: unknown });
    return once<StoreResult>((settle) => {
      const transaction = database.transaction([...stores], request.mode);
      const state: { results: OperationResult[]; failure?: Failure; cancelled: boolean } = { results: [], cancelled: false };
      const fail = (failure: Failure): void => {
        state.failure ??= failure;
        try { transaction.abort(); } catch { /* already finishing */ }
      };
      const cancel = (): void => { state.cancelled = true; fail({ reason: "other" }); };
      signal.addEventListener("abort", cancel, { once: true });

      transaction.oncomplete = () => {
        signal.removeEventListener("abort", cancel);
        settle({ kind: "Committed", results: state.results });
      };
      transaction.onabort = () => {
        signal.removeEventListener("abort", cancel);
        if (state.cancelled) { settle({ kind: "Cancelled" }); return; }
        // No operation failed: the browser aborted the whole transaction at commit.
        const failure = state.failure ?? { reason: abortReason(nameOf(transaction.error)) };
        settle({
          kind: "Aborted", reason: failure.reason,
          ...(failure.operation !== undefined ? { operation: failure.operation } : {}),
          ...(failure.current !== undefined ? { current: failure.current } : {}),
        });
      };

      // Operations run in order, each started from the previous one's success,
      // which keeps the transaction active and the order exact.
      const run = (index: number): void => {
        const operation: Operation | undefined = request.operations[index];
        if (operation === undefined) return;
        const next = (result: OperationResult): void => { state.results.push(result); run(index + 1); };
        const failed = (request: IDBRequest): void => { fail({ reason: abortReason(nameOf(request.error)), operation: index }); };
        const store = transaction.objectStore(operation.store);
        const track = <T>(request: IDBRequest<T>, done: (value: T) => void): void => {
          request.onsuccess = () => done(request.result);
          request.onerror = (event) => { event.preventDefault(); failed(request); };
        };
        switch (operation.op) {
          case "get":
            track(store.get(operation.key as IDBValidKey), (value: unknown) => next(value === undefined ? { kind: "Missing" } : { kind: "Found", value }));
            return;
          case "delete":
            track(store.delete(operation.key as IDBValidKey), () => next({ kind: "Deleted" }));
            return;
          case "put": {
            if (!isKey(keyAt(operation.value, declaredKeyPath(pathFields(store.keyPath))))) { fail({ reason: "invalidKey", operation: index }); return; }
            track(store.put(operation.value), (key) => next({ kind: "Put", key }));
            return;
          }
          case "putIf": {
            const key = keyAt(operation.value, declaredKeyPath(pathFields(store.keyPath)));
            if (!isKey(key)) { fail({ reason: "invalidKey", operation: index }); return; }
            track(store.get(key as IDBValidKey), (current: unknown) => {
              const stored = current === undefined ? null : current;
              if (!jsonEqual(stored, operation.expected)) { fail({ reason: "conflict", operation: index, current: stored }); return; }
              track(store.put(operation.value), (written) => next({ kind: "Put", key: written }));
            });
            return;
          }
          case "query": {
            const source = operation.index === undefined ? store : store.indexNames.contains(operation.index) ? store.index(operation.index) : undefined;
            if (source === undefined) { fail({ reason: "unknownStore", operation: index }); return; }
            const values: unknown[] = [];
            const cursor = source.openCursor(keyRange(view, operation.range), operation.reverse ? "prev" : "next");
            track(cursor, (found) => {
              if (found !== null && values.length < operation.limit) {
                values.push(found.value);
                found.continue();
                return;
              }
              next({ kind: "Queried", values });
            });
            return;
          }
          case "count": {
            const source = operation.index === undefined ? store : store.indexNames.contains(operation.index) ? store.index(operation.index) : undefined;
            if (source === undefined) { fail({ reason: "unknownStore", operation: index }); return; }
            track(source.count(keyRange(view, operation.range)), (count) => next({ kind: "Counted", count }));
            return;
          }
          case "deleteRange": {
            const range = keyRange(view, operation.range);
            track(range === undefined ? store.clear() : store.delete(range), () => next({ kind: "RangeDeleted" }));
            return;
          }
        }
      };
      run(0);
    });
  };

  const deleteDatabase = (view: View, name: string): Promise<StoreResult> => {
    forget(name);
    return once((settle) => {
      const deleting = view.indexedDB.deleteDatabase(physical(name));
      deleting.onsuccess = () => settle({ kind: "DatabaseDeleted" });
      deleting.onblocked = () => settle({ kind: "Blocked" });
      deleting.onerror = () => settle({ kind: "Unavailable", reason: nameOf(deleting.error) });
    });
  };

  // The origin's storage (LCP-061, LCP-063): navigator.storage, asked only
  // when the engine asks. A missing API is Unsupported, never a refusal.
  const storage = async (request: Exclude<StoreRequest, DatabaseRequest>, view: View): Promise<StoreResult> => {
    const manager: Partial<StorageManager> | undefined = view.navigator.storage;
    switch (request.operation) {
      case "persist":
        return typeof manager?.persist === "function" ? { kind: "Persisted", granted: await manager.persist().then((granted) => granted, () => false) } : { kind: "Unsupported" };
      case "persisted":
        return typeof manager?.persisted === "function" ? manager.persisted().then((persistent): StoreResult => ({ kind: "Persistence", persistent }), (): StoreResult => ({ kind: "Unsupported" })) : { kind: "Unsupported" };
      case "estimate": {
        if (typeof manager?.estimate !== "function") return { kind: "Unsupported" };
        const estimate = await manager.estimate().then((value): StorageEstimate | undefined => value, () => undefined);
        if (estimate === undefined) return { kind: "Unsupported" };
        const usage = byteCount(estimate.usage);
        const quota = byteCount(estimate.quota);
        return { kind: "Estimate", ...(usage !== undefined ? { usage } : {}), ...(quota !== undefined ? { quota } : {}) };
      }
      case "availability":
        return availability(view);
    }
  };

  // Available only when a probe database opens and is deleted inside the
  // namespace (LCP-064). Its name, "<namespace>/", is one no engine can give.
  const availability = (view: View): Promise<StoreResult> => {
    if (typeof view.indexedDB !== "object" || view.indexedDB === null) return Promise.resolve({ kind: "Availability", availability: "Missing" });
    const probe = registration.kind === "v2" ? physicalName(registration.namespace, "") : "";
    const refused = (name: string): StoreResult => ({ kind: "Availability", availability: availabilityOf(name), reason: name });
    return once<StoreResult>((settle) => {
      try {
        const opening = view.indexedDB.open(probe);
        opening.onsuccess = () => {
          opening.result.close();
          const deleting = view.indexedDB.deleteDatabase(probe);
          deleting.onsuccess = () => settle({ kind: "Availability", availability: "Available" });
          deleting.onerror = () => settle(refused(nameOf(deleting.error)));
          deleting.onblocked = () => settle({ kind: "Availability", availability: "Available" });
        };
        opening.onerror = (event) => { event.preventDefault(); settle(refused(nameOf(opening.error))); };
      } catch (error) {
        settle(refused(nameOf(error)));
      }
    });
  };

  const perform = async (request: StoreRequest, view: View, signal: AbortSignal): Promise<StoreResult> => {
    const problem = requestProblem(request) ?? registrationProblem(registration, request);
    if (problem !== undefined) return { kind: "InvalidRequest", problem };
    if (!isDatabaseRequest(request)) return storage(request, view).catch((): StoreResult => ({ kind: "Unsupported" }));
    if (typeof view.indexedDB !== "object" || view.indexedDB === null) return { kind: "Unavailable", reason: "unsupported" };
    try {
      switch (request.operation) {
        case "open": return await open(view, request);
        case "transact": return await transact(view, request, signal);
        case "close": {
          const known = connections.has(request.database);
          forget(request.database);
          return known ? { kind: "Closed" } : { kind: "NotOpen" };
        }
        case "deleteDatabase": return await deleteDatabase(view, request.database);
      }
    } catch (error) {
      // A connection closing underneath a transaction is not an open one.
      const reason = nameOf(error);
      return reason === "InvalidStateError" ? { kind: "NotOpen" } : { kind: "Unavailable", reason };
    }
  };

  const execute = async (request: StoreRequest, context: CapabilityRequestContext): Promise<StoreResult> => {
    const view = context.document.defaultView;
    if (context.signal.aborted) return { kind: "Cancelled" };
    return view === null ? { kind: "Unavailable", reason: "unsupported" } : perform(request, view, context.signal);
  };

  return defineCapability<StoreRequest, StoreResult, StoreFact>({
    offer: registration.kind === "v1" ? STORE_CAPABILITY_V1 : CAPABILITY_OFFER,
    decodeRequest: registration.kind === "v1" ? decodeVersion1 : decodeStoreRequest,
    execute,
    activate: (host) => { wiring.host = host; },
  });
};
