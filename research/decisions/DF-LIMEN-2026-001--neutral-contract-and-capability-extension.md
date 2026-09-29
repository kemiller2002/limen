---
identifier: DF-LIMEN-2026-001
title: One language-neutral contract, a fingerprint handshake, and a generic capability envelope
type: decision-record
status: accepted
version: 1.0.0
author_agent: claude-code
created: 2026-09-29
updated: 2026-09-29
related_projects: [limen]
related_documents:
  - src/protocol.ts
  - contract/core.contract.json
  - tools/contract-gen/README.md
  - docs/24-contract-and-capabilities.md
supersedes: []
superseded_by: []
tags: [contract, protocol, capability, handshake, wasm, lcp-002]
work_items: [WI-0028]
external_references: ["kemiller2002/limen#16", "kemiller2002/limen#52", "kemiller2002/limen#51"]
---

# DF-LIMEN-2026-001 — One language-neutral contract, a fingerprint handshake, and a generic capability envelope

## Context

Limen's wire contract was a handwritten TypeScript file (`src/protocol.ts`).
The product site's F# engine carried a second, handwritten copy of part of it
(`site/fsharp/Limen.Site.Engine/Protocol.fs`), and nothing detected when the two
drifted. Issue #15 requires F#, C#, Rust and future WebAssembly engines to share
one contract, requires new browser capabilities to be addable without growing
Core semantics (LCP-002, #16), and requires an incompatible host/engine pair to
fail before normal traffic (#51, #52).

## Decision

1. **The contract source of truth is language-neutral data**:
   `contract/*.contract.json`, written in a small algebraic contract language
   (records, tagged unions, enums, brands, lists, maps, nullable, literals, an
   opaque `json` slot, and shape-discriminated unions for `ViewValue`). No
   programming language's syntax is canonical.
2. **Bindings are generated** by `tools/contract-gen` and are read-only. The
   TypeScript host binding is `src/generated/`; `src/protocol.ts` re-exports it
   under the unchanged public names and keeps only the non-wire
   `EngineTransport` interface. F#, C# and Rust emitters follow under #52.
3. **Each contract unit has a fingerprint**: SHA-256 of the unit's canonical
   JSON with documentation removed. Documentation changes do not change
   compatibility; any wire-relevant change does.
4. **Handshake, additive to protocol 1** (revision 1.1). `Initialize` gains an
   optional `handshake` carrying the host's protocol revision, core contract
   identity and capability offers. The engine's response to `Initialize` may
   carry `handshake: Accepted | Rejected`. The kernel applies nothing from that
   response — no view, no effect — until it has verified the handshake.
5. **Optional capabilities travel in one generic, closed envelope**:
   `EffectRequest.Capability`, `EffectResult.CapabilityResult`, and the
   browser-originated `CapabilityFact`. Core routes by the negotiated
   capability identity to a registered provider and never interprets the
   payload; the provider decodes it with its capability's generated decoder.

## Ordo analysis

**Requirement.** LCP-002 acceptance criteria in #16.

**State (kernel, host side).**

```text
Unstarted → Starting → Running(Negotiated{core, capabilities})
                     → Running(Legacy)            -- engine sent no handshake
                     → Incompatible(reason)       -- terminal
                     → Faulted                    -- existing transport/binding failure path
```

**Legal transitions.** `Starting → Running(Negotiated)` only when the engine
accepted, the protocol major matches, the core fingerprint matches, and every
capability the engine selected was offered with the same version and
fingerprint. `Starting → Running(Legacy)` only when the engine's `Initialize`
response carries no handshake and the kernel was not configured with
`requireHandshake`. Every other outcome is `Incompatible`.

**States that must remain impossible.**

- a view or effect from an unverified `Initialize` response is applied;
- an event is dispatched after `Incompatible`;
- a capability effect executes that was not negotiated (Legacy negotiates none);
- a protocol incompatibility is reported as `OutcomeUnknown` or as a
  capability `Failure` — it is a compatibility state, not an effect outcome;
- a capability payload the provider cannot decode is executed.

**Capabilities.** Built-in `Http/Storage/Clipboard/Navigation` announcement is
unchanged. Optional capabilities are *offered* by the host and *selected* by the
engine. Negotiation says what the host implements, never what the browser will
permit; permission remains per-effect, in the capability's own outcome.

**External effects.** `CapabilityOutcome = Completed{result} |
Unsupported{not-negotiated|version-unsupported} | Rejected{malformed-request}`.
`Completed.result` is the capability's own closed outcome union, which is where
its success/failure/cancelled/unknown variants live. Core adds no unknown-vs-
failure policy of its own.

**Evidence required for the transition to Running(Negotiated).** The engine's
decoded `EngineHandshake.Accepted`, compared field-by-field against the host's
offer. Decoding uses the generated decoder; a malformed handshake is
`Incompatible(malformed-handshake)`.

**Negative knowledge recorded.**

- Bumping `protocolVersion` to 2 in `Initialize` is *not* compatible: the
  existing F# site engine and TypeScript examples reject or ignore any version
  other than 1 (`Dispatch.fs` fails with "Protocol version … is unsupported").
  The handshake is therefore an additive field on protocol 1.
- A per-capability fingerprint is required in addition to the core one. A
  single fingerprint over "all capabilities" would make adding an unrelated
  optional pack break every existing engine.
- Validating every engine response in the kernel would add the full codec to
  every in-process TypeScript consumer. The kernel validates only the
  handshake; WASM transports, which parse untrusted JSON, validate whole
  messages with the generated codec (#17).

**Unknowns / obligations carried.**

- F#, C# and Rust emitters, deterministic regeneration checks in CI, and
  cross-language fingerprint agreement: #52.
- Migrating the site's handwritten `Protocol.fs` to generated bindings: #17.
- The federation envelope (`src/federation.ts`) is a second wire protocol still
  defined only in TypeScript; bringing it under the neutral contract is tracked
  as a separate work item rather than silently widening #16.

**Stale results.** Correlation ids remain the stale-result mechanism for
capability effects exactly as for Http; cancellation of a capability effect
aborts the provider's `AbortSignal`, and the provider must report its own
`Cancelled` variant rather than Core fabricating one.

## Alternatives considered

- **Hand-maintained parallel bindings with a cross-check test.** Rejected: the
  check detects drift after the fact and still leaves two authorities.
- **WIT / Component Model as the source.** Deferred, not rejected: Limen must
  not depend on native browser Component Model support or one toolchain. A WIT
  backend can be added as another emitter from the same source.
- **`operation: string, payload: object` capability dispatch.** Rejected by
  #16 and #54: the envelope is generic only at the Core seam; every payload is a
  closed generated type on both sides of it.

## Consequences

- Public TypeScript names and shapes in `src/protocol.ts` are unchanged; the
  only additions are optional fields and new union members.
- Exhaustive `switch` statements over `EffectRequest`/`EffectResult`/
  `BrowserToEngineMessage` in consumer code gain new cases (`Capability`,
  `CapabilityResult`, `CapabilityFact`). This is intentional compile-time
  pressure; the reference and example engines are updated.
- Reversibility: high for the envelope (additive); the contract-language
  choice is costly to reverse once guests depend on generated names.

## Validation

`test/contract.test.ts`, `test/handshake.test.ts`, `npm run check`,
`npm run contract:check`.
