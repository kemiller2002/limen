// A deterministic fake host (LCP-031): plays the kernel's role for an engine
// under test with no DOM and no browser — a fake clock, a fake location and
// history, in-memory storage, and effect outcomes the test scripts. It runs
// the same handshake and the same message order as BrowserKernel, so an engine
// that behaves here behaves against the real kernel; only browser semantics a
// fake cannot establish still need a real browser.
//
// Test tooling, not production authority: nothing here decides application
// meaning, and it is not imported by Core.

import { CORE_CONTRACT_IDENTITY, PROTOCOL_MINOR, PROTOCOL_VERSION } from "../protocol.js";
import type {
  BrowserLocation, BrowserToEngineMessage, CapabilityEffectRequest, CapabilityOffer, CapabilityOutcome, ClipboardEffectRequest, ClipboardOutcome, CorrelationId,
  EffectOutcome, EffectRequest, EffectResult, EngineToBrowserMessage, EngineTransport, HostHandshake, HttpEffectRequest, NavigationEffectRequest, NavigationOutcome,
  StorageEffectRequest, StorageOutcome, ViewState,
} from "../protocol.js";
import { verifyHandshake, type HandshakeVerdict } from "../kernel/handshake.js";

// `undefined` holds the effect: it stays pending until the test resolves it,
// cancels it, or lets the fake clock time it out.
export type FakeOutcomes = {
  readonly http?: (request: HttpEffectRequest) => EffectOutcome | undefined;
  readonly clipboard?: (request: ClipboardEffectRequest) => ClipboardOutcome | undefined;
  readonly capability?: (request: CapabilityEffectRequest) => CapabilityOutcome | undefined;
  // Storage and Navigation have working fakes by default (an in-memory store,
  // a fake history); override to inject failures.
  readonly storage?: (request: StorageEffectRequest) => StorageOutcome | undefined;
  readonly navigation?: (request: NavigationEffectRequest) => NavigationOutcome | undefined;
};

export type FakeHostOptions = {
  readonly transport: EngineTransport;
  readonly location?: BrowserLocation;
  readonly capabilities?: readonly CapabilityOffer[];
  readonly outcomes?: FakeOutcomes;
  readonly requireHandshake?: boolean;
};

export type Pending = { readonly effect: EffectRequest; readonly deadline: number | undefined };

export type FakeHost = {
  readonly start: () => Promise<HandshakeVerdict>;
  readonly event: (name: string, key?: string, value?: string) => Promise<void>;
  readonly moveTo: (location: BrowserLocation) => Promise<void>;
  // Fact is the capability's generated fact type; it is sent as encoded JSON.
  readonly fact: <Fact>(capability: CapabilityOffer, fact: Fact) => Promise<void>;
  readonly resolve: (correlationId: CorrelationId, result: EffectResult) => Promise<void>;
  readonly advance: (milliseconds: number) => Promise<void>;
  readonly view: () => ViewState;
  readonly pending: () => readonly Pending[];
  readonly location: () => BrowserLocation;
  readonly storage: () => ReadonlyMap<string, string>;
  readonly now: () => number;
  readonly sent: () => readonly BrowserToEngineMessage[];
};

const DEFAULT_LOCATION: BrowserLocation = { origin: "https://fake.test", path: "/", query: "", hash: "" };

const splitUrl = (base: BrowserLocation, url: string): BrowserLocation | undefined => {
  try {
    const resolved = new URL(url, `${base.origin}${base.path}${base.query}${base.hash}`);
    return resolved.origin === base.origin ? { origin: base.origin, path: resolved.pathname, query: resolved.search, hash: resolved.hash } : undefined;
  } catch {
    return undefined;
  }
};

