// The optional service worker behind the offline pack (kemiller2002/limen#40,
// LCP-034). The host serves a one-line module that calls serveOffline with
// its own declared configuration:
//
//   import { serveOffline } from "…/capabilities/offline/worker.js";
//   serveOffline(self, { version: "2026.09.29", shell: [...], fallback: "/index.html" });
//
// It does four things, all mechanism:
//   - install: caches the declared shell under a cache named for its version;
//   - activate: deletes this pack's caches for other versions, and claims the
//     pages in its scope;
//   - fetch: a same-origin GET for a shell file is answered from the cache; a
//     navigation goes to the network first and falls back to the cached page
//     (or the declared fallback) when the network fails; everything else
//     passes through untouched;
//   - message: reports its version, and takes over when the pack says the
//     engine asked it to. It never takes over on its own.
//
// It never queues, retries, replays or resolves a request. A POST that fails
// offline fails, and the engine's outbox decides what happens next.

import { decodeWorkerCommand } from "./generated/offline.codec.js";

export type OfflineWorkerConfig = {
  // Names this build; a different version is a different cache.
  readonly version: string;
  // Same-origin URLs to cache at install: the page, its scripts, its styles.
  readonly shell: readonly string[];
  // The page served for a navigation when the network fails and the page
  // itself was not cached.
  readonly fallback: string;
  // This pack's caches start with it; other caches are never touched.
  readonly cachePrefix?: string;
};

// The parts of the worker's global scope used here, so the module needs no
// WebWorker typings and a test can supply its own.
export type WorkerScope = {
  addEventListener(type: string, listener: (event: Event) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly caches: CacheStorage;
  readonly location: { readonly href: string };
  fetch(request: Request): Promise<Response>;
};

type Extendable = Event & { waitUntil(promise: Promise<unknown>): void };
type Fetching = Extendable & { readonly request: Request; respondWith(response: Promise<Response>): void };
type Messaging = Event & { readonly data: unknown; readonly ports: readonly MessagePort[] };

const extendable = (event: Event): event is Extendable => "waitUntil" in event;
const fetching = (event: Event): event is Fetching => "respondWith" in event && "request" in event;
const messaging = (event: Event): event is Messaging => "data" in event && "ports" in event;

export const cacheNameFor = (config: OfflineWorkerConfig): string => `${config.cachePrefix ?? "limen-offline-"}${config.version}`;

export const serveOffline = (scope: WorkerScope, config: OfflineWorkerConfig): void => {
  const name = cacheNameFor(config);
  const prefix = config.cachePrefix ?? "limen-offline-";
  const origin = new URL(scope.location.href).origin;
  const shell = new Set(config.shell.map((path) => new URL(path, scope.location.href).href));

  scope.addEventListener("install", (event) => {
    if (!extendable(event)) return;
    event.waitUntil(scope.caches.open(name).then((cache) => cache.addAll([...shell])));
  });

  scope.addEventListener("activate", (event) => {
    if (!extendable(event)) return;
    event.waitUntil(scope.caches.keys()
      .then((names) => Promise.all(names.filter((cached) => cached.startsWith(prefix) && cached !== name).map((stale) => scope.caches.delete(stale))))
      .then(() => scope.clients.claim()));
  });

  scope.addEventListener("fetch", (event) => {
    if (!fetching(event)) return;
    const request = event.request;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== origin) return;
    if (request.mode === "navigate") {
      event.respondWith(scope.fetch(request).catch(async () => {
        const cache = await scope.caches.open(name);
        const page = (await cache.match(request, { ignoreSearch: true })) ?? (await cache.match(new URL(config.fallback, scope.location.href).href));
        return page ?? Response.error();
      }));
      return;
    }
    const key = `${url.origin}${url.pathname}`;
    if (!shell.has(key)) return;
    event.respondWith(scope.caches.open(name).then(async (cache) => (await cache.match(key)) ?? scope.fetch(request)));
  });

  scope.addEventListener("message", (event) => {
    if (!messaging(event)) return;
    const command = decodeWorkerCommand(event.data);
    if (!command.ok) return;
    switch (command.value.kind) {
      case "version":
        event.ports[0]?.postMessage({ kind: "Version", version: config.version });
        return;
      case "activate":
        void scope.skipWaiting();
        return;
    }
  });
};
