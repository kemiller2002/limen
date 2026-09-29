// Governed adapters for third-party widgets and custom elements
// (kemiller2002/limen#30, LCP-021).
//
// Maps, charts, editors and payment fields bring their own DOM and their own
// state. This pack gives them a narrow, deterministic door:
//
//   the application registers each adapter explicitly (id and version);
//   the engine mounts one into a slot named in HTML, then drives it only with
//   serializable props and commands, under an opaque instance id;
//   the adapter speaks only through emit(name, data), and data must be JSON.
//
// No DOM node, widget object or engine internal crosses in either direction.
// Every call into an adapter is fault-isolated: an adapter that throws, or
// answers or emits something that is not JSON, is quarantined and reported,
// and nothing else is affected. A slot removed by a projection unmounts its
// instance. Adapters run with the page's authority; registering one is the
// application's trust decision (docs/42).
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { createHandleTable } from "../../capability-support/handles.js";
import { resolveTarget } from "../../capability-support/targets.js";
import { CAPABILITY_OFFER, type AdaptersFact, type AdaptersRequest, type AdaptersResult, type FaultPhase, type InstanceId } from "./generated/adapters.js";
import { decodeAdaptersRequest } from "./generated/adapters.codec.js";

export { CAPABILITY_OFFER as ADAPTERS_CAPABILITY } from "./generated/adapters.js";
export type { AdapterRef, AdaptersFact, AdaptersRequest, AdaptersResult, FaultPhase, InstanceId, SlotTarget } from "./generated/adapters.js";
export { decodeAdaptersFact, decodeAdaptersRequest, decodeAdaptersResult } from "./generated/adapters.codec.js";

// ---------------------------------------------------------------------------
// What an adapter author writes
// ---------------------------------------------------------------------------

export type AdapterContext = {
  // The slot element. The adapter owns its contents while mounted.
  readonly slot: HTMLElement;
  // Report something to the engine. data must be JSON.
  readonly emit: (name: string, data: unknown) => void;
};

export type AdapterInstance = {
  readonly update: (props: unknown) => void;
  // Commands by name; a result must be JSON (or a promise of JSON).
  readonly commands?: Readonly<Record<string, (args: unknown) => unknown>>;
  readonly unmount: () => void;
};

export type Adapter = {
  readonly id: string;
  readonly version: number;
  readonly mount: (context: AdapterContext, props: unknown) => AdapterInstance;
};

export const defineAdapter = (adapter: Adapter): Adapter => adapter;

// ---------------------------------------------------------------------------
// JSON only
// ---------------------------------------------------------------------------

// Plain JSON data: null, booleans, strings, finite numbers, arrays and plain
// objects of those. A DOM node, a function, a class instance, a cycle or a
// structure deeper than 64 levels is not.
export const isJson = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJson(item, depth + 1));
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value).every((item) => isJson(item, depth + 1));
};

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "unknown";

const isInstance = (value: unknown): value is AdapterInstance =>
  typeof value === "object" && value !== null && "update" in value && typeof value.update === "function" && "unmount" in value && typeof value.unmount === "function";

// ---------------------------------------------------------------------------
// The host pack
// ---------------------------------------------------------------------------

type Mounted = { readonly slot: HTMLElement; readonly adapter: Adapter; readonly instance: AdapterInstance };
type Fault = { readonly phase: FaultPhase; readonly reason: string };

const SLOT = { name: "data-adapter-slot", key: "data-adapter-key" } as const;

// The one place a handle-table id becomes the contract's opaque brand.
const instanceId = (id: string): InstanceId => id as InstanceId;

