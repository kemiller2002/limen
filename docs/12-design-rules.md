# Design rules

**What this answers:** what you MUST, SHOULD, and MAY do — stated precisely
enough to settle an argument, and to be followed by an agent without inference.

Keywords follow RFC 2119: **MUST** / **MUST NOT** are requirements; **SHOULD** /
**SHOULD NOT** are strong defaults you may depart from with a reason;
**MAY** is genuine preference.

Each rule names how it is enforced: **Script** (build fails), **Compiler**
(TypeScript fails), or **Review** (a human or agent must catch it).

---

## 1. State ownership

**1.1 — MUST.** Authoritative application state MUST live in exactly one place:
the engine. *(Review)*

**1.2 — MUST NOT.** Application state MUST NOT be stored in `src/kernel/**`, in
page JavaScript, or in the DOM. *(Review)*

**1.3 — MUST.** State MUST be mutated only by a transition function in response
to a command. *(Review)*

**1.4 — MUST NOT.** The DOM MUST NOT be read as a source of application truth.
The only permitted read is `readValue()` transporting a form control's `.value`
into a `SemanticEvent`. *(Review)*

**1.5 — SHOULD.** State SHOULD be a discriminated union whose members make
illegal combinations unrepresentable, rather than a record of independent
booleans. *(Review; [04-state-model.md](04-state-model.md))*

**1.6 — SHOULD.** Data meaningful in only one state SHOULD live in that union
member, not at the top level.

---

## 2. The engine

**2.1 — MUST NOT.** `src/engine/**` MUST NOT reference `document`, `window`,
`fetch(`, `localStorage`, or `sessionStorage`. *(**Script** —
[`check-architecture.ts`](../scripts/check-architecture.ts))*

**2.2 — MUST NOT.** `src/engine/**` MUST NOT use the words `any` or `dynamic`.
*(**Script**)*

**2.3 — MUST NOT.** No file in `src/` may contain `eval(`, `SetInnerHtml`, or
`ExecuteScript`. *(**Script**)*

**2.4 — MUST.** `transition` and `project` MUST be pure: no I/O, no globals, no
randomness, no clock reads, no mutation of their arguments. *(Review)*

**2.5 — MUST.** Every `switch` over a state or outcome union MUST be exhaustive.
*(**Compiler**, via `assertNever`)*

**2.6 — MUST.** The engine MUST validate every incoming `SemanticEvent.name`
against a closed vocabulary and reject anything unrecognized. *(Review)*

**2.7 — MUST.** `SemanticEvent.key` MUST be validated before use. It comes from
the DOM. *(Review)*

**2.8 — MUST.** An `EffectOutcome.body` MUST be narrowed from `unknown` before
use. Nothing validated it. *(**Compiler** — it is `unknown`)*

**2.9 — SHOULD.** A command that is illegal from the current state SHOULD be
rejected explicitly and observably, not silently ignored.

---

## 3. The kernel

**3.1 — MUST NOT.** `src/kernel/**` MUST NOT branch on application meaning.
Event names and view keys are opaque strings there. *(Review)*

**3.2 — MUST NOT.** The kernel MUST NOT hold state that mirrors engine state.
Its only permitted state is DOM-identity bookkeeping. *(Review)*

**3.3 — MUST NOT.** The kernel MUST NOT sequence, retry, batch, or combine
effects. One `EffectRequest` in, one `EffectResult` out. *(Review)*

**3.4 — MUST NOT.** The kernel MUST NOT interpret a status code or a response
body as domain meaning. It classifies transport outcomes only. *(Review)*

**3.5 — MUST NOT.** A `DiagnosticEvent` MUST NOT contain request headers or
bodies. *(**Test** — `test/kernel.test.ts`)*

**3.6 — MUST NOT.** A bridge failure MUST NOT propagate out of `#send()`. It is
reported to diagnostics. *(Review)*

---

## 4. Effects

**4.1 — MUST.** External work MUST be requested by the engine as an
`EffectRequest` and performed by the kernel. The engine MUST NOT perform it.
*(**Script** for browser APIs; Review otherwise)*

**4.2 — MUST.** All four Http outcomes MUST be handled: `Success`, `Failure`,
`Cancelled`, `OutcomeUnknown`. *(**Compiler**)*

**4.3 — MUST NOT.** `OutcomeUnknown` MUST NOT be treated as `Failure`. The
request may have been processed. *(Review)*

**4.4 — MUST NOT.** A non-idempotent request (POST/PATCH/DELETE) MUST NOT be
automatically retried after `OutcomeUnknown`. Reconcile instead. *(Review)*

**4.5 — MUST.** Every effect result MUST be checked against the `correlationId`
the state is waiting on, and discarded if it does not match. *(Review)*

