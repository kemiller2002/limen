# Testing engines: the fake host, traces and replay

> **Optional — not Limen Core.** This is the fake host, traces and replay, a tooling. It composes with the Core concepts `semantic-input` and `projection-output`: it records and replays what crosses the boundary. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

**What this answers:** how to test an engine deterministically without a
browser, and how to see — and replay — exactly what crossed the boundary.

These are tooling (`src/tooling/`, layer `tooling`). Core never imports them,
and an application that does not use them pays nothing.

## The fake host — `@echelon-foundry/limen/testing`

`createFakeHost` plays the kernel's role with no DOM: the same handshake, the
same message order, a **fake clock**, a **fake location and history**, an
in-memory **storage**, and effect outcomes your test scripts.

```ts
const host = createFakeHost({
  transport: myEngineTransport,
  requireHandshake: true,
  outcomes: { http: (request) => ({ kind: "Success", status: 200, body: { available: true } }) },
});
await host.start();                        // the handshake verdict
await host.event("checkAvailability");     // → effects run → results return
host.view();                               // the latest projection
```

- An outcome function that returns `undefined` **holds** the effect:
  `host.pending()` lists it, `host.resolve(id, result)` answers it late (stale-
  result tests), and a cancellation from the engine answers a held Http effect
  with `Cancelled`, as the kernel does.
- `host.advance(ms)` moves the clock; a held Http effect past its `timeoutMs`
  is answered `OutcomeUnknown` — never `Failure` — exactly as the kernel
  classifies a timeout.
- Storage and Navigation work by default (a cross-origin push is
  `not-same-origin`); override them to inject failures. An engine that reuses
  an in-flight correlation id makes the fake host throw, because the kernel
  refuses it.

Browser semantics a fake cannot establish — real `fetch`, clipboard
permission, the Back button — still need a real browser (`smoke:browser`,
`smoke:guests`).

## Traces — `@echelon-foundry/limen/trace`

```ts
const entries: TraceEntry[] = [];
const traced = tracingTransport(transport, (entry) => entries.push(entry), { enabled: isDevelopment });
```

Every message to and from the engine is recorded in order with a sequence
number and a timestamp from an injectable clock. With `enabled: false` the
function returns the transport it was given — tracing is a no-op in
production.

`exportTrace(entries)` produces JSON safe to attach to a bug report: request
headers and bodies, response bodies, stored and read values, clipboard text,
capability payloads and facts, input values, the whole view, and a location's
query and hash are replaced by `"[redacted]"`; event names, view keys, effect
kinds, URLs' paths and storage keys — the application's vocabulary — remain.

## Replay

`replay(entries, freshTransport)` sends every recorded browser message, in
order, to a fresh engine, compares each response with the recorded one, and
returns the final projection and any divergences. For a deterministic engine
an unredacted trace reproduces the final projection exactly; a divergence
names the sequence number where behavior changed.
