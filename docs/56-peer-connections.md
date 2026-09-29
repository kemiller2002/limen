# Peer connections (WebRTC)

> **Optional — not Limen Core.** This is the peer connection pack, a capability pack. It composes with the Core concepts `typed-capabilities` and `correlation-compatibility`: connections are requested through the generic Capability seam, and descriptions, candidates and state changes travel as typed results and facts the engine correlates itself. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

WebRTC connections with every browser object kept in the browser
(kemiller2002/limen#44, LCP-038). The engine holds an opaque connection id.
Offers, answers and ICE candidates are plain data that the engine relays
itself.

```ts
import { mediaCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/media";
import { peerCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/peer";

const media = mediaCapability();
// The application, not the packs, decides that peers may send its captures.
const peer = peerCapability({ captures: media });
await new BrowserKernel(transport, document, diagnostics, { capabilities: [media, peer] }).start();
```

The contract is
[`contract/peer.contract.json`](https://github.com/kemiller2002/limen/blob/main/contract/peer.contract.json).
It is generated for TypeScript, F#, C# and Rust.

## Signaling is the engine's

The pack never decides who the peer is, whether to call, or how to reach them.
It hands the engine data to relay:

| The browser produces | The engine receives | The engine does |
| --- | --- | --- |
| an offer or answer | `Described { description: { type, sdp } }` | `setLocal`, then relays it by any channel it likes (Http, the realtime pack, a coordination channel) |
| an ICE candidate | a `LocalCandidate` fact | relays it |
| the other side's description or candidate | — (it arrives through the engine's channel) | `setRemote`, `addCandidate` |

Connection state (`StateChanged`: new, connecting, connected, disconnected,
failed, closed), `RemoteTrackArrived`, `GatheringComplete` and
`NegotiationNeeded` arrive as facts. A connection that fails is a fact, not
an exception; retrying, reconnecting or giving up is the engine's decision.

## Local media is granted, not shared

`addCapture { connection, capture }` sends every live track of a capture the
[media pack](55-media.md) issued. The pack can reach captures only through
the `CaptureSource` the application passes to `peerCapability`. Packs never
import each other, and without that grant every capture id is
`UnknownCapture`.

## Remote media

`showRemote { connection, target }` plays the connection's remote media in a
`<video data-peer-remote="…">` the HTML names. A row's `<video>` is selected
with a key on the nearest `data-peer-key` ancestor. `NotFound`, `Ambiguous`
and `WrongElement` are answers.

## Refusals and failures

| Result | Meaning |
| --- | --- |
| `Rejected { reason }` | The browser refused a description or candidate in the connection's current state, for example an answer before any offer. `reason` is the browser's error name. |
| `Failed { reason }` | Anything else, by the browser's error name. |
| `NotSupported` | The browser has no `RTCPeerConnection`. |
| `Stale` | A closed or unknown connection id. |
| `Cancelled` | The engine cancelled the request. The browser cannot abandon an operation already started, so its own result is ignored. |

## Everything ends

- **`close`** ends one connection: its video is cleared, no fact follows,
  and its id is `Stale`.
- **`dispose()`**, at the host's teardown, closes every connection the
  provider still owns.

ICE servers, including TURN credentials, are the application's to supply
and are never reported back.

## Verified

- **jsdom, `test/peer.test.ts`, 9 tests:**
  - the ICE servers and the capture grant;
  - `Described`, `Applied`, `Rejected` and `Failed`;
  - every fact, and that no fact follows `close`;
  - `showRemote`, `dispose()` and cancellation;
  - the shared provider conformance suite.
- **Chromium, `npm run smoke:packs`, page `peer`, 8 checks under strict CSP
  and Trusted Types.** Two connections in one page, with the page's engine
  as the signaling.
  - A sends Chromium's fake camera, captured through the media pack and
    added by id.
  - The engine relays the offer, the answer and every candidate.
  - Both sides report `connected`, and B's named `<video>` plays A's camera.
  - An answer before an offer is `Rejected`.
  - `close` and `dispose()` end everything.

## Not built

- **Data channels.** No consumer yet. Messaging between peers today goes
  through the engine's own signaling channel.
- **Stats, simulcast and codec preferences.** Each would be an additive
  request when a consumer needs it.

## Size

The `kernel-with-peer` profile in `bench/budgets.json` adds 7.9 KB gzip over
the kernel. It never loads the media pack by itself.
