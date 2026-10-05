# Realtime and streaming

> **Optional — not Limen Core.** This is the realtime pack, a capability pack. It composes with the Core concepts `typed-capabilities` and `correlation-compatibility`: connections are opaque handles requested through the Capability seam. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

WebSocket and Server-Sent Events without hidden connection policy
(kemiller2002/limen#26, LCP-016).

A long-lived connection has two parts:

- **The mechanism is the browser's:** the socket, the stream, the frames.
- **The policy is the engine's:** when to connect, whether to reconnect, how
  long to back off, and when a connection has been replaced.

The realtime pack does the first part and never the second.

```ts
import { realtimeCapability } from "@echelon-foundry/limen/capabilities/realtime";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [realtimeCapability()] }).start();
```

The contract is [`contract/realtime.contract.json`](../contract/realtime.contract.json),
with bindings for TypeScript, F#, C# and Rust.

| Request | Answer |
| --- | --- |
| `openWebSocket { url, protocols }` | `Connecting { connection }`. `url` is `ws:`/`wss:`, or `http(s):` mapped to `ws(s):`, absolute or relative to the page. |
| `openEventSource { url, withCredentials, events }` | `Connecting { connection }`. `url` is `http(s):`. `events` lists the named event types to hear; unnamed events always arrive. |
| `send { connection, text }` | `Sent { bufferedAmount }`, `NotOpen { state }`, `NotSendable` (an event stream), `Stale { reason }` |
| `close { connection, code?, reason? }` | `Closed`, `InvalidCloseCode` (only 1000 and 3000–4999), `Stale { reason }` |
| failures | `InvalidUrl { scheme }` (by scheme only, never the URL), `Refused { reason }` (the browser threw; its exception's name), `Unsupported`, `Cancelled` |

## A connection is an id and a sequence of facts

`Connecting` hands the engine an opaque id from the shared handle table
([24](24-contract-and-capabilities.md)). Everything that then happens to the
connection arrives as a capability fact carrying that id:

```text
Opened { connection, protocol }
Message { connection, data, event?, lastEventId? }
BinaryMessage { connection, bytes }
Closed { connection, initiator, code, reason, clean }
```

- **The lifecycle is explicit and serializable.** A connection the engine did
  not close ends with **exactly one** `Closed`. `initiator` is `remote` (the
  server closed it) or `error` (it failed, or an event stream dropped). After
  `Closed`, the id is `Stale`.
- **A close the engine asks for** is answered `Closed`, and nothing more is
  heard for that id. That includes a message the browser had already queued
  and an echo already in flight.
- **Replacement is identity.** To replace a connection, the engine closes the
  old id and opens a new one. Ids are never reused, and a closed id can never
  speak again, so a late message from the old connection cannot be mistaken
  for the new one. An id kept across a reload is `Stale(other-session)`.
- **Payloads are text the pack does not read.** JSON in a message is a string
  to the pack. A binary WebSocket frame is reported by its size only; bytes do
  not cross.

## The pack never reconnects

A WebSocket does not reconnect on its own. An `EventSource` does: when its
stream drops, the browser retries after the server's `retry:` hint. The pack
stops that retry, closes the stream, and reports `Closed` with
`initiator: "error"`. Every reconnection is then a new `openEventSource` the
engine chose to send. That keeps backoff, jitter, give-up rules and "is this
still worth it" in the engine, where they can be tested.

The Chromium smoke proves this against a server that drops its stream with a
50 ms retry hint: in 500 ms, exactly one connection is made. A mutation test
confirmed the check is not vacuous: with the retry stop removed, the check
fails.

## Security

The page's content security policy governs every connection (`connect-src`).
The pack refuses every non-network scheme before constructing anything.
`InvalidUrl` and diagnostics name the scheme only; a URL can carry a token.

## Out of scope, for now

The issue names two further transports, and neither has a consumer yet:

- **fetch readable streams:** Core's Http effect returns whole bodies (see
  #47 for HTTP profiles);
- **WebTransport.**

Either would join this pack as new request variants, not new Core concepts.

## Optional

Nothing in Core imports the pack. `kernel-with-realtime` has its own payload
budget, and the minimal consumer loads none of it.

| Evidence | Where |
| --- | --- |
| Connect, message, close; failure; explicit close silencing queued messages; replacement rejecting stale messages by id; close codes and URL schemes; event streams with named events; a dropped stream stopped and reconnected only on request; Unsupported; cancellation before execution; facts only to a selecting engine; conformance suite | [`test/realtime.test.ts`](../test/realtime.test.ts) |
| A real WebSocket (subprotocol, echo, binary by size, server close 4001, an echo in flight during an engine close, a replacement) and a real event stream (named events, a drop with no native retry, an engine reconnect), in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/realtime/`](../test/browser/packs/realtime/), [`test/browser/servers/realtime.ts`](../test/browser/servers/realtime.ts), `npm run smoke:packs` |