**4.6 — MUST.** `HttpEffectRequest.body` MUST be serialized by the engine. The
kernel does not interpret it. *(**Compiler** — it is `string`)*

**4.7 — SHOULD.** `timeoutMs` SHOULD be chosen per endpoint, not set to a single
global constant.

**4.8 — SHOULD NOT.** Sensitive data SHOULD NOT be written to `localStorage`. It
is readable by any script on the origin.

---

## 5. Rendering

**5.1 — MUST.** Every projection MUST be total: every key named by a
`data-text` or `data-bind-*` binding that is currently mounted MUST be present
and scalar. *(Runtime throw → `BridgeError`)*

**5.2 — MUST.** A `data-each` key MUST project an array — `[]` when empty, never
absent. *(Runtime throw)*

**5.3 — MUST.** `data-each` item keys MUST be stable and unique. An array index
MUST NOT be used. *(Review)*

**5.4 — MUST.** A `data-if` or `data-each` template MUST contain exactly one
root element. *(Runtime throw)*

**5.5 — MUST NOT.** Capabilities ("can the user do this?") MUST NOT be
re-derived in the DOM, in CSS, or in page JavaScript. The engine MUST project
them explicitly. *(Review)*

**5.6 — SHOULD.** Use `data-if` when content should not exist; use
`data-bind-hidden` when the element must stay alive to preserve focus or input.

**5.7 — SHOULD.** Project data and let CSS decide appearance. The engine SHOULD
NOT project class names, colors, or pixel values.

---

## 6. HTML and CSS

**6.1 — MUST.** HTML remains structural. Native semantics, labels, and
validation attributes MUST be preserved. *(Review)*

**6.2 — MUST.** CSS remains presentational. Presentation MUST NOT require a
round trip through the engine. *(Review)*

**6.3 — SHOULD.** Native validation (`required`, `type="email"`, `min`/`max`)
SHOULD be used **in addition to** engine validation, never instead of it. HTML
validation is a courtesy to the user; the engine's is the guarantee.

**6.4 — SHOULD.** ARIA state SHOULD be projected (`data-bind-aria-*`) rather
than managed by script.

---

## 7. Dependencies and compatibility

**7.1 — MUST NOT.** No runtime dependency MUST be added without justification
against `prompts/dependency-minimal-browser-kernel-architecture-policy.md` §8,
recorded in the relevant doc. *(Review)*

**7.2 — MUST.** Every protocol value MUST remain JSON-serializable: no
functions, no class instances, no DOM nodes, no identity-bearing values.
*(**Compiler**, via `ViewValue`)*

**7.3 — MUST.** Changes to `src/protocol.ts` or `src/index.ts` MUST be treated
as public-contract changes. *(Review)*

**7.4 — SHOULD NOT.** A capability SHOULD NOT be built before a real feature
needs it. Speculative surface is untested surface with no design pressure behind
it. *(Review; ROADMAP 🧊 legend)*

---

## 8. Testing

**8.1 — MUST.** Every new transition MUST have a test for the legal path **and**
the illegal path.

**8.2 — MUST.** Every effect-consuming transition MUST have a stale-result test.

**8.3 — MUST.** `npm run check` MUST pass before a change is considered done.
`tsc` alone is not sufficient.

**8.4 — SHOULD.** Test transitions and projections as pure functions. Reserve
jsdom for cases where the DOM is genuinely the subject.

**8.5 — SHOULD.** Any change affecting the DOM SHOULD be exercised in a real
browser, not only asserted in jsdom.

---

## 9. Genuine preferences (MAY)

These are not rules. Either choice is fine.

- **MAY** use distinct event names (`goHome`, `goSettings`) or a `data-each` nav
  with keys. Distinct names are simpler for a fixed set.
- **MAY** carry a `version` counter in state. The reference domain does; nothing
  requires it.
- **MAY** organize the engine as one file or many. Size and taste.
- **MAY** implement `EngineTransport` as a class or a factory function returning
  an object literal. The examples use factories; `DirectTypeScriptTransport`
  uses a class.
- **MAY** expose a read-only `state` getter for debugging.
- **MAY** name correlation IDs however you like, as long as they are unique per
  in-flight request.

---

## Precedence

When rules appear to conflict:

1. Safety and correctness (rules 1.x, 4.x)
2. Boundary integrity (2.x, 3.x)
3. Everything else

A rule marked **Script** or **Compiler** cannot be waived by agreement — the
build enforces it.

---

## Related

- [01-architecture.md](01-architecture.md) — *why* these rules exist
- [13-anti-patterns.md](13-anti-patterns.md) — what violating them looks like
- [14-agent-guide.md](14-agent-guide.md) — applying them to a change
