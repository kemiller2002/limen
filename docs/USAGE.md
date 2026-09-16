# Usage

> **Newer documentation is available.** This page predates the documentation
> audit and is kept for continuity; it remains accurate. For building an
> application from scratch see [02-getting-started.md](02-getting-started.md);
> for the full effect model see
> [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md); for
> exact signatures see [11-api-reference.md](11-api-reference.md). Start at the
> [documentation index](README.md).
>
> One correction: the `DirectTypeScriptTransport` shown in §3 below is
> **hard-wired to this repository's email-availability demo** and understands
> only the event names `emailChanged` and `checkAvailability`. Do not use it for
> your own application — write your own `EngineTransport`, which is about eight
> lines. See [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md) finding A-1.

Step-by-step instructions for using `@echelon-foundry/typescript-wasm-kernel`
once it is installed.

`BrowserKernel` is a generic declarative bridge — it does not know about your
domain (customers, orders, email addresses, anything). It understands five
primitives, expressed as `data-*` attributes, and interprets nothing else:

| Attribute | Purpose |
| --- | --- |
| `data-event="name"` | Forward a browser event as `SemanticEvent { name }` |
| `data-on="type"` | Override the default DOM event type for `data-event` |
| `data-text="key"` | Set `element.textContent` from `view[key]` |
| `data-bind-<attr>="key"` | Set an attribute/property from `view[key]` |
| `data-if="key"` | Mount/unmount a `<template>` based on `view[key]` |
| `data-each="key" data-key="field"` | Repeat a `<template>` once per item in `view[key]`, keyed by `item[field]` |

The engine only ever sees generic `SemanticEvent`/`ViewState` values — it
never receives element IDs, and the bridge never interprets what a `data-*`
key means. See [`index.html`](../index.html) for the reference feature (email
availability checking) using these primitives end to end.

## 1. Install the package

```sh
npm install @echelon-foundry/typescript-wasm-kernel
```

## 2. Author HTML with data-* bindings

```html
<form data-event="checkAvailability">
  <label for="email">Email address</label>
  <input id="email" name="email" type="email" required autocomplete="email" data-event="emailChanged">
  <button type="submit" data-bind-disabled="submitDisabled">Check availability</button>
</form>
<p role="status" aria-live="polite" data-text="statusText"></p>
```

Notes:

- Element `id`s are no longer meaningful to the kernel — use them only where
  HTML itself needs them (`<label for>`, a CSS hook, etc.), as with `id="email"`
  above.
- `data-event` triggers on a tag-appropriate native event by default
  (`form` → `submit` with `preventDefault`; `input`/`select`/`textarea` →
  `change`; everything else, including plain `<li>`/`<div>`/`<tr>` rows →
  `click`). Override with `data-on="input"` for e.g. search-as-you-type, or
  `data-on="keydown"` for keyboard-triggered intents.
- Before a form's own `data-event` fires, the kernel flushes any pending
  `change`-bound fields within it (via the native `.form` association), so a
  field edited without blurring still reaches the engine before submit. This
  is a purely mechanical "commit before the coarser action" behavior — the
  kernel does not know these fields form one logical draft, only that they're
  declared bindings inside the same `<form>`.

### Conditional content

```html
<template data-if="hasSearchResults">
  <p>Results found.</p>
</template>
```

The template's content mounts/unmounts based on the truthiness of
`view["hasSearchResults"]`. The template must wrap exactly one root element.

### Repeated content

```html
<ul>
  <template data-each="customers" data-key="id">
    <li data-event="select">
      <span data-text="label"></span>
    </li>
  </template>
</ul>
```

