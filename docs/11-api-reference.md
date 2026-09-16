# API reference

**What this answers:** exact signatures, semantics, and failure modes of
everything a consumer uses.

Source of truth: [`src/protocol.ts`](../src/protocol.ts),
[`src/kernel/browser-kernel.ts`](../src/kernel/browser-kernel.ts),
[`src/kernel/diagnostics.ts`](../src/kernel/diagnostics.ts),
[`src/index.ts`](../src/index.ts).

---

## Stability tiers

Know what you are allowed to depend on.

| Tier | What | Examples |
| --- | --- | --- |
| **Stable public interface** | The contract consumers build on. Changes are breaking. | `BrowserKernel`, `EngineTransport`, `SemanticEvent`, `ViewState`, `EffectRequest`, `EffectResult`, `EffectOutcome`, `StorageOutcome`, `PROTOCOL_VERSION`, the six `data-*` attributes |
| **Supported extension point** | Designed to be implemented or supplied by you. | `EngineTransport` (write your own), `DiagnosticsSink` (supply your own) |
| **Reference implementation** | Ships, but is this repo's demo. Do **not** build on it. | `DirectTypeScriptTransport`, `ReferenceEngine`, `project`, `State`, `Command`, `TransitionResult`, `EmailAddress` |
| **Internal** | Private; may change without notice. | every `#`-prefixed member of `BrowserKernel`, `Scope`/binding types, `TRIGGER_BY_TAG`, `BOOLEAN_PROPS` |
| **Experimental** | None currently. | — |
| **Deprecated** | None currently. | — |

### Stability and compatibility

- **Versioning**: semver. Currently `0.x`, so the protocol **may change in a
  minor release**. Pin an exact version if that matters to you.
- **`PROTOCOL_VERSION`** is `1`. The kernel sends it in `Initialize`; an engine
  should reject a version it does not understand, as `ReferenceEngine` does.
- **No written breaking-change policy exists** for `0.x` beyond semver itself.
  That is a genuine gap, not an implied guarantee — see
  [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md).
- **Browsers**: ES2022 modules, `fetch`, `AbortController`, `AbortSignal.reason`,
  `<template>`. Chrome/Edge 98+, Firefox 97+, Safari 15.4+.
- **Node** ≥ 22 to build and test. **TypeScript** ≥ 5.9 for the types.
- **Runtime dependencies**: none.

---

## Entry points

```ts
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
import type { ViewState } from "@echelon-foundry/typescript-wasm-kernel/protocol";
```

| Specifier | Contents |
| --- | --- |
| `@echelon-foundry/typescript-wasm-kernel` | everything in [`src/index.ts`](../src/index.ts) |
| `…/protocol` | the protocol types |
| `…/kernel` | `BrowserKernel` alone |
| `…/reference-engine` | `DirectTypeScriptTransport` — reference only |

`moduleResolution` must be `"bundler"`, `"node16"`, or `"nodenext"`; older modes
do not read `exports`.

---

## `BrowserKernel`

The bridge. One per page.

```ts
class BrowserKernel {
  constructor(transport: EngineTransport, document: Document, diagnostics?: DiagnosticsSink);
  readonly transport: EngineTransport;
  readonly document: Document;
  start(): Promise<void>;
}
```

### `constructor(transport, document, diagnostics?)`

| Parameter | Type | Notes |
| --- | --- | --- |
| `transport` | `EngineTransport` | your engine. Required. |
| `document` | `Document` | normally the global `document`; injectable for tests. |
| `diagnostics` | `DiagnosticsSink` | optional. **Defaults to a no-op** — without it, bridge errors are silent. |

Construction is inert: nothing is bound, dispatched, or touched until `start()`.

### `start(): Promise<void>`

Performs, in order:

1. `await transport.start()` — **if this rejects, reports
   `BridgeError { phase: "dispatch" }` and returns. Nothing is bound.**
2. Recursively binds `document.body`, collecting all `data-*` bindings. **If a
   binding is malformed** — `data-each` without `data-key`, a `data-if` on a
   non-`<template>` element, a template with more than one root — it reports
   `BridgeError { phase: "binding" }` and returns without dispatching
   `Initialize`.
3. Dispatches `Initialize { protocolVersion: 1, capabilities: ["Http", "Storage"] }`.

**Never rejects.** All failures go to diagnostics. The page stays at its
placeholder content, which is the visible symptom of a failure in step 1 or 2.

**Call exactly once.** A second call re-binds the document and double-registers
every listener, so each event dispatches twice.

