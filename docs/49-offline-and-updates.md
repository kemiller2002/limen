# Offline, service workers and application updates

> **Optional — not Limen Core.** This is offline and updates, a capability pack and engine library. It composes with the Core concepts `typed-capabilities` and `engine-owns-meaning`: service-worker mechanism is a pack; what to keep and reconcile is engine state. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

An application that starts with no network, keeps the user's work while
offline, reconciles it when the network returns, and takes a new version only
when it decides to (kemiller2002/limen#40, LCP-034).

Four pieces, each where it belongs:

| Piece | Where | What it owns |
| --- | --- | --- |
| Online and offline | the lifecycle pack ([docs/48](48-page-lifecycle.md)) | facts only |
| Registration and the update lifecycle | `./capabilities/offline` | the mechanism: register a declared worker, report status, check for a new version, activate it when told |
| The service worker | `./capabilities/offline/worker`, served by the host | caching a declared shell and answering from it when the network fails |
| Pending operations, conflicts, unknown outcomes | the engine: the outbox ([conformance/outbox](../conformance/outbox/README.md), `libraries/fsharp/Limen.Outbox`) | every decision |

Nothing here is in Core, and nothing turns Core into a PWA framework. The
worker never queues, retries, replays or resolves a request. Synchronisation
is application meaning, so it lives in the engine.

## The pack

```ts
import { offlineCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/offline";

// The host's Trusted Types policy vouches for its own worker and nothing else.
const policy = trustedTypes.createPolicy("app-worker", {
  createScriptURL: (url) => { if (url !== "/sw.js") throw new TypeError(url); return url; },
});

offlineCapability({
  workers: { app: { url: "/sw.js", module: true } },
  scriptURL: (url) => policy.createScriptURL(url),
});
```

The contract is [`contract/offline.contract.json`](../contract/offline.contract.json),
with bindings for TypeScript, F#, C# and Rust.

| Request | Answer |
| --- | --- |
| `register { worker }` | `Registered { status }`. The engine names a worker the **host declared**. It never supplies a URL; an undeclared name is `UnknownWorker`. |
| `status` | `Described { status }`: `supported`, `registered`, `controlled`, `activeVersion?`, `waitingVersion?`, `installing`, `push`, `backgroundSync` |
| `checkForUpdate` | `UpdateChecked { status }` once the browser has fetched the script again |
| `activateUpdate` | `Activating { version? }`, or `NothingWaiting` |

Other answers: `NotRegistered`, `Unsupported` (no service workers, or not a
secure context), `Failed { problem }` (the browser's error name), and
`Cancelled`.

| Fact | Meaning |
| --- | --- |
| `UpdateReady { version? }` | A new version installed while an older one controls the page. It **waits**. |
| `ControllerChanged { version? }` | A different worker now controls the page: the first activation, or an update the engine activated. |
| `UpdateFailed` | A new version failed to install; the current one keeps control. |

**An update never takes over on its own.** The worker does not call
`skipWaiting()` at install. It takes over only when the pack tells it the
engine asked. Whether to activate now, after the user saves, or on the next
launch is the engine's decision. So is reloading afterwards, through a
Navigation effect.

Register on every start. With the same script, `register` only hands back the
existing registration, so it works offline as well.

## The worker

The host serves a one-line module:

```js
import { serveOffline } from "/node_modules/@echelon-foundry/typescript-wasm-kernel/dist/capabilities/offline/worker.js";
serveOffline(self, { version: "2026.09.29", shell: ["/", "/app.js", "/app.css"], fallback: "/" });
```

- **install** caches the declared `shell` in a cache named for the `version`.
- **activate** deletes this pack's caches for other versions (never anyone
  else's), then claims the pages.
- **fetch**:
  - A same-origin GET for a shell file is answered from the cache.
  - A navigation goes to the network first. When the network fails, it falls
    back to the cached page, or to `fallback`.
  - Everything else passes through untouched. That includes every write: a
    POST that fails offline fails, and the engine's outbox decides.
- **message** reports the version, and activates when the pack says so.

The shell is **declared**, not discovered. The page, its scripts, and every
module they import must be listed, or a cold offline launch fails on the one
that is missing. The reference page's
[`shell.js`](../test/browser/packs/offline/shell.js) is such a list.

## The engine's side: the outbox

[conformance/outbox](../conformance/outbox/README.md) defines it, and the F#
reference library and the reference page's JavaScript both run its 61 steps.

- Operations are kept in order, each with an idempotency id the engine chose.
- Operations are sent one at a time, and only while online.
- A conflict or an unknown outcome stops the queue until the engine resolves
  or reconciles it.
- Restoring after a reload turns anything that was in flight into `unknown`.
- The engine persists the outbox with Core Storage. For larger data, the
  store pack ([docs/41](41-indexeddb.md)) is the place. **IndexedDB
  is not offline support**: it holds data, and deciding what to do with the
  data is still the engine's.

## Push and background sync

`status` reports whether the Push API and Background Sync exist. Nothing in
this pack subscribes to push or registers a sync. Both need a server-side
contract (a push service, VAPID keys, a sync tag's meaning) that no reference
application here has. When one does, it arrives as its own optional pack, and
its smoke runs only where it is enabled.

## Proof

- [`test/offline.test.ts`](../test/offline.test.ts) (jsdom, scripted
  container and scope):
  - an undeclared worker is refused;
  - the host's Trusted Types object and options reach the browser;
  - first activation is not an update;
  - an update waits until the engine activates it;
  - a failed install;
  - not registered, refused, unreachable and aborted requests;
  - provider conformance;
  - the worker's install, activate, fetch and message behaviour.
  Mutation checks confirmed the tests fail if the worker takes over at
  install, or if `UpdateReady` fires without a controller.
- [`test/outbox-reference.test.ts`](../test/outbox-reference.test.ts): the
  page's JavaScript outbox against the 61 language-neutral steps.
- [`test/browser/packs/offline/`](../test/browser/packs/offline/main.js)
  (Chromium, strict CSP, one named Trusted Types policy) runs the reference
  application end to end:
  1. It registers v1, queues three operations offline, and reloads **with no
     network**. The page and every module come from the worker's cache: a cold
     offline launch.
  2. The outbox survived the reload. When the network returns, `a` is
     confirmed.
  3. `b` conflicts at v7, and `c` waits behind it. The engine rebases `b`.
  4. `c`'s connection is dropped after the server applied it:
     `OutcomeUnknown { connection-lost }`, held and never resent. The engine
     reconciles it by asking the server about its idempotency key, and the
     server applied it exactly once.
  5. A deployed v2 installs and waits (`UpdateReady`) until the engine
     activates it (`ControllerChanged`). Only v2's cache remains.

Findings from the Chromium run:

- **Registering a service worker is a Trusted Types sink.** Under
  `trusted-types 'none'` it is impossible. The host needs one named policy
  that vouches for its worker's URL, which is why `scriptURL` is a host
  option and the engine never supplies a URL. The smoke runner lets a page
  name its policies in `page.json`.
- **`controllerchange` fires before the new worker's activate handler has
  finished.** Cache cleanup therefore completes a moment after the fact.
- **A lost connection on a write was a retryable failure.** Proving the unknown
  outcome here found P-4. The kernel now reports
  `OutcomeUnknown { connection-lost }` (protocol 1.4, see
  [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md)).
