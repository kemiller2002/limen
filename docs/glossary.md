# Glossary

Terms as this repository uses them. Where the codebase uses more than one name
for a concept, the canonical choice is marked and the aliases listed.

---

### Authoritative state

The one copy of application state that is correct by definition. Lives in the
engine. If anything else disagrees with it, the other thing is wrong.
See [04-state-model.md](https://github.com/kemiller2002/limen/blob/main/docs/04-state-model.md).

### Binding

A `data-*` attribute connecting a DOM element to the protocol: an event name to
send, or a view key to display. Collected once during `start()`.

### Bridge

**Alias for kernel.** Used interchangeably in the source comments and in
`ROADMAP.md`. **Canonical term: kernel**, since that is what the class is called
(`BrowserKernel`). "Bridge" survives where the emphasis is on its role as a
connector rather than as a component.

### Capability (1) — a UI permission

A projected value answering "may the user do this right now?" — `saveDisabled`,
`canRetry`. Projected explicitly by the engine, never re-derived by the DOM.

### Capability (2) — a browser facility

An effect kind the kernel can perform. Currently `Http`, `Storage`, `Clipboard`
(write only) and `Navigation`, announced
in `Initialize.capabilities`.

> ⚠️ **These two senses are genuinely distinct** and the codebase uses both.
> Context disambiguates, but be aware of it. Recorded as finding **N-1** in
> [DOCUMENTATION-AUDIT.md](https://github.com/kemiller2002/limen/blob/main/docs/DOCUMENTATION-AUDIT.md).

### Command

A typed, closed-vocabulary instruction produced by the engine from a
`SemanticEvent` or an `EffectResult`, and consumed by `transition()`. Commands
are internal to the engine — they never cross the protocol boundary.

### Correlation ID

A branded string identifying one effect request, quoted back in its result. Held
inside the state that is waiting on it, so a stale result can be rejected.

### Diagnostics / `DiagnosticsSink`

An injectable observer of bridge mechanism failures and effect timing. Never
carries domain meaning, and never request headers or bodies. Defaults to a
no-op — which is why bridge errors are silent unless you supply one.

### Dispatch

Sending a message from the kernel to the engine, via `EngineTransport.dispatch`.
Happens synchronously inside a DOM event's own call chain; the response is
applied after a microtask boundary.

### Effect

External work the engine cannot do itself. Requested as an `EffectRequest`,
performed by the kernel, reported back as an `EffectResult`.

### Effect outcome

How an effect turned out, as a discriminated union. **Each capability has its
own**, because their failure modes genuinely differ — a shared type would force
every caller to handle variants that cannot occur.

| Capability | Variants |
| --- | --- |
| Http | `Success` · `Failure{network\|aborted\|invalid-response}` · `Cancelled` · `OutcomeUnknown{timeout-after-dispatch}` |
| Storage | `Success{value}` · `Failure{unavailable\|quota-exceeded}` |
| Clipboard | `Success` · `Failure{denied\|unavailable\|unknown}` |
| Navigation | `Success{location}` · `Dispatched` · `Failure{unavailable\|not-same-origin}` |

### Engine

**Canonical name** for the component owning application meaning: state,
transitions, validation, projection. The package includes a TypeScript reference
engine under `src/engine/`; the product site uses an F# engine under
`site/fsharp/Limen.Site.Engine/` compiled to WebAssembly.

> Aliases seen in older text: "WASM kernel", "the WASM side", "application
> layer". **Prefer "engine"** because engine language/transport is independent
> of the Limen kernel. See
> [17-wasm-migration.md](https://github.com/kemiller2002/limen/blob/main/docs/17-wasm-migration.md).

### Evidence

What the engine actually receives about the outside world: a classified outcome
at a moment in time, not the truth itself. The distinction is what makes
`OutcomeUnknown` representable.

### Illegal transition

A command that is not legal from the current state. Rejected explicitly, leaving
state unchanged — never silently ignored.

### Host

Not used as a term in this codebase. Where other projects say "host" for the
JavaScript side of a WASM boundary, this one says **kernel**.

### `Initialize`

The first message the kernel sends, carrying `protocolVersion`, `capabilities`
and the `BrowserLocation` the page was loaded at. Its response is an ordinary
`EngineToBrowserMessage` and may carry effects — which is how startup loads
happen, and the location is how a routing engine picks its first screen without
rendering a default first.

### `BrowserLocation`

The current URL, split by the kernel into `path`, `query` and `hash`, and not
interpreted further. The origin is deliberately absent. Splitting is browser
mechanism; deciding that `/invoices/42` names an invoice is application
meaning.

### `LocationChanged`

The message the kernel sends when the browser moved through history **on its
own** — Back, Forward, or a gesture. It is not an `EffectResult`, because no
effect was requested and nothing correlates it. An engine that ignores it still
works; it simply will not react to Back.

### Route

An engine-defined type describing what a URL means — `Home`, `Invoice(id)`,
`NotFound(raw)`. Limen has no route table and no path matching: `parseRoute`
and `routeToUrl` are functions you write. See [routing.md](https://github.com/kemiller2002/limen/blob/main/docs/routing.md).

### Interop

Reaching a browser facility from the engine. Always through an `EffectRequest`;
never directly. See
[07-effects-and-browser-interop.md](https://github.com/kemiller2002/limen/blob/main/docs/07-effects-and-browser-interop.md).

### Kernel

**Canonical name** for the generic bridge, `src/kernel/browser-kernel.ts`. The
only code permitted to touch `document`, `window`, `fetch`, or `localStorage`.
Understands six `data-*` attributes and interprets none of them.

Say **"the Limen kernel"** where the bridge could be confused with the product.

> ⚠️ Note the collision: "kernel" here means the **browser-side bridge**, but
> the package is named `typescript-wasm-kernel` and `ROADMAP.md`'s mental-model
> diagram once labelled the *engine* as "WASM Kernel". Recorded as finding
> **N-1**; the product is now named [Limen](https://github.com/kemiller2002/limen/blob/main/docs/18-naming-and-compatibility.md),
> which resolves the product-level half of the collision.

### Limen

**The product name** for this architecture: an explicit boundary keeping
browser capabilities separate from application authority. Latin for
*threshold* — the stone at the base of a doorway.

Limen is the whole: the contract in `src/protocol.ts`, the kernel that
implements the browser side, and the rules governing what may live where. It is
**not** a synonym for the kernel alone, and not a synonym for the engine.

The npm package is still `@echelon-foundry/typescript-wasm-kernel`; the GitHub
repository is now `kemiller2002/limen`, while package and API compatibility
identifiers remain unchanged. See [18-naming-and-compatibility.md](https://github.com/kemiller2002/limen/blob/main/docs/18-naming-and-compatibility.md).

> Discouraged aliases: "the WASM kernel", "the TypeScript WASM kernel".
> WebAssembly may exist behind `EngineTransport`, as it does for the product
> site, but the **kernel** is the TypeScript browser boundary, not the WASM
> engine. See
> [17-wasm-migration.md](https://github.com/kemiller2002/limen/blob/main/docs/17-wasm-migration.md).

### `OutcomeUnknown`

An Http request that timed out **after dispatch**. It may or may not have been
processed. Not a failure, and not safely retryable for a non-idempotent method.

### Projection

The pure function `state → ViewState`, and its output. A complete description of
what to show, never a patch. Must be total for every mounted binding.

### `ViewState` / view

A flat record of named values the DOM may bind to. Only strings, numbers,
booleans, and flat arrays of records of those. Cannot represent markup or nested
lists.

### Protocol

The contract in [`src/protocol.ts`](https://github.com/kemiller2002/limen/blob/main/src/protocol.ts): message types, effect
types, `EngineTransport`. Plain, JSON-serializable data.

### Reference engine / reference feature

`ReferenceEngine` and the email-availability demo in `index.html`. A worked
example of the architecture, **not** a base class. Do not build on
`DirectTypeScriptTransport`.

### Round trip

One complete cycle: message → engine → response → applied view (+ effects). An
effect result begins a *second, independent* round trip — it is not a return
value.

### `SemanticEvent`

What a DOM interaction becomes: `{ name, key?, value? }`. No element id, no DOM
node, no event object. "Semantic" because it names the user's intent, not the
mechanism.

### Source of truth

Synonym for authoritative state. There is exactly one, and it is in the engine.

### Stale evidence / stale result

An `EffectResult` whose `correlationId` does not match what the state is waiting
on. Must be discarded.

### Transition

The pure function `(state, command) → state` (often plus effects). The only
thing permitted to change authoritative state.

### Transport

An implementation of `EngineTransport` — the object the kernel actually talks
to. `DirectTypeScriptTransport` is the shipped one; you write your own.

---

## Terms deliberately absent

Concepts that do **not** exist here. If you find yourself reaching for one, the
design has drifted.

| Term | Why it doesn't apply |
| --- | --- |
| Component | No component model. Screens are `data-if` templates; there is no lifecycle. |
| Virtual DOM / reconciler | No VDOM. Only keyed list reconciliation. |
| Store / reducer / action creator | The engine is not a Redux-style store. Commands are not actions. |
| Hook / subscription | No subscription API. The kernel applies whole projections. |
| Router | Not implemented — and not planned. There is a `Navigation` **capability** (push, replace, back, forward, and the browser's own moves), but no route table and no path matching. What a URL means is the engine's decision, which is the point. See [routing.md](https://github.com/kemiller2002/limen/blob/main/docs/routing.md). |
| Middleware | Nothing intercepts the round trip except the error boundary. |
| Selector | Projections are computed wholesale, not selected or memoized. |
| Two-way binding | `data-bind-value` writes *to* the DOM; reads come back only as events. |

---

## Recommended usage

| Prefer | Over | Because |
| --- | --- | --- |
| **Limen** | "the WASM kernel", "the TypeScript WASM kernel" | names the architecture, not a wrong technology |
| **engine** | "WASM kernel", "application layer" | the engine may be TypeScript, F# WASM, or another transport-compatible implementation |
| **kernel** / **the Limen kernel** | "bridge", "host", "JS layer" | matches the class name |
| **projection** | "render", "view model" | nothing is rendered by the engine |
| **effect request** | "side effect", "API call" | names the boundary crossing |
| **transition** | "handler", "reducer" | names the function's contract |
| **evidence** | "response", "server data" | keeps the epistemics honest |