```ts
const kernel = new BrowserKernel(createTransport(), document, {
  report(event) { if (event.kind === "BridgeError") console.error(event.phase, event.detail); },
});
await kernel.start();
```

**Common mistakes**: calling `start()` again to force a re-render (trigger a
real event instead); expecting a throw on failure (install a sink); binding
elements added to the DOM afterwards (only `data-if`/`data-each` add bindable
content later).

**There is no `stop()`, `destroy()`, or `unbind()`.** Listeners live as long as
the page.

---

## `EngineTransport`

The extension point. Implementing this is how you write an application.

```ts
interface EngineTransport {
  start(): Promise<void>;
  dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage>;
}
```

### `start()`

Called once, first. Where a WebAssembly transport would fetch and instantiate
its module. For an in-process engine, an empty async function.

A rejection aborts kernel startup entirely.

### `dispatch(message)`

Called for **every** message: `Initialize`, each `Event`, and each
`EffectResult`. Must resolve to a complete `EngineToBrowserMessage`.

- Must return a **complete** `ViewState` every time — it is not a patch.
- May return effects, including from `Initialize`.
- A rejection is caught, reported as `BridgeError { phase: "dispatch" }`, and
  leaves the DOM unchanged.

```ts
export function createTransport(): EngineTransport {
  let state = initialState;
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (message.kind === "Event") state = transition(state, eventToCommand(message.event.name));
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}
```

**Common mistakes**: returning a partial view (bound keys must all be present);
performing effects yourself instead of requesting them; forgetting that
`Initialize` also needs a view.

---

## Messages

### `BrowserToEngineMessage`

```ts
type BrowserToEngineMessage =
  | { kind: "Initialize"; protocolVersion: 1; capabilities: readonly ["Http", "Storage"] }
  | { kind: "Event";        event:  SemanticEvent }
  | { kind: "EffectResult"; result: EffectResult };
```

### `EngineToBrowserMessage`

```ts
type EngineToBrowserMessage = {
  readonly view:          ViewState;
  readonly effects:       readonly EffectRequest[];
  readonly cancellations: readonly CorrelationId[];
};
```

All three fields are required. Use `[]` for empty.

Applied in order: **view first**, then cancellations, then effects — all effects
concurrently. So the UI updates before slow work begins.

### `SemanticEvent`

```ts
type SemanticEvent = {
  readonly kind: "Event";
  readonly name:   string;   // the data-event value, verbatim
  readonly key?:   string;   // enclosing data-each item's key
  readonly value?: string;   // .value of an input/select/textarea
};
```

`value` is always a string, even for `type="number"`. No element id, no DOM
node, no event object.

---

## View types

```ts
type ViewPrimitive = string | number | boolean;
type ViewItem      = { readonly [field: string]: ViewPrimitive };
type ViewValue     = ViewPrimitive | readonly ViewItem[];
type ViewState     = { readonly [key: string]: ViewValue };
```

`ViewItem` admits only primitives, so **nested lists are not representable**.

| Binding | Requires | If wrong |
| --- | --- | --- |
| `data-text` | a scalar | **throws** — `View value for "x" is missing or not scalar` |
| `data-bind-*` | a scalar | **throws** |
| `data-if` | anything | missing ⇒ falsy ⇒ **silently unmounted** |
| `data-each` | an array | **throws** — `requires an array view value` |

That asymmetry on `data-if` is the most common silent failure. See
[16-troubleshooting.md](16-troubleshooting.md).

---

## Effects

### `CorrelationId`

```ts
type CorrelationId = string & { readonly __correlationId: unique symbol };
```

A branded string — construct with `"load-1" as CorrelationId`. The brand exists
so an arbitrary string cannot be passed by accident.

### `HttpEffectRequest`

```ts
type HttpEffectRequest = {
  readonly kind: "Http";
  readonly correlationId: CorrelationId;
  readonly method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;      // pre-serialized; never interpreted
  readonly timeoutMs: number;  // required
};
```

Headers merge over the kernel's `accept: application/json`; yours win.
Headers and body are **never** included in diagnostics.

### `StorageEffectRequest`

```ts
type StorageEffectRequest =
  | { kind: "Storage"; correlationId; operation: "get";    key: string }
  | { kind: "Storage"; correlationId; operation: "set";    key: string; value: string }
  | { kind: "Storage"; correlationId; operation: "remove"; key: string };
```

`localStorage` only.

### `EffectOutcome` (Http)