export const adaptersCapability = (options: { readonly adapters: readonly Adapter[] }): CapabilityProvider => {
  const registry = new Map(options.adapters.map((adapter) => [adapter.id, adapter] as const));
  // Owned by this provider instance: live instances, quarantined ones, and
  // the watcher that notices removed slots.
  const table = createHandleTable<Mounted>();
  const quarantined = new Map<string, Fault>();
  const wiring: { host?: CapabilityHost<AdaptersFact>; watcher?: MutationObserver | undefined } = {};

  const emitFact = (fact: AdaptersFact): void => { wiring.host?.emitFact(fact); };

  const quarantine = (id: InstanceId, fault: Fault): Fault => {
    quarantined.set(id, fault);
    return fault;
  };

  // Tear down whatever happens: the adapter's unmount is attempted once, the
  // slot is emptied, the id is disposed. A throwing unmount is a fault, not a
  // leak.
  const teardown = (id: InstanceId, mounted: Mounted): Fault | undefined => {
    const fault = (() => {
      try {
        mounted.instance.unmount();
        return undefined;
      } catch (error) {
        return { phase: "unmount", reason: nameOf(error) } as const;
      }
    })();
    mounted.slot.replaceChildren();
    quarantined.delete(id);
    table.dispose(id);
    return fault;
  };

  const sweep = (): void => {
    table.entries().filter(([, mounted]) => !mounted.slot.isConnected).forEach(([raw, mounted]) => {
      const id = instanceId(raw);
      teardown(id, mounted);
      emitFact({ kind: "SlotRemoved", instance: id });
    });
    if (table.size() === 0) {
      wiring.watcher?.disconnect();
      wiring.watcher = undefined;
    }
  };

  const watch = (document: Document): void => {
    const view = document.defaultView;
    if (wiring.watcher !== undefined || view === null) return;
    wiring.watcher = new view.MutationObserver(sweep);
    wiring.watcher.observe(document.documentElement, { childList: true, subtree: true });
  };

  // What an adapter may call. Emissions during mount wait until mount has
  // answered, so the engine hears Mounted before the instance's first fact.
  const emitterFor = (holder: { id?: InstanceId; ready: boolean; queue: (() => void)[] }) => (name: string, data: unknown): void => {
    const deliver = (): void => {
      const id = holder.id;
      if (id === undefined || table.use(id).kind !== "Live" || quarantined.has(id)) return;
      if (typeof name !== "string" || !isJson(data)) {
        const fault = quarantine(id, { phase: "emit", reason: "not-json" });
        emitFact({ kind: "AdapterFaulted", instance: id, phase: fault.phase, reason: fault.reason });
        return;
      }
      emitFact({ kind: "AdapterEvent", instance: id, name, data });
    };
    if (holder.ready) deliver(); else holder.queue.push(deliver);
  };

  const mount = (document: Document, request: Extract<AdaptersRequest, { operation: "mount" }>): AdaptersResult => {
    const adapter = registry.get(request.adapter.id);
    if (adapter === undefined) return { kind: "UnknownAdapter" };
    if (adapter.version !== request.adapter.version) return { kind: "VersionMismatch", registered: adapter.version };
    const resolved = resolveTarget(document, SLOT, request.slot);
    if (resolved.kind === "NotFound") return { kind: "NotFound" };
    if (resolved.kind === "Ambiguous") return { kind: "Ambiguous", count: resolved.count };
    const view = document.defaultView;
    const slot = resolved.element;
    if (view === null || !(slot instanceof view.HTMLElement)) return { kind: "NotFound" };
    const occupant = table.entries().find(([, mounted]) => mounted.slot === slot);
    if (occupant !== undefined) return { kind: "SlotOccupied", instance: instanceId(occupant[0]) };

    const holder: { id?: InstanceId; ready: boolean; queue: (() => void)[] } = { ready: false, queue: [] };
    const outcome = ((): { readonly instance: AdapterInstance } | Fault => {
      try {
        const instance = adapter.mount({ slot, emit: emitterFor(holder) }, request.props);
        return isInstance(instance) ? { instance } : { phase: "mount", reason: "invalid-instance" };
      } catch (error) {
        return { phase: "mount", reason: nameOf(error) };
      }
    })();
    if ("phase" in outcome) {
      slot.replaceChildren();
      return { kind: "Faulted", phase: outcome.phase, reason: outcome.reason };
    }
    const id = instanceId(table.create({ slot, adapter, instance: outcome.instance }, () => {}));
    holder.id = id;
    view.setTimeout(() => {
      holder.ready = true;
      holder.queue.splice(0).forEach((deliver) => deliver());
    }, 0);
    watch(document);
    return { kind: "Mounted", instance: id };
  };

  // A live, healthy instance, or the answer that says why not.
  const healthy = (id: InstanceId): { readonly mounted: Mounted } | { readonly answer: AdaptersResult } => {
    const found = table.use(id);
    if (found.kind === "Stale") return { answer: { kind: "Stale", reason: found.reason } };
    const fault = quarantined.get(id);
    return fault === undefined ? { mounted: found.resource } : { answer: { kind: "Faulted", phase: fault.phase, reason: fault.reason } };
  };

  const update = (id: InstanceId, props: unknown): AdaptersResult => {
    const state = healthy(id);
    if ("answer" in state) return state.answer;
    try {
      state.mounted.instance.update(props);
      return { kind: "Updated" };
    } catch (error) {
      const fault = quarantine(id, { phase: "update", reason: nameOf(error) });
      return { kind: "Faulted", phase: fault.phase, reason: fault.reason };
    }
  };

  const command = async (id: InstanceId, name: string, args: unknown): Promise<AdaptersResult> => {
    const state = healthy(id);
    if ("answer" in state) return state.answer;
    const handler = Object.hasOwn(state.mounted.instance.commands ?? {}, name) ? state.mounted.instance.commands?.[name] : undefined;
    if (typeof handler !== "function") return { kind: "UnknownCommand" };
    try {
      const result: unknown = await handler(args);
      if (isJson(result)) return { kind: "CommandDone", result };
      const fault = quarantine(id, { phase: "command", reason: "not-json" });
      return { kind: "Faulted", phase: fault.phase, reason: fault.reason };
    } catch (error) {
      const fault = quarantine(id, { phase: "command", reason: nameOf(error) });
      return { kind: "Faulted", phase: fault.phase, reason: fault.reason };
    }
  };

  const unmount = (id: InstanceId): AdaptersResult => {
    const found = table.use(id);
    if (found.kind === "Stale") return { kind: "Stale", reason: found.reason };
    const fault = teardown(id, found.resource);
    return fault === undefined ? { kind: "Unmounted" } : { kind: "Faulted", phase: fault.phase, reason: fault.reason };
  };

  const execute = async (request: AdaptersRequest, context: CapabilityRequestContext): Promise<AdaptersResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    switch (request.operation) {
      case "mount": return mount(context.document, request);
      case "update": return update(request.instance, request.props);
      case "command": return command(request.instance, request.name, request.args);
      case "unmount": return unmount(request.instance);
      case "describe": return { kind: "Adapters", registered: options.adapters.map((adapter) => ({ id: adapter.id, version: adapter.version })) };
    }
  };

  return defineCapability<AdaptersRequest, AdaptersResult, AdaptersFact>({
    offer: CAPABILITY_OFFER,
    decodeRequest: decodeAdaptersRequest,
    execute,
    activate: (host) => { wiring.host = host; },
  });
};
