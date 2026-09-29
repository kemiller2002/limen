# Page, connectivity and lifecycle evidence

Online and offline, visibility, the back/forward cache, freezing, prerendering
and connection quality, as typed facts the engine subscribes to
(kemiller2002/limen#43, LCP-037).

The browser knows things about the page that change what an application
should do. Is there a network? Can anyone see the page? Is it about to go
into the back/forward cache, or has it just come back? An engine that reads
`navigator.onLine` or `document.visibilityState` cannot run as F#, C# or
Rust, and cannot be tested without a browser. So it asks:

```ts
import { lifecycleCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/lifecycle";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [lifecycleCapability()] }).start();
```

The contract is [`contract/lifecycle.contract.json`](../contract/lifecycle.contract.json),
with bindings for TypeScript, F#, C# and Rust.

| Request | Answer |
| --- | --- |
| `describe` | `Described { state: { online, visibility, prerendering, wasDiscarded, connection? } }` |
| `subscribe { topics }` | `Subscribed { subscription, state }`, then facts tagged with `subscription`. No topics is `InvalidRequest`. |
| `unsubscribe { subscription }` | `Unsubscribed`, or `UnknownSubscription` if it was never issued or has already ended |

## Topics and their facts

| Topic | Fact | From |
| --- | --- | --- |
| `connectivity` | `ConnectivityChanged { online }` | `online` / `offline` |
| `visibility` | `VisibilityChanged { visibility }` | `visibilitychange` |
| `pageLifecycle` | `PageHidden { persisted }`, `PageShown { persisted }` | `pagehide` / `pageshow` |
| `freezing` | `Frozen`, `Resumed` | `freeze` / `resume` |
| `prerendering` | `PrerenderActivated` | `prerenderingchange` |
| `connection` | `ConnectionChanged { connection }` | the Network Information API's `change` |

Each subscription hears only its own topics. Two subscriptions are
independent, and a duplicated topic is one listener.

## What each fact proves, and what it does not

- **`online: false` proves the browser has no network.** `online: true` proves
  only that it has *some* network. It does not prove that the engine's backend
  answers. Only an effect outcome proves that, and an Http effect sent while
  "online" can still end `Failure` or `OutcomeUnknown`.
- **Connection quality is advisory.** `effectiveType`, `downlinkMbps`, `rttMs`
  and `saveData` are the browser's estimates. Chromium buckets and rounds them:
  a 400 ms emulated round trip reads as 350. Each field may be absent, and the
  whole `connection` is absent where the API is missing (Firefox, Safari).
  An engine may choose a lighter image on `saveData`. It must not treat the
  estimate as a measurement.
- **`PageHidden { persisted: true }`** means the page may go into the
  back/forward cache and be shown again. `persisted: false` means it is being
  unloaded. Either way, this is the last reliable moment to save.
- **`PageShown { persisted: true }`** means the page was restored from the
  cache. Nothing reloaded: the engine's state and the kernel survived, but
  timers were suspended and data may be stale.
- **`Frozen`** means nothing runs until `Resumed`.
- **`wasDiscarded`** means the browser threw the page away while it was hidden
  and loaded it again. In-memory state is gone. Anything the engine needed
  must be restored from storage.

## The engine decides

The pack never pauses a timer, closes a socket, retries a request or refreshes
a view. Whether a hidden page stops polling, or a restored page refreshes, is
application meaning. The reference workflow in
[`test/lifecycle.test.ts`](../test/lifecycle.test.ts) is a pure transition in
the engine:

```ts
const onFact = (state: Workflow, fact: LifecycleFact): Workflow => {
  switch (fact.kind) {
    case "ConnectivityChanged": return { ...state, online: fact.online };                // show "offline — changes are held"
    case "VisibilityChanged": return { ...state, polling: fact.visibility === "visible" }; // stop refreshing while hidden
    case "PageShown": return fact.persisted ? { ...state, refreshes: state.refreshes + 1 } : state; // stale after a restore
    case "PageHidden": case "Frozen": case "Resumed": case "PrerenderActivated": case "ConnectionChanged": return state;
  }
};
```

## The back/forward cache

The pack listens to `pagehide` and `pageshow`. It never listens to `unload` or
`beforeunload`, because either listener makes a page ineligible for the
cache. A test holds it to that.

## Proof

- [`test/lifecycle.test.ts`](../test/lifecycle.test.ts) (jsdom) covers:
  - every topic from real DOM events;
  - topic filtering and tagging;
  - unsubscribe, including an ended or unknown subscription;
  - no topics, and an aborted request;
  - no unload listener;
  - connection quality;
  - `wasDiscarded` and `prerendering`;
  - the reference workflow through the real kernel with a scripted host;
  - provider conformance.
- [`test/browser/packs/lifecycle/`](../test/browser/packs/lifecycle/main.js)
  (Chromium) covers:
  - the network really going away and coming back;
  - an emulated slow network changing the estimate;
  - a real back/forward-cache round trip, with the kernel alive throughout.
    The facts arrive in the browser's order: `PageHidden { persisted: true }`,
    hidden, `Frozen`, `Resumed`, visible, `PageShown { persisted: true }`.

Two findings came out of the Chromium run:

- **Playwright turns the back/forward cache off.** Its default Chromium passes
  `--disable-back-forward-cache`, and its headless shell disables the cache
  for its delegate. A pack page that needs the cache says so with
  `page.json: { "backForwardCache": true }`. The runner then launches full
  Chromium (`channel: "chromium"`) without that switch. Pages restored from
  the cache never fire `load`, so the runner waits for the commit only.
- **Prerendering cannot be proven with DevTools attached.** Chromium reports
  `PrerenderingDisabledByDevTools` for a speculation-rules prerender when a
  DevTools client is connected, and every Playwright session is one. So
  `PrerenderActivated` is proven in jsdom, and in Chromium only `prerendering:
  false` is. Also, `Page.setWebLifecycleState` does not freeze a visible page:
  freezing is proven through the real back/forward-cache trip instead.

Optional: nothing in Core imports the pack, and the `kernel-with-lifecycle`
budget in `bench/budgets.json` keeps it out of every other profile.