```ts
type EffectOutcome =
  | { kind: "Success";        status: number; body: unknown }
  | { kind: "Failure";        reason: "network" | "aborted" | "invalid-response"; status?: number }
  | { kind: "Cancelled" }
  | { kind: "OutcomeUnknown"; reason: "timeout-after-dispatch" };
```

| Outcome | Produced when |
| --- | --- |
| `Success` | a response arrived **and `.json()` parsed** — any status, including 500 |
| `Failure { network }` | `fetch` threw and was not aborted. **No `status`** — nothing came back |
| `Failure { invalid-response, status }` | a response arrived but would not decode. **Carries the status** |

> **`status` is present exactly when a response was received.** Its absence
> means nothing came back. This matters more than it looks: most servers return
> **HTML** error pages, so a 404 or 500 usually arrives as
> `Failure { invalid-response, status: 404 }` rather than as a `Success`. Without
> the status, that would be indistinguishable from a `200` carrying malformed
> JSON — and the first is often worth retrying while the second never is.
| `Failure { aborted }` | aborted for neither `"cancelled"` nor `"timeout"` |
| `Cancelled` | aborted with reason `"cancelled"` |
| `OutcomeUnknown` | aborted with reason `"timeout"` — **never a `Failure`** |

`body` is `unknown`: parsed, not validated. Narrow it yourself.

### `StorageOutcome`

```ts
type StorageOutcome =
  | { kind: "Success"; value: string | null }
  | { kind: "Failure"; reason: "unavailable" | "quota-exceeded" };
```

`value` is the read value for `get` (`null` = absent, a normal outcome);
`null`/unused for `set`/`remove`. No `OutcomeUnknown` — a single `localStorage`
call is atomic.

### `EffectResult`

```ts
type EffectResult =
  | { kind: "HttpResult";    correlationId: CorrelationId; outcome: EffectOutcome }
  | { kind: "StorageResult"; correlationId: CorrelationId; outcome: StorageOutcome };
```

---

## `DiagnosticsSink`

```ts
interface DiagnosticsSink { report(event: DiagnosticEvent): void; }

type DiagnosticEvent =
  | { kind: "BridgeError";  phase: "dispatch" | "binding" | "projection" | "effect"; detail: string }
  | { kind: "EffectTiming"; correlationId: CorrelationId; durationMs: number };

const noopDiagnostics: DiagnosticsSink;   // the default
```

Bridge mechanism only — never domain meaning. `report` should not throw and
should be cheap. **Do not log raw effect objects**; headers carry credentials.

---

## Reference-only exports

```ts
class DirectTypeScriptTransport implements EngineTransport { … }
class ReferenceEngine { get state(): State; handle(m): EngineToBrowserMessage; }
function project(state: State): ViewState;
```

⚠️ **`DirectTypeScriptTransport` is hard-wired to this repository's demo domain**
(email availability). It understands exactly two event names — `emailChanged`
and `checkAvailability` — and throws on anything else. It is not a base class
and not a starting point. Write your own `EngineTransport`; it is about eight
lines ([02-getting-started.md](02-getting-started.md)).

`ReferenceEngine.handle()` also throws on a `StorageResult`, because its domain
never requests a Storage effect.

---

## The `data-*` vocabulary

The kernel's complete DOM surface.

| Attribute | Purpose | Notes |
| --- | --- | --- |
| `data-event="name"` | dispatch `SemanticEvent { name }` | trigger defaults by tag |
| `data-on="type"` | override the DOM event type | any type; no allow-list |
| `data-text="key"` | `textContent = view[key]` | throws if missing/non-scalar |
| `data-bind-<attr>="key"` | set attribute or property | see below |
| `data-if="key"` | mount/unmount a `<template>` | **`<template>` only**; one root element; missing key ⇒ falsy |
| `data-each="key"` | repeat a `<template>` | **`<template>` only**; **requires `data-key`** |
| `data-key="field"` | item identity for `data-each` | must be stable and unique |

Default triggers: `<form>` → `submit` (with `preventDefault`);
`<input>`/`<select>`/`<textarea>` → `change`; everything else → `click`.

`data-bind-` targets: `disabled`, `checked`, `selected`, `hidden`, `open` are
set as **boolean properties**; `value` is set as a property and skipped if
unchanged; everything else uses `setAttribute`.

---

## Related

- [05-events-and-dispatch.md](05-events-and-dispatch.md) — the inbound half
- [06-rendering.md](06-rendering.md) — the outbound half
- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — effects
- [glossary.md](glossary.md) — terminology
