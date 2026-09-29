# Fatal fallback and restart

What the user sees when the engine itself breaks, and how they get back
(kemiller2002/limen#50, LCP-032).

Two kinds of failure must never be confused:

- **Application failures** are engine state: a declined payment, a
  validation error, a server that answered 409. The engine models them and
  projects them like any other state. They never reach this page.
- **Infrastructure faults** are the engine being unable to run:
  - its module would not load (`transport.start()` threw);
  - its `Initialize` failed;
  - the page refused a binding;
  - the engine was incompatible;
  - the engine **threw** while handling a message.

  In each case the engine cannot project its own recovery UI. After a throw,
  its state is unknown.

Core already reports every infrastructure fault as a `BridgeError`. It never
leaves a partial projection ([03](03-kernel-lifecycle.md)). What it did not do
was show the user anything, or offer a way back. The optional fallback host
does that. It is a host, not Core, because what to show and whether to restart
are the composition root's decisions.

```ts
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
import { startWithFallback } from "@echelon-foundry/typescript-wasm-kernel/hosts/fallback";

const host = await startWithFallback({
  document,
  connect: (guard) => new BrowserKernel(guard(createTransport()), document, diagnostics, options),
  onHealth: (health) => telemetry.record(health),   // optional
});
```

`connect` builds a fresh transport and kernel for each attempt. `guard`
wraps the transport so the host can see each fault's error class. The host
imports no kernel, so the composition root keeps control of how the kernel is
built.

## Host health

Host health is mechanical, and separate from application state:

```text
starting → available
         → unavailable { id, phase, attempt, restartable }
```

| Fault | `phase` | When |
| --- | --- | --- |
| `transport.start()` threw | `start` | during startup |
| `Initialize` failed | `initialize` | during startup |
| a binding was refused at start | `binding` | during startup |
| the handshake was refused | `incompatible` | during startup |
| the engine threw while handling a message | `dispatch` | while running |

A malformed projection is **not** fatal: nothing of it is applied, a
`BridgeError` reports it, and the page keeps working. A domain failure is not
fatal either, because it is not a fault at all. Both are tested.

## One deterministic policy: preserve and cover

On a fault the host does four things:

1. **disposes the kernel**, so nothing more reaches an engine whose state is
   unknown ([`dispose()`](03-kernel-lifecycle.md#status-and-shutdown));
2. **preserves** the last good view, and makes every existing child of
   `<body>` `inert` and `aria-hidden`: visible, but not operable;
3. **covers** it with a static, generic failure surface (`role="alert"`),
   appended to `<body>` and built with DOM APIs, never HTML strings. Focus
   moves to the surface;
4. shows **Try again** (while restarts remain) and **Reload the page**.

The page is therefore never silently dead, and never half-working against a
broken engine. The Chromium smoke clicks the covered page with a real mouse
event and proves that neither the element nor the engine receives it.

The surface is styled by the application's CSS through its classes
(`limen-fallback`, `limen-fallback-restart`, `limen-fallback-reload`,
`limen-fallback-id`), with no inline style, so strict CSP holds. Its words are
in `text`. The defaults are deliberately generic, because the host knows
nothing about the application.

## Restart, and its bound

**Try again** is safe because it starts over:

- the host disposes the old kernel;
- it restores `<body>` from the clone it took before the first start (the
  page's own HTML, templates intact, nothing projected);
- it calls `connect` for a fresh transport and kernel.

The new engine starts from its own beginning. The host restores no
application state. An engine that wants to resume must own a versioned
snapshot that proves it safe, which is the engine's design, not the host's.

Restarts are bounded by `maxRestarts` (default 2). After the last one fails,
the health is `unavailable` with `restartable: false`, the surface offers only
**Reload the page**, and `restart()` does nothing. The host never retries on
its own, and never replays an effect whose outcome was unknown.

## The error id

`LIMEN-<PHASE>-<ErrorName>`, for example `LIMEN-DISPATCH-TypeError`. It is
stable (the same failure class gives the same id) and shown on the surface.
It is safe to paste into a support ticket or send to telemetry:

- it is built from the failing step and the exception's **class name** only;
- the message, the payload and any header are never used;
- a class name that is not a plain identifier becomes `Error`.

The tests throw errors carrying a card number and an email address, and check
that neither appears anywhere the host writes.

## Federation is unchanged

`ModuleFederation.startAvailable()` isolates a faulted module inside the
engine side. The engine's transport still answers, so the host sees an
available engine, which reports partial availability as its own state. A test
composes a faulted and a healthy module behind the host and checks exactly
that.

## Optional

Nothing in Core imports the host. `kernel-with-fallback-host` has its own
payload budget.

| Evidence | Where |
| --- | --- |
| Start and Initialize failures; a dispatch failure preserving the last view with nothing more sent; a malformed projection not fatal; a domain failure not fatal; restart restoring the pre-start DOM with a fresh engine; restarts bounded to Reload only; redaction, including a hostile error name; incompatible and binding faults; federation's partial availability unchanged | [`test/fallback-host.test.ts`](../test/fallback-host.test.ts) |
| In Chromium under a strict CSP with Trusted Types: a real crash covered, focus on the surface, the last view preserved, a real mouse click on the inert page reaching nothing, a real click on Try again restoring a working page on a fresh engine | [`test/browser/packs/core-fallback/`](../test/browser/packs/core-fallback/), `npm run smoke:packs` |
