# Cross-context coordination

Tabs, windows, frames and workers of one application coordinate, without
shared mutable state (kemiller2002/limen#46, LCP-040).

```ts
import { coordinationCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/coordination";

coordinationCapability({ hub: { url: "/hub.js", scriptURL: (url) => policy.createScriptURL(url) } });
```

The contract is [`contract/coordination.contract.json`](../contract/coordination.contract.json),
with bindings for TypeScript, F#, C# and Rust. The pack is optional and absent
unless registered.

**No state is shared.** Each context's engine keeps its own state. Only JSON
messages cross between contexts. Every message is size-bounded (65,536
characters by default) and checked as plain JSON before an engine sees it.
The engine then decodes its own schema.

## Channels: same-origin broadcast

| Request | Answer |
| --- | --- |
| `identity` | `Identity { context }`: this page instance, a random id |
| `open { channel, via }` | `Opened { channel, context }`, `AlreadyOpen`, or `Unsupported` |
| `broadcast { channel, message }` | `Sent`, `NotOpen` or `TooLarge { limit }` |
| `close { channel }` | `Closed` or `NotOpen` |

The two transports:

- `via: "broadcast"` uses BroadcastChannel.
- `via: "hub"` uses a SharedWorker relay the host serves: a one-line module
  that calls `serveHub(self)` from `./capabilities/coordination/hub`. The
  host's Trusted Types policy vouches for its URL, as for any worker.

A message reaches every **other** context with the channel open, as
`Received { channel, from, message }`, and never comes back to its sender.
Anything else that arrives on the channel is `Undeliverable { channel, reason }`,
where reason is `malformed`, `not-json` or `too-large`, and is never passed on.

## Locks: coordination mechanics, semantically blind

| Request | Answer |
| --- | --- |
| `acquire { name, mode, wait, steal }` | `Acquired { lock }`. `Busy` when `wait` is false and another context holds it. `Cancelled` when the engine cancels while waiting. |
| `release { lock }` | `Released` or `UnknownLock` |

- **Holding a lock means only that no other context holds it.** Whether that
  makes this tab the leader, the one writer or the one syncing is the engine's
  decision. The pack never interprets a lock, and a lock is never business
  authorization.
- **A stolen lock is a fact.** When another context steals the lock, the
  former holder hears `LockLost { lock }`.
- **A context that disappears releases its locks.** A tab closing, crashing
  or navigating away lets the next contender's `acquire` complete.

That is the leader-election workflow:

1. Every tab asks `acquire { wait: true }`.
2. The one that gets it leads.
3. A leader that hears `LockLost` steps down.
4. When a leader's tab goes, the next tab in the queue leads.

## Frames: exact origin, point to point

| Request | Answer |
| --- | --- |
| `listen { target, origin }` | `Listening { peer }`, `NotFound`, or `InvalidOrigin` |
| `post { peer, message }` | `Sent`, `PeerGone`, `UnknownPeer` or `TooLarge` |
| `unlisten { peer }` | `Unlistened` or `UnknownPeer` |

`target` is an iframe named by `data-frame-target`, or `parent`.

- **`origin` must be exact:** scheme, host and port. A wildcard (`*`), an
  opaque origin (`null`), a path, or any scheme but http(s) is
  `InvalidOrigin`, and nothing is sent.
- **Sending:** a post names that origin as its target, so the browser drops
  it if the frame has navigated anywhere else. A frame that has been removed
  is `PeerGone`.
- **Receiving:** a message counts only if it comes from that peer's window
  at that origin, and it arrives as `PeerMessage { peer, message }`.
  - From the peer's window at another origin: `PeerRefused { reason: "wrong-origin" }`.
  - From the right origin but another window: `PeerRefused { reason: "wrong-source" }`.
  - Not bounded JSON: `PeerRefused { reason: "not-json" }`.
  - Anything that is neither the peer's window nor the peer's origin belongs
    to somebody else, and is left alone.

MessageChannel transfer is not part of the pack: no reference integration
needs a transferred port yet.

## Proof

- [`test/coordination.test.ts`](../test/coordination.test.ts) (jsdom, with
  Node's real BroadcastChannel and MessageChannel) covers:
  - two contexts exchanging over BroadcastChannel and through the hub;
  - nothing echoed back to the sender;
  - a closed channel;
  - a foreign shape, text that is not JSON, and text over the limit;
  - `Busy`, a queued contender, cancellation while waiting, and a steal
    reported as `LockLost`;
  - exact-origin validation;
  - `wrong-origin`, `wrong-source` and `not-json` refusals;
  - `PeerGone`;
  - provider conformance.
- [`test/browser/packs/coordination/`](../test/browser/packs/coordination/main.js)
  (Chromium, strict CSP, one Trusted Types policy, frames only from declared
  origins) covers:
  - two real tabs exchanging over BroadcastChannel and a real SharedWorker
    hub;
  - a ping and pong;
  - leadership handed over by release;
  - leadership lost to a steal, with the old leader stepping down;
  - leadership passed on when the leading tab closes;
  - a closed channel;
  - a wildcard origin refused;
  - a partner frame on another origin accepted;
  - the same frame refused when declared at the wrong origin;
  - an intruder frame refused as the wrong source.

The smoke runner gained two things for this: second-tab actions (`openPage`,
`closePage`), and per-folder frame policies (`frame-src`, `frame-ancestors`)
named in `page.json`.
