# Bridge Responsibility Roadmap

Tracks the TypeScript kernel's mechanism responsibilities against what is
actually implemented and tested — not what's aspirational. Update the status
next to the code, not ahead of it.

## Mental model

```text
HTML/CSS
    ↓ events
TypeScript Bridge
    ↓ commands
Engine (today: ReferenceEngine, TypeScript)
    ↓ effect requests / projections
TypeScript Bridge
    ↓
Browser APIs + DOM
```

> **Terminology note.** Earlier revisions of this diagram labelled the third row
> "WASM Kernel". There is no WebAssembly in this repository — the component that
> owns application meaning is called **the engine**, and it is TypeScript today.
> Confusingly, "kernel" elsewhere in this repo means the *browser-side bridge*
> (`BrowserKernel`), i.e. the opposite side of the boundary. See
> [17-wasm-migration.md](17-wasm-migration.md) for what exists and what a real
> WASM transport would take, [glossary.md](glossary.md) for canonical terms, and
> [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md) findings A-2 and N-1.

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
| 1 | WASM lifecycle — load, initialize, version-check | ⚠️ Partial | `BrowserKernel.start()` dispatches `Initialize` with `PROTOCOL_VERSION`; `ReferenceEngine.handle()` rejects a mismatched version. "Expose the kernel instance" deliberately not done — no global handle, matching `architecture.yaml`'s `ambient_authority: forbidden`. | `kernel.test.ts`: "start() dispatches Initialize…", "a transport whose start() rejects…" |
| 2 | Command dispatch | ✅ | `#bindEvent` / `#fire` | `kernel.test.ts` event-dispatch tests |
| 3 | Projection rendering | ✅ | `#applyScope`, `#applyIf`, `#applyEach` | `kernel.test.ts` projection tests |
| 4 | Effect execution | ⚠️ Partial | Http (`#runHttp`, any of `GET`/`PUT`/`POST`/`PATCH`/`DELETE`, caller headers merged over the default, opaque pre-serialized body) and Storage (`#executeStorage`/`runStorage`, `localStorage`-backed). File/clipboard/navigation/auth adapters: 🧊 deferred, see below. | `kernel.test.ts` effect-execution tests |
| 5 | Effect result return — Succeeded/Failed/Cancelled/OutcomeUnknown | ✅ | `EffectOutcome` in `protocol.ts` now carries all four (`Success`, `Failure`, `Cancelled`, `OutcomeUnknown`); `#classifyAbort` in the kernel classifies transport-level outcomes only, never business meaning | `kernel.test.ts`: Success/Failure(network)/Failure(invalid-response)/OutcomeUnknown/Cancelled — one test each |
| 6 | DOM event wiring — click/input/change/submit/keyboard/focus | ✅ | `TRIGGER_BY_TAG` maps the exceptions (`form`→submit, `input`/`select`/`textarea`→change); everything else defaults to `click`; `data-on` overrides to any DOM event type, including keyboard/focus events — no special-casing needed since the trigger is data-driven | `kernel.test.ts`: default triggers + `data-on` override |
| 7 | Form value extraction | ✅ | `readValue()` | covered by event-dispatch tests |
| 8 | Browser navigation/history | 🧊 Deferred | No feature has URL-driven state yet (single-page demo). Build when a real route needs it — see NAVIGATION system, responsibility-spec §11. | — |
| 9 | Rendering helpers — text/attributes/visibility/lists/replace-update fragments | ✅ | `data-text`, `data-bind-<attr>` (visibility via `data-bind-hidden`), `data-each`, `data-if`. Arbitrary fragment replace/insert beyond keyed templates is deliberately unsupported — reconciliation is intentionally restricted to keyed repeated templates (zero-authoritative spec §25) | `kernel.test.ts` projection + list tests |
| 10 | List rendering | ✅ (virtualization 🧊 deferred) | Keyed reconciliation preserves DOM node identity across reorder (`#applyEach`). Windowing/virtualization: no evidence yet that any list is large enough to need it — spec §30/§31 calls for measuring at 1k/10k/100k/1M records before optimizing. | `kernel.test.ts`: add/remove/reorder-preserves-identity |
| 11 | Browser-local presentation state — focus, popovers, animation, pointer | ✅ by design | Left entirely to CSS/native browser behavior; the kernel does not track or synchronize any of it (`architecture.yaml`, zero-authoritative spec §4.3) | N/A — no kernel code exists to test |
| 12 | Serialization boundary | 🧊 Deferred | `DirectTypeScriptTransport` is in-process; no serialization occurs. `protocol.ts` types are already plain, JSON-serializable data by construction, so adding a codec later doesn't require a protocol redesign. Becomes relevant only once an out-of-process/WASM transport exists. | — |
| 13 | Error boundary | ✅ | Every engine round-trip funnels through one chokepoint, `#send()`. A transport throw or a malformed projection is caught, reported via diagnostics, and does not propagate or leave a half-applied view. | `kernel.test.ts`: "a transport.dispatch() rejection is reported…", "a malformed projection is reported…" |
| 14 | Diagnostics hooks | ✅ | `src/kernel/diagnostics.ts` — injectable `DiagnosticsSink`, defaults to a no-op. Reports `BridgeError` (dispatch/projection/effect phase) and `EffectTiming`. | `kernel.test.ts`: "the kernel reports effect timing…", both error-boundary tests |
| 15 | Accessibility plumbing | ⚠️ Partial | `aria-live` regions work today because they're native HTML the kernel already updates via `data-text`/`textContent` (see `index.html`'s status paragraph) — no special kernel code needed. Focus restoration (e.g. after a keyed list item is removed) is 🧊 deferred, no demonstrated need yet. | — |
| 16 | Scheduling primitives — rAF/timers/idle callbacks | 🧊 Deferred | No feature currently needs debounced/scheduled semantic events; the coalesce/debounce allowance in zero-authoritative spec §15 is explicitly evidence-driven, not default. | — |
| 17 | File/browser API adapters | 🧊 Deferred | — | — |
| 18 | Storage adapters | ✅ (`localStorage` only) | `StorageEffectRequest`/`StorageOutcome` in `protocol.ts`; `#executeStorage`/`runStorage` in the kernel. `get`/`set`/`remove` only, no `IndexedDB`/`Cache API` — build those when a feature demonstrates the need, same 🧊 policy as everything else here. No `OutcomeUnknown`: a single `localStorage` call is effectively atomic, so unlike Http there's no meaningful "dispatched but uncertain" state; failures classify as `unavailable` or `quota-exceeded`. | `kernel.test.ts`: set→get round-trip, remove→get reports `null`, quota-exceeded classification, stale-cancellation-is-a-no-op |
| 19 | Network adapter | ✅ | `#runHttp` — classifies transport-level outcomes only (`Success`/`Failure`/`Cancelled`/`OutcomeUnknown`), never interprets a status code or decoded body as domain truth (per responsibility-spec §17: "TypeScript must not interpret business meaning"). Extended beyond `GET` to any of `PUT`/`POST`/`PATCH`/`DELETE` with caller-supplied headers (merged over the kernel's own `accept` default) and an opaque pre-serialized body — added for a real consumer's GitHub Contents API write (`PUT` + `Authorization` header + JSON body). Headers/body are never surfaced in a `DiagnosticEvent`. | `kernel.test.ts`: PUT with headers+body reaches `fetch()` correctly, GET omits body entirely, diagnostics never contain header/body content |

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

- `test/domain.test.ts` — engine-level: state/transition legality, stale
  evidence rejection, the generic event→command mapping's closed vocabulary.
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
