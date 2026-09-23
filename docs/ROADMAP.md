# Bridge Responsibility Roadmap

Tracks the TypeScript kernel's mechanism responsibilities against what is
actually implemented and tested — not what's aspirational. Update the status
next to the code, not ahead of it.

## Mental model

```text
HTML/CSS
    ↓ events
Limen BrowserKernel
    ↓ BrowserToEngineMessage
EngineTransport
    ↓
Application engine
    ↓ EngineToBrowserMessage
Limen BrowserKernel
    ↓
Browser APIs + DOM
```

The package remains transport-neutral. Two concrete engine shapes now exist:

- `DirectTypeScriptTransport` + `ReferenceEngine` for the package examples;
- `WasmSiteTransport` + the F# `Limen.Site.Engine` for the product site.

The site therefore crosses a real WebAssembly/JSON boundary while the kernel
itself remains unaware of the engine language. "Kernel" continues to mean the
browser-side bridge, never the F# application engine. See
[17-wasm-migration.md](17-wasm-migration.md), [glossary.md](glossary.md), and
the historical finding A-2 in [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md).

The bridge (`src/kernel/browser-kernel.ts`) is the only layer permitted to
touch `document`, `window`, `fetch`, or `localStorage`. The engine (`src/engine/`) never sees
a DOM node, an element id, or a browser API — only `SemanticEvent`,
`ViewState`, `EffectRequest`, and `EffectResult` (`src/protocol.ts`), each a
plain, JSON-serializable value.

## Status legend

- ✅ **Implemented & tested** — real code, exercised by `test/*.test.ts`.
- ⚠️ **Partial** — the mechanism exists but a named sub-case doesn't yet.
- 🧊 **Deferred** — a genuine kernel responsibility, not yet built because no
  feature has demonstrated the need. Per
  [`prompts/minimal-typescript-browser-kernel-responsibility-spec.md`](../prompts/minimal-typescript-browser-kernel-responsibility-spec.md)
  §29 ("these should not all exist in Kernel Core") and
  [`prompts/dependency-minimal-browser-kernel-architecture-policy.md`](../prompts/dependency-minimal-browser-kernel-architecture-policy.md)
  §11, building ahead of a real requirement is itself an architecture
  violation here, not a shortcut — it would be untested surface area with no
  feature to validate the design against. Building on request is expected;
  building speculatively is not.

## Responsibilities

