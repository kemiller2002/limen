// Service-worker registration and the application-update lifecycle
// (kemiller2002/limen#40, LCP-034).
//
// The host declares which workers exist, and vouches for their script URLs
// (under Trusted Types, through its own policy); the engine names one and
// never supplies a URL. A new version installs and then waits: it takes over
// only when the engine asks, so "an update is ready" and "activate it" are an
// explicit fact and an explicit decision.
//
// The worker (./worker.ts) caches a declared shell and serves it when the
// network fails. It never queues, retries or resolves anything: pending
// operations, conflicts and unknown outcomes are the engine's outbox
// (conformance/outbox). Online and offline are the lifecycle pack's facts.
// Push and background sync are reported as present or not, and nothing here
// subscribes or registers either.
//
// The service-worker container is injectable, so a test scripts one.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type OfflineFact, type OfflineRequest, type OfflineResult, type OfflineStatus } from "./generated/offline.js";
import { decodeOfflineRequest, decodeWorkerReply } from "./generated/offline.codec.js";

export { CAPABILITY_OFFER as OFFLINE_CAPABILITY } from "./generated/offline.js";
export type { OfflineFact, OfflineRequest, OfflineResult, OfflineStatus } from "./generated/offline.js";
export { decodeOfflineFact, decodeOfflineRequest, decodeOfflineResult } from "./generated/offline.codec.js";

// What a Trusted Types policy returns for a script URL: an object the browser
// accepts wherever it expects the URL string.
export type ScriptURL = string | URL | { readonly toString: () => string };

export type WorkerDeclaration = {
  readonly url: string;
  readonly scope?: string;
  // An ES-module worker (register with type "module").
  readonly module?: boolean;
};

// The parts of the service-worker API the pack uses, so a test can supply
// its own. Method syntax: the browser's own objects satisfy them.
export type WorkerLike = EventTarget & {
  readonly state: string;
  postMessage(message: unknown, transfer: MessagePort[]): void;
};
export type RegistrationLike = EventTarget & {
  readonly active: WorkerLike | null;
  readonly waiting: WorkerLike | null;
  readonly installing: WorkerLike | null;
  update(): Promise<unknown>;
};
export type ContainerLike = EventTarget & {
  readonly controller: WorkerLike | null;
  register(scriptURL: ScriptURL, options?: RegistrationOptions): Promise<RegistrationLike>;
};

export type OfflineOptions = {
  readonly workers: Readonly<Record<string, WorkerDeclaration>>;
  // Turns a declared URL into what the page's Trusted Types policy vouches
  // for. Without Trusted Types, the URL itself.
  readonly scriptURL?: (url: string) => ScriptURL;
  readonly container?: (document: Document) => ContainerLike | undefined;
  // How long a worker may take to report its version.
  readonly versionTimeoutMs?: number;
};

const browserContainer = (document: Document): ContainerLike | undefined => {
  const view = document.defaultView;
  if (view === null || !view.isSecureContext || !("serviceWorker" in view.navigator)) return undefined;
  return view.navigator.serviceWorker;
};

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "Error";

// Asks a worker for its version over a private channel; undefined if it does
// not answer in time or answers with something else.
const versionOf = (worker: WorkerLike | null, timeoutMs: number): Promise<string | undefined> => {
  if (worker === null) return Promise.resolve(undefined);
  const channel = new MessageChannel();
  return new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      const reply = decodeWorkerReply(event.data);
      resolve(reply.ok ? reply.value.version : undefined);
    };
    worker.postMessage({ kind: "version" }, [channel.port2]);
  }).finally(() => channel.port1.close());
};