// The fake is a small mutable simulation — a clock, a history, a store and
// the in-flight set — owned by this closure and exposed only through reads.
export const createFakeHost = (options: FakeHostOptions): FakeHost => {
  const outcomes = options.outcomes ?? {};
  const world = {
    now: 0,
    view: {} as ViewState,
    history: [options.location ?? DEFAULT_LOCATION],
    index: 0,
    store: new Map<string, string>(),
    pending: new Map<CorrelationId, Pending>(),
    sent: [] as BrowserToEngineMessage[],
    running: false,
  };
  const here = (): BrowserLocation => world.history[world.index] ?? DEFAULT_LOCATION;

  const defaultStorage = (request: StorageEffectRequest): StorageOutcome => {
    switch (request.operation) {
      case "get": return { kind: "Success", value: world.store.get(request.key) ?? null };
      case "set": world.store.set(request.key, request.value); return { kind: "Success", value: null };
      case "remove": world.store.delete(request.key); return { kind: "Success", value: null };
    }
  };

  const defaultNavigation = (request: NavigationEffectRequest): NavigationOutcome => {
    switch (request.operation) {
      case "push":
      case "replace": {
        const target = splitUrl(here(), request.url);
        if (target === undefined) return { kind: "Failure", reason: "not-same-origin" };
        world.history = request.operation === "push" ? [...world.history.slice(0, world.index + 1), target] : world.history.map((entry, index) => (index === world.index ? target : entry));
        world.index = request.operation === "push" ? world.index + 1 : world.index;
        return { kind: "Success", location: target };
      }
      case "back":
      case "forward":
        return { kind: "Dispatched" };
    }
  };

  // What the kernel would answer immediately, or undefined to hold it.
  const answer = (effect: EffectRequest): EffectResult | undefined => {
    switch (effect.kind) {
      case "Http": {
        const outcome = outcomes.http?.(effect);
        return outcome === undefined ? undefined : { kind: "HttpResult", correlationId: effect.correlationId, outcome };
      }
      case "Storage": {
        const outcome = outcomes.storage?.(effect) ?? defaultStorage(effect);
        return { kind: "StorageResult", correlationId: effect.correlationId, outcome };
      }
      case "Clipboard": {
        const outcome = outcomes.clipboard?.(effect);
        return outcome === undefined ? undefined : { kind: "ClipboardResult", correlationId: effect.correlationId, outcome };
      }
      case "Navigation": {
        const outcome = outcomes.navigation?.(effect) ?? defaultNavigation(effect);
        return { kind: "NavigationResult", correlationId: effect.correlationId, outcome };
      }
      case "Capability": {
        const offered = (options.capabilities ?? []).some((capability) => capability.id === effect.capability && capability.version === effect.version);
        if (!offered) return { kind: "CapabilityResult", correlationId: effect.correlationId, capability: effect.capability, version: effect.version, outcome: { kind: "Unsupported", reason: "not-negotiated" } };
        const outcome = outcomes.capability?.(effect);
        return outcome === undefined ? undefined : { kind: "CapabilityResult", correlationId: effect.correlationId, capability: effect.capability, version: effect.version, outcome };
      }
    }
  };

  const send = async (message: BrowserToEngineMessage): Promise<void> => {
    if (!world.running) throw new Error(`Fake host is not running; ${message.kind} not sent (start() it, or the handshake failed).`);
    world.sent.push(message);
    await apply(await options.transport.dispatch(message));
  };

  const apply = async (response: EngineToBrowserMessage): Promise<void> => {
    world.view = response.view;
    for (const correlationId of response.cancellations) {
      const held = world.pending.get(correlationId);
      if (held === undefined) continue;
      world.pending.delete(correlationId);
      // Http cancellation is mechanical, exactly as in the kernel. A held
      // capability effect is dropped: only its provider could say what its
      // own Cancelled looks like.
      if (held.effect.kind === "Http") await send({ kind: "EffectResult", result: { kind: "HttpResult", correlationId, outcome: { kind: "Cancelled" } } });
    }
    for (const effect of response.effects) {
      if (world.pending.has(effect.correlationId)) throw new Error(`Engine reused in-flight correlation id ${effect.correlationId} (the kernel refuses this).`);
      const result = answer(effect);
      if (result === undefined) world.pending.set(effect.correlationId, { effect, deadline: effect.kind === "Http" ? world.now + effect.timeoutMs : undefined });
      else await send({ kind: "EffectResult", result });
    }
  };

  const offer = (): HostHandshake => ({
    protocol: { major: PROTOCOL_VERSION, minor: PROTOCOL_MINOR },
    contract: { unit: CORE_CONTRACT_IDENTITY.unit, version: CORE_CONTRACT_IDENTITY.version, fingerprint: CORE_CONTRACT_IDENTITY.fingerprint },
    capabilities: options.capabilities ?? [],
  });

  return {
    start: async () => {
      await options.transport.start();
      const initialize: BrowserToEngineMessage = { kind: "Initialize", protocolVersion: PROTOCOL_VERSION, capabilities: ["Http", "Storage", "Clipboard", "Navigation"], location: here(), handshake: offer() };
      world.sent.push(initialize);
      const response = await options.transport.dispatch(initialize);
      const verdict = verifyHandshake(offer(), response.handshake, options.requireHandshake ?? false);
      if (verdict.kind === "Compatible") {
        world.running = true;
        await apply(response);
      }
      return verdict;
    },
    event: (name, key, value) => send({ kind: "Event", event: { kind: "Event", name, ...(key !== undefined ? { key } : {}), ...(value !== undefined ? { value } : {}) } }),
    moveTo: async (location) => {
      world.history = [...world.history.slice(0, world.index + 1), location];
      world.index += 1;
      await send({ kind: "LocationChanged", location });
    },
    fact: (capability, fact) => send({ kind: "CapabilityFact", capability: capability.id, version: capability.version, fact }),
    resolve: async (correlationId, result) => {
      if (!world.pending.delete(correlationId)) throw new Error(`No pending effect ${correlationId}.`);
      await send({ kind: "EffectResult", result });
    },
    // Time passes; an Http effect still held past its deadline is reported as
    // the kernel reports a timeout: OutcomeUnknown, never Failure.
    advance: async (milliseconds) => {
      world.now += milliseconds;
      const expired = Array.from(world.pending.values()).filter((held) => held.deadline !== undefined && held.deadline <= world.now);
      for (const held of expired) {
        world.pending.delete(held.effect.correlationId);
        await send({ kind: "EffectResult", result: { kind: "HttpResult", correlationId: held.effect.correlationId, outcome: { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" } } });
      }
    },
    view: () => world.view,
    pending: () => Array.from(world.pending.values()),
    location: here,
    storage: () => new Map(world.store),
    now: () => world.now,
    sent: () => [...world.sent],
  };
};