| # | Responsibility | Status | Where | Tests |
|---|---|---|---|---|
| 1 | Engine lifecycle — load, initialize, version-check | ✅ Demonstrated | `BrowserKernel.start()` awaits the transport, then dispatches `Initialize` with `PROTOCOL_VERSION`. The product site's `WasmSiteTransport.start()` loads the .NET WebAssembly runtime, while F# `Dispatch` rejects a mismatched version. The kernel remains transport-neutral. | `kernel.test.ts` lifecycle tests; F# site-engine serialized-dispatch tests; site artifact check requires the WASM runtime |
| 2 | Command dispatch | ✅ | `#bindEvent` / `#fire` | `kernel.test.ts` event-dispatch tests |
| 3 | Projection rendering | ✅ | `#applyScope`, `#applyIf`, `#applyEach` | `kernel.test.ts` projection tests |
| 4 | Effect execution | ⚠️ Partial | Http (`#runHttp`, any of `GET`/`PUT`/`POST`/`PATCH`/`DELETE`, caller headers merged over the default, opaque pre-serialized body), Storage (`#executeStorage`/`runStorage`, `localStorage`-backed), Clipboard (`writeClipboardText`, write-only) and Navigation (`runNavigation`, push/replace/back/forward). An effect kind the kernel does not implement is reported as `BridgeError` phase `"effect"` rather than silently dropped. File/auth adapters and clipboard *read*: 🧊 deferred, see below. | `kernel.test.ts` effect-execution tests |
| 5 | Effect result return — Succeeded/Failed/Cancelled/OutcomeUnknown | ✅ | `EffectOutcome` in `protocol.ts` now carries all four (`Success`, `Failure`, `Cancelled`, `OutcomeUnknown`); `#classifyAbort` in the kernel classifies transport-level outcomes only, never business meaning | `kernel.test.ts`: Success/Failure(network)/Failure(invalid-response)/OutcomeUnknown/Cancelled — one test each |
| 6 | DOM event wiring — click/input/change/submit/keyboard/focus | ✅ | `TRIGGER_BY_TAG` maps the exceptions (`form`→submit, `input`/`select`/`textarea`→change); everything else defaults to `click`; `data-on` overrides to any DOM event type, including keyboard/focus events — no special-casing needed since the trigger is data-driven | `kernel.test.ts`: default triggers + `data-on` override |
| 7 | Form value extraction | ✅ | `readValue()` | covered by event-dispatch tests |
| 8 | Browser navigation/history | ✅ | `Navigation` effect (`push`/`replace`/`back`/`forward`), the `LocationChanged` message on `popstate`, and the loaded URL delivered in `Initialize`. The kernel splits a URL into path/query/hash and stops; route *meaning* stays in the engine. Cross-origin navigation is refused (`not-same-origin`); no history state object is stored, so the engine remains the only source of truth for what a URL stands for. Worked example: `examples/08-routing/`, guide: `docs/routing.md`. | `kernel.test.ts` navigation tests; `examples.test.ts` 08-routing tests |
| 9 | Rendering helpers — text/attributes/visibility/lists/replace-update fragments | ✅ | `data-text`, `data-bind-<attr>` (visibility via `data-bind-hidden`), `data-each`, `data-if`. Arbitrary fragment replace/insert beyond keyed templates is deliberately unsupported — reconciliation is intentionally restricted to keyed repeated templates (zero-authoritative spec §25) | `kernel.test.ts` projection + list tests |
| 10 | List rendering | ✅ (virtualization 🧊 deferred) | Keyed reconciliation preserves DOM node identity across reorder (`#applyEach`). Windowing/virtualization: no evidence yet that any list is large enough to need it — spec §30/§31 calls for measuring at 1k/10k/100k/1M records before optimizing. | `kernel.test.ts`: add/remove/reorder-preserves-identity |
| 11 | Browser-local presentation state — focus, popovers, animation, pointer | ✅ by design | Left entirely to CSS/native browser behavior; the kernel does not track or synchronize any of it (`architecture.yaml`, zero-authoritative spec §4.3) | N/A — no kernel code exists to test |
| 12 | Serialization boundary | ✅ Demonstrated for real F# consumers | `DirectTypeScriptTransport` remains in-process, but the product site serializes `BrowserToEngineMessage` to JSON, F# parses it, and F# serializes `EngineToBrowserMessage` back. The external time-entry consumer uses the same pattern. A generic codec is not part of the npm API because serialization belongs to the chosen transport. | F# site-engine serialized-dispatch tests; `test/site.test.ts`; product-site artifact checks |
| 13 | Error boundary | ✅ | Every engine round-trip funnels through one chokepoint, `#send()`. A transport throw or a malformed projection is caught, reported via diagnostics, and does not propagate or leave a half-applied view. | `kernel.test.ts`: "a transport.dispatch() rejection is reported…", "a malformed projection is reported…" |
| 14 | Diagnostics hooks | ✅ | `src/kernel/diagnostics.ts` — injectable `DiagnosticsSink`, defaults to a no-op. Reports `BridgeError` in four phases — `dispatch` (the transport threw or its `start()` rejected), `binding` (malformed markup, e.g. `data-each` without `data-key`), `projection` (a view key missing or not scalar) and `effect` (an effect kind the kernel cannot run) — and `EffectTiming`. | `kernel.test.ts`: "the kernel reports effect timing…", both error-boundary tests |
| 15 | Accessibility plumbing | ⚠️ Partial | `aria-live` regions work today because they're native HTML the kernel already updates via `data-text`/`textContent` (see `index.html`'s status paragraph) — no special kernel code needed. Focus restoration (e.g. after a keyed list item is removed) is 🧊 deferred, no demonstrated need yet. | — |
| 16 | Scheduling primitives — rAF/timers/idle callbacks | 🧊 Deferred | No feature currently needs debounced/scheduled semantic events; the coalesce/debounce allowance in zero-authoritative spec §15 is explicitly evidence-driven, not default. | — |
| 17 | File/browser API adapters | ⚠️ Partial | Clipboard **write** implemented (`ClipboardEffectRequest`, `writeClipboardText`); guide in `docs/clipboard.md`, worked example in `examples/07-clipboard/`. Clipboard **read** is deliberately absent, not deferred: it would let an engine pull whatever the user last copied across the boundary unprompted. Files, geolocation, notifications, media: 🧊 deferred. | `kernel.test.ts` clipboard tests; `examples.test.ts` 07-clipboard tests |
| 18 | Storage adapters | ✅ (`localStorage` only) | `StorageEffectRequest`/`StorageOutcome` in `protocol.ts`; `#executeStorage`/`runStorage` in the kernel. `get`/`set`/`remove` only, no `IndexedDB`/`Cache API` — build those when a feature demonstrates the need, same 🧊 policy as everything else here. No `OutcomeUnknown`: a single `localStorage` call is effectively atomic, so unlike Http there's no meaningful "dispatched but uncertain" state; failures classify as `unavailable` or `quota-exceeded`. | `kernel.test.ts`: set→get round-trip, remove→get reports `null`, quota-exceeded classification, stale-cancellation-is-a-no-op |
| 19 | Network adapter | ✅ | `#runHttp` — classifies transport-level outcomes only (`Success`/`Failure`/`Cancelled`/`OutcomeUnknown`), never interprets a status code or decoded body as domain truth (per responsibility-spec §17: "TypeScript must not interpret business meaning"). Extended beyond `GET` to any of `PUT`/`POST`/`PATCH`/`DELETE` with caller-supplied headers (merged over the kernel's own `accept` default) and an opaque pre-serialized body — added for a real consumer's GitHub Contents API write (`PUT` + `Authorization` header + JSON body). Headers/body are never surfaced in a `DiagnosticEvent`. | `kernel.test.ts`: PUT with headers+body reaches `fetch()` correctly, GET omits body entirely, diagnostics never contain header/body content |

## Federated application engines

| # | Responsibility | Status | Where | Tests |
|---|---|---|---|---|
| 20 | Multi-engine federation — module manifests, independent lifecycle, versioned envelope exchange, targeted transitions and event fan-out | ✅ Runtime implemented; ⚠️ multi-F#-WASM self-hosting not yet demonstrated | `src/federation.ts`; [23-wasm-federation.md](23-wasm-federation.md). The coordinator validates protocol/contract compatibility, dependencies, capabilities and source identity but owns no domain state. | `test/federation.test.ts`: lifecycle, illegal lifecycle, transition round-trip, contract mismatch, spoofing, fan-out, explicit targeting, dependency/capability preflight and cycle limit |

The federation capability is intentionally separate from the browser/engine
`PROTOCOL_VERSION`. It composes application engines; it does not move browser
capabilities or application meaning into the coordinator.

The current product site remains one F# WASM consumer. Converting it into
multiple independent WASM binaries is a separate existence proof and will be
reported only after it actually runs that way.

## Cross-cutting: cancellation

Not on the original list by name inside item 5, but required to make
"Cancelled" a real outcome rather than a declared-but-unreachable union
member: `EngineToBrowserMessage.cancellations: readonly CorrelationId[]`
lets the engine tell the kernel it no longer wants a previously requested
effect's result. The kernel aborts the matching in-flight `AbortController`
and reports `Cancelled` back through the ordinary `EffectResult` path — the
engine handles it as evidence, the same as any other outcome, not as a
special control-flow case. See "Cancelling an in-flight effect" in
[USAGE.md](USAGE.md).

## Extension history

Item 4/18/19's Storage effect and Http `method`/`headers`/`body` extension
were added in response to a real, filed extension request —
`input-document/time-entry-state-machine-extension-request.md` — from an
actual consumer application blocked on both, not built speculatively. That
document is this repo's own required evidence trail for building ahead of
the reference feature's needs (see the 🧊 status legend above); it's kept in
place after the fact as the record of *why*, not deleted once implemented.

## SHOULD NOT CONTAIN (invariants)

| Rule | Enforcement |
|---|---|
| Business rules, workflow rules, authorization decisions, domain validation | Mechanical: `scripts/check-architecture.ts` bans `document`/`window`/`fetch(`/`localStorage`/`sessionStorage` and the words `any`/`dynamic` inside `src/engine/**`, and forbids browser deps there per `architecture.yaml`'s `browser_interop.forbidden_modules: [engine]`. The kernel's own vocabulary (`SemanticEvent.name`, `ViewState` keys) is opaque strings it never branches on by meaning — only `src/engine/domain.ts` interprets them. |
| Application state stores, Redux-style reducers | Not mechanically enforced — there is exactly one piece of mutable application state in the whole system (`ReferenceEngine.#state`), and it lives in the engine. Code review should reject a second one appearing in the kernel. |
| Domain sorting/filtering/search semantics | Not applicable yet — no feature has needed sort/filter/search. `data-each` repeats whatever array the engine already decided to project; the kernel never reorders or excludes items on its own. |
| Effect orchestration | The kernel executes exactly one effect per `EffectRequest` and reports exactly one `EffectResult`; it never sequences, retries, batches, or interprets multiple effects together. That policy (if ever needed — e.g. retry-on-network-failure) belongs in the engine, which re-requests the effect. |
| Duplicated kernel state | The kernel's only persistent state is bridge bookkeeping — `#controllers` (in-flight `AbortController`s, keyed by `CorrelationId`), `#flushable` (per-form pending-field callbacks), and each `Scope`'s binding lists. None of it mirrors engine state; all of it is DOM-identity bookkeeping the engine has no reason to know about. |

## Known contradiction between prior specs (unresolved, documented per project policy)

`prompts/minimal-typescript-browser-kernel-responsibility-spec.md` §36
specifies an imperative `ViewChange[]`/element-id op-list protocol
(`SetText(target, value)`). `prompts/zero-authoritative-javascript-web-architecture-spec-v0.1.md`
§11 specifies the declarative `data-*` binding model that's actually
implemented (`ViewState` + `data-text`/`data-bind-*`/`data-if`/`data-each`).
The two documents disagree on the engine↔browser protocol shape. This
roadmap and the current implementation follow the latter, per explicit
direction; the former's intent is preserved here as a record rather than
silently deleted.

## Test coverage summary

- `test/domain.test.ts` — TypeScript reference-engine level: state/transition
  legality, stale evidence rejection, the generic event→command mapping's
  closed vocabulary.
- `site/fsharp/tests/Limen.Site.Engine.Tests/` — product-site F# engine:
  release evidence/approval gates, stale deployment evidence, unknown-effect
  reconciliation, stale policy evidence, projected capabilities, and serialized
  Limen dispatch.
- `test/kernel.test.ts` — bridge-level, against a real DOM (`jsdom`, dev
  dependency only — see `test/dom-helpers.ts`'s header comment for why a
  hand-rolled DOM shim was rejected in favor of a mature, standards-compliant
  one). 39 tests covering lifecycle, command dispatch, projection
  (text/attr/if/each), effect execution and all four `EffectOutcome`
  variants, the extended Http effect (method/headers/body reaching `fetch()`
  correctly, headers/body never reaching diagnostics), the Storage effect
  (get/set/remove round-trip, quota-exceeded classification, stale
  cancellation as a no-op), the error boundary, and diagnostics.
- `scripts/check-architecture.ts` (run as part of `npm test`) — the one
  mechanically enforced invariant: no browser dependency or dynamic-type
  escape inside `src/engine/**`.

Two real bugs were caught by writing `kernel.test.ts` against jsdom rather
than by the earlier ad hoc manual browser check: `data-text`/`data-event`
declared directly on a `data-each`/`data-if` template's root element (rather
than on a nested descendant) were silently ignored, and elements like `<li>`
had no default event trigger at all. Both are fixed; see `#bind` vs
`#bindElement` in `browser-kernel.ts` and the `TRIGGER_BY_TAG` fallback to
`click`.