Each item in `view["customers"]` (an array of flat records) instantiates one
clone of the template, keyed by `item["id"]`. Reconciliation across
projections preserves DOM node identity for unchanged keys (so focus, local
input state, and animation aren't reset) and moves/removes nodes to match new
order/membership. An event fired from inside an instantiated item (e.g. the
`select` click above) carries that item's key as `SemanticEvent.key`.

## 3. Wire the kernel in your entry script

```ts
import {
  BrowserKernel,
  DirectTypeScriptTransport,
} from "@echelon-foundry/typescript-wasm-kernel";

const kernel = new BrowserKernel(
  new DirectTypeScriptTransport(),
  document,
);

await kernel.start();
```

Optionally pass a third argument — a `DiagnosticsSink` — to observe bridge
mechanism failures (a thrown transport, a malformed projection) and effect
timing, without any of it touching domain state:

```ts
const kernel = new BrowserKernel(new DirectTypeScriptTransport(), document, {
  report(event) {
    if (event.kind === "BridgeError") console.error(event.phase, event.detail);
  },
});
```

Every engine round-trip funnels through one error boundary: if the transport
throws or a projection references a view key that isn't there, the kernel
reports it via diagnostics and stops for that round-trip rather than
crashing the page or leaving a half-applied view. It never falls back to
guessing what the engine meant.

Load this as a module script:

```html
<script type="module" src="./dist/main.js"></script>
```

`kernel.start()` starts the transport, scans `document.body` for bindings,
and dispatches an `Initialize` message so the engine can project its initial
view immediately.

## 4. Implement the engine side

Your engine (TypeScript today, WASM later) needs to:

- Map incoming `SemanticEvent { name, key?, value? }` to your own commands
  (see `eventToCommand` in [`src/engine/domain.ts`](../src/engine/domain.ts)
  — it switches on `name` and rejects anything outside its own vocabulary).
- Produce a `ViewState` — a flat record of scalars and item arrays — from
  your authoritative state (see `project` in
  [`src/engine/engine.ts`](../src/engine/engine.ts)).

## 5. Stand up any backend effects your engine requests

The reference feature's domain logic issues one effect:
`GET /api/email-availability?email=<value>` returning `{ "available": boolean }`.
Without that endpoint the kernel still works correctly — it demonstrates the
typed `Failure`/`OutcomeUnknown` paths instead of `Available`/`Unavailable`.

## 6. Serve and open it

```sh
npm run build
python3 -m http.server 4173
```

Open `http://localhost:4173`.

## What you get at that point

- Typing an email and blurring the field dispatches `emailChanged` → engine
  validates/normalizes.
- Submitting flushes any pending field edits, then dispatches
  `checkAvailability` → engine issues the HTTP effect, projects
  `submitDisabled: true`, shows "Checking…".
- The kernel executes the fetch, classifies the outcome (`Success` / network
  `Failure` / `OutcomeUnknown` on timeout-after-dispatch), and hands it back
  to the engine as evidence.
- The engine transitions to `Available`, `Unavailable`, `CheckFailed`, or
  `OutcomeUnknown` and projects the corresponding `statusText`.

## Cancelling an in-flight effect

An engine can tell the kernel to stop caring about a previously requested
effect by including its `correlationId` in `EngineToBrowserMessage.cancellations`
on any later response. The kernel aborts the in-flight request and reports
`{ kind: "Cancelled" }` back through the normal `EffectResult` path — the
same path a real `Failure` or `OutcomeUnknown` takes, so the engine handles
it as ordinary evidence, not a special case.

## The Http effect: method, headers, body

Beyond the plain `GET` shown above, `HttpEffectRequest` supports any of
`"GET" | "PUT" | "POST" | "PATCH" | "DELETE"`, optional `headers`, and an
optional pre-serialized `body` string — added for a real consumer needing
`PUT /repos/{owner}/{repo}/contents/{path}`-style requests (GitHub Contents
API) with an `Authorization` header and a JSON body:

```ts
const effect: EffectRequest = {
  kind: "Http",
  correlationId,
  method: "PUT",
  url: `/repos/${owner}/${repo}/contents/${path}`,
  headers: { authorization: `token ${token}` },
  body: JSON.stringify({ message: "update", content, sha }),
  timeoutMs: 5000,
};
```

The kernel merges your `headers` over its own default (`accept:
application/json`; yours win on conflict), passes `body` straight to
`fetch()` uninterpreted, and otherwise behaves exactly as before — it still
only classifies `Success`/`Failure`/`Cancelled`/`OutcomeUnknown` at the
transport level, never a status code or response body as domain meaning.

**Secrets**: a header commonly carries a credential. The kernel never
includes `headers` or `body` in any `DiagnosticEvent` — only
`correlationId` and timing — and this is enforced by test
(`test/kernel.test.ts`: "a diagnostics sink never receives request headers
or body"). If you write your own `DiagnosticsSink`, keep that invariant:
don't log the raw `EffectRequest`/`EffectResult` objects wholesale.

## The Storage effect: get / set / remove

A `StorageEffectRequest` lets the engine read/write `localStorage` without
ever touching a browser API directly — same rule as everything else the
kernel does: WASM decides, the bridge executes.

```ts
type StorageEffectRequest =
  | { kind: "Storage"; correlationId; operation: "get"; key: string }
  | { kind: "Storage"; correlationId; operation: "set"; key: string; value: string }
  | { kind: "Storage"; correlationId; operation: "remove"; key: string };
```

The result comes back as `EffectResult { kind: "StorageResult", outcome }`,
where `outcome` is:

```ts
type StorageOutcome =
  | { kind: "Success"; value: string | null } // value is the read value for "get" (null = absent); null/unused for "set"/"remove"
  | { kind: "Failure"; reason: "unavailable" | "quota-exceeded" };
```

Unlike Http, there's no `OutcomeUnknown` — a single `localStorage` call is
effectively atomic, so there's no meaningful "dispatched but uncertain"
state the way a network request has. There's also no cancellation-in-flight
concern: the operation completes synchronously within the same effect
execution, so by the time any later response could name its
`correlationId` in `cancellations`, it has already completed and its result
already sent — naming it there is a harmless no-op, not an error.

## Known gaps

- `data-bind-value` writes are unconditional on the value's presence in the
  view; there is no built-in "only replace on canonicalization" heuristic
  beyond skipping the write when the value is unchanged (see §8 of the
  zero-authoritative spec on input editing).
- Checkbox/radio state is read/written as `.value`, not `.checked`; binding a
  boolean control's checked state requires `data-bind-checked` explicitly and
  reading it back isn't wired into `data-event` yet.
- Browser capability commands beyond Http/Storage (focus, clipboard,
  navigation, files) aren't implemented. See [ROADMAP.md](ROADMAP.md) for
  what's built, what's planned, and what's deliberately deferred.