export const offlineCapability = (options: OfflineOptions): CapabilityProvider => {
  const timeoutMs = options.versionTimeoutMs ?? 1000;
  const wiring: { host?: CapabilityHost<OfflineFact>; registration?: RegistrationLike; watchingController: boolean } = { watchingController: false };
  const watched = new WeakSet<RegistrationLike>();
  const containerFor = (document: Document): ContainerLike | undefined => (options.container ?? browserContainer)(document);

  const statusOf = async (document: Document, container: ContainerLike): Promise<OfflineStatus> => {
    const registration = wiring.registration;
    const view = document.defaultView;
    const [activeVersion, waitingVersion] = await Promise.all([versionOf(registration?.active ?? null, timeoutMs), versionOf(registration?.waiting ?? null, timeoutMs)]);
    return {
      supported: true,
      registered: registration !== undefined,
      controlled: container.controller !== null,
      ...(activeVersion !== undefined ? { activeVersion } : {}),
      ...(waitingVersion !== undefined ? { waitingVersion } : {}),
      installing: registration?.installing != null,
      push: view !== null && "PushManager" in view,
      backgroundSync: view !== null && "SyncManager" in view,
    };
  };

  // A new version that finishes installing while another controls the page is
  // an update, and waits; one that is discarded instead failed.
  const watchRegistration = (container: ContainerLike, registration: RegistrationLike): void => {
    if (watched.has(registration)) return;
    watched.add(registration);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      if (worker === null) return;
      const onState = (): void => {
        if (worker.state === "installed") {
          worker.removeEventListener("statechange", onState);
          if (container.controller !== null) void versionOf(worker, timeoutMs).then((version) => wiring.host?.emitFact({ kind: "UpdateReady", ...(version !== undefined ? { version } : {}) }));
        } else if (worker.state === "redundant") {
          worker.removeEventListener("statechange", onState);
          wiring.host?.emitFact({ kind: "UpdateFailed" });
        }
      };
      worker.addEventListener("statechange", onState);
    });
  };

  const watchController = (container: ContainerLike): void => {
    if (wiring.watchingController) return;
    wiring.watchingController = true;
    container.addEventListener("controllerchange", () => {
      void versionOf(container.controller, timeoutMs).then((version) => wiring.host?.emitFact({ kind: "ControllerChanged", ...(version !== undefined ? { version } : {}) }));
    });
  };

  const execute = async (request: OfflineRequest, context: CapabilityRequestContext): Promise<OfflineResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    const container = containerFor(context.document);
    if (container === undefined) return { kind: "Unsupported" };
    switch (request.operation) {
      case "register": {
        const declared = options.workers[request.worker];
        if (declared === undefined || !Object.hasOwn(options.workers, request.worker)) return { kind: "UnknownWorker" };
        try {
          watchController(container);
          const registration = await container.register((options.scriptURL ?? ((url: string) => url))(declared.url), {
            ...(declared.scope !== undefined ? { scope: declared.scope } : {}),
            ...(declared.module === true ? { type: "module" } : {}),
          });
          wiring.registration = registration;
          watchRegistration(container, registration);
          return { kind: "Registered", status: await statusOf(context.document, container) };
        } catch (error) {
          return { kind: "Failed", problem: nameOf(error) };
        }
      }
      case "status":
        return { kind: "Described", status: await statusOf(context.document, container) };
      case "checkForUpdate": {
        const registration = wiring.registration;
        if (registration === undefined) return { kind: "NotRegistered" };
        try {
          await registration.update();
          return { kind: "UpdateChecked", status: await statusOf(context.document, container) };
        } catch (error) {
          return { kind: "Failed", problem: nameOf(error) };
        }
      }
      case "activateUpdate": {
        const registration = wiring.registration;
        if (registration === undefined) return { kind: "NotRegistered" };
        const waiting = registration.waiting;
        if (waiting === null) return { kind: "NothingWaiting" };
        const version = await versionOf(waiting, timeoutMs);
        waiting.postMessage({ kind: "activate" }, []);
        return { kind: "Activating", ...(version !== undefined ? { version } : {}) };
      }
    }
  };

  return defineCapability<OfflineRequest, OfflineResult, OfflineFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeOfflineRequest, execute, activate: (host) => { wiring.host = host; } });
};
