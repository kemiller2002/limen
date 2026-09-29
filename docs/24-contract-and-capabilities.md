# The contract, the handshake, and optional capabilities

**What this answers:** where the Limen wire contract is defined, how bindings
for each language are produced, how a host and an engine agree they speak the
same contract before anything else happens, and how an optional browser
capability is added without changing Core.

Decision record: [DF-LIMEN-2026-0001](../research/decisions/DF-LIMEN-2026-0001--neutral-contract-and-capability-extension.md).

---

## One source of truth

The contract is data, not code: [`contract/core.contract.json`](../contract/core.contract.json).
It is written in a small language-neutral algebra:

| Construct | Meaning | Example |
| --- | --- | --- |
| `record` | fixed named fields | `BrowserLocation` |
| `union` + `tag` | closed set of variants, discriminated by one field | `EffectOutcome` (`kind`) |
| `flatten` variant | a variant whose fields come from another record/union | `EffectRequest.Storage` |
| `enum` | closed set of string values | `HttpMethod` |
| `brand` | a string/int that must not be mixed with others | `CorrelationId` |
| `shape-union` | variants told apart by JSON shape, not a tag | `ViewValue` |
| `map`, `list`, `nullable`, `literal` | the usual | `ViewState`, `readonly Capability[]` |
| `json` | an opaque slot filled only by another generated binding | a capability's payload |

No programming language's syntax is canonical. There is deliberately no
`object`, `any` or `Dictionary<string, object>`: an attempt to express one is a
contract error.

## Generated bindings are read-only

```sh
npm run contract:generate   # write every binding listed in contract/targets.json
npm run contract:check      # regenerate in memory and compare byte-for-byte (part of npm test)
```

Every generated file starts with a provenance header — source, unit, contract
fingerprint, generator, and a hash of its own body. `contract:check` uses that
to tell you *what happened*, not just that files differ:

| Finding | Meaning | Fix |
| --- | --- | --- |
| `missing` | a target was never generated | run `contract:generate` |
| `stale` | the contract or generator changed; the file was not regenerated | run `contract:generate`, commit |
| `hand-edited` | the file body no longer matches its own header | revert; change the contract instead |
| `orphan` | a file carries the generated marker but no target produces it | delete it, or add a target |

In TypeScript, [`src/protocol.ts`](../src/protocol.ts) re-exports the generated
[`src/generated/core.ts`](../src/generated/core.ts) under the same public names
it has always had. The strict decoder for every type is
[`src/generated/core.codec.ts`](../src/generated/core.codec.ts), exported as
`@echelon-foundry/typescript-wasm-kernel/contract`. Use it wherever untrusted
JSON crosses into host code — typically a WebAssembly transport. It rejects
unknown variants, missing fields, **and unexpected fields**.

### Guest bindings: F#, C#, Rust

The same source generates a binding for each WebAssembly guest language, each
in that language's strongest closed representation:

| Language | Project | Unions | Absence | Exhaustiveness |
| --- | --- | --- | --- | --- |
| F# | `guests/fsharp/Limen.Contract` | `[<RequireQualifiedAccess>]` discriminated unions | `option` | compiler; incomplete matches are errors (`--warnaserror:25`) |
| C# | `guests/csharp/Limen.Contract` | abstract records closed by a private constructor, sealed nested variants, `[ClosedUnion]` | `#nullable enable` (reading an optional field without handling absence is CS8602, an error) | a generated `Match` with one handler per variant (unions and enums): a new variant breaks every call site; the **Limen analyzer** (`guests/csharp/Limen.Contract.Analyzers`) makes `Match` the only way — `LIMEN001` rejects `switch` over a contract union or enum, `LIMEN002` rejects `dynamic` and `Dictionary<string, object>`, `LIMEN003` rejects calling the wire plumbing directly |
| Rust | `guests/rust/limen-contract` | `enum` (never `#[non_exhaustive]`) | `Option` | compiler; `#![deny(warnings)]`, `#![forbid(unsafe_code)]` |

Common rules, identical in every language:

- **Literal-valued fields do not exist in guest types.** `Initialize.protocolVersion`
  is fixed at `1` by the contract, so an F# `Initialize` case has no field for it:
  there is nothing to get wrong. Decoders check it; encoders write it.
- **The same wire names** become the same identifiers: `"invalid-response"` is
  `InvalidResponse`, `"GET"` is `Get`, everywhere.
- **`int` is a 53-bit-safe integer** (`int64`/`long`/`i64`); `2e2` is accepted,
  `200.5` and `9007199254740993` are not.
- **Absent and null are different facts.** An optional field may be absent but
  not `null`; a nullable field may be `null` but not absent. A field cannot be
  both.
- **Decoders are strict and report the same first error at the same path** —
  unknown variant, missing field, unexpected field (first in ordinal order),
  wrong type — so a diagnostic from any guest names the same place.
- **`json` slots are `RawJson`** — the serialized text, to be decoded by the
  capability's own generated binding, never inspected generically.

### Three engines, one spec: the minimal engine

[`conformance/sessions/minimal-engine.md`](../conformance/sessions/minimal-engine.md)
specifies a small capability-probe engine language-neutrally;
[`minimal.session.json`](../conformance/sessions/minimal.session.json) turns it
into 65 message-by-message vectors. It is implemented three times — F#, C# and
Rust under `guests/minimal/` — each against its own generated binding and its
own guest handshake library, and each must reproduce every vector
(`npm run test:guests:sessions`).

Compiled to WebAssembly, the three run behind the same unmodified kernel via
two generic, optional host adapters — `DotnetWasmTransport` (any .NET
language; one `[JSExport]` method) and `RawWasmTransport` (any language that
exports `limen_alloc`/`limen_dispatch`/`limen_free`) — exported as
`./hosts/dotnet-wasm` and `./hosts/raw-wasm`. Both decode every engine response
with the generated decoder. `npm run build:guests && npm run smoke:guests`
proves, in Chromium, a negotiated handshake and success/failure paths for Http,
Storage, Clipboard and Navigation in each language. See
[DF-LIMEN-2026-0003](../research/decisions/DF-LIMEN-2026-0003--multi-language-wasm-guests.md).

### Shared vectors

[`conformance/vectors/core.vectors.json`](../conformance/vectors/core.vectors.json)
holds valid and invalid wire values. Every language must accept each valid one
and re-encode it to equal JSON, and reject each invalid one at exactly its
`errorPath`. Each guest runner also **recomputes the contract fingerprint
independently** from `contract/core.contract.json` (its own canonicalizer and
SHA-256) and compares it with the constant in its generated binding.

```sh
node --experimental-strip-types --test test/conformance-vectors.test.ts   # TypeScript (part of npm test)
npm run test:guests          # F#, C# and Rust (CI job "Guest bindings")
```

### Compile pressure, demonstrated

`npm run test:guests:pressure` (part of `test:guests`) adds a variant to
`EffectOutcome` and a value to `HttpFailureReason` in a scratch copy of the
contract, regenerates, and rebuilds a reference consumer in each language —
code that handles every case the idiomatic way (F# `match` with no wildcard,
C# `Match`, Rust `match` with no `_`). All three must fail to compile (`FS0025`,
`CS7036`, `E0004`), and all three must compile against the real contract. It
also requires each C# analyzer fixture to fail with its own rule.

## The fingerprint

Each contract unit's fingerprint is SHA-256 over its canonical JSON (keys
sorted, whitespace and every `doc` removed). Rewording documentation never
changes compatibility; any change to a name, field, variant or type does.

## The handshake (protocol 1.1)

`Initialize` now carries the host's offer:

```ts
handshake?: {
  protocol: { major: 1, minor: 1 },
  contract: { unit: "limen.core", version: 1, fingerprint: "sha256:…" },
  capabilities: [ { id: "limen.focus", version: 1, fingerprint: "sha256:…" } ],
}
```

The engine's response to `Initialize` may carry its answer:

```ts
handshake?: { kind: "Accepted", protocol, contract, capabilities /* the ones it will use */ }
          | { kind: "Rejected", reason: HandshakeRejection }
```

**The kernel applies nothing from that response until it has verified the
answer.** The rules, in [`src/kernel/handshake.ts`](../src/kernel/handshake.ts):

| Engine answer | Kernel state |
| --- | --- |
| none (a protocol 1.0 engine) | `Running(Legacy)` — the four built-in effects only; or `Incompatible(handshake-required)` if the kernel was created with `requireHandshake: true` |
| `Accepted`, same protocol major, minor ≤ host's, identical core contract, every selected capability offered with identical version and fingerprint | `Running(Negotiated)` |
| anything else, including a malformed handshake | `Incompatible(reason)` — terminal |

In `Incompatible`, no view is applied, no effect runs, and later events are not
dispatched; the kernel reports `{ kind: "Handshake", verdict }` and a
`BridgeError { phase: "protocol" }` for each refused message.

**A compatibility failure is not an effect outcome.** It is never
`OutcomeUnknown`, and never a capability `Failure`.

The engine's half is a pure function, `answerHandshake(offer, requirements)`
([`src/guest/handshake.ts`](../src/guest/handshake.ts)). An engine given an
`Initialize` with **no** handshake — i.e. running under a kernel older than
1.1 — answers `Rejected(HandshakeMissing)` and should project nothing else. The
old kernel ignores the answer, but the engine's own typed state now says why it
is inert.

## Optional capabilities

A capability pack is its own contract unit with `"role": "capability"`. Its
generated binding exports `CAPABILITY_OFFER` (id, version, fingerprint) plus its
request/result/fact types and decoders. Core carries its payloads in one generic
envelope and never looks inside:

```ts
// engine → browser
{ kind: "Capability", correlationId, capability, version, request }
// browser → engine
{ kind: "EffectResult", result: { kind: "CapabilityResult", correlationId, capability, version,
    outcome: { kind: "Completed", result }            // the pack's own closed outcome
           | { kind: "Unsupported", reason: "not-negotiated" | "version-unsupported" }
           | { kind: "Rejected", reason: "malformed-request" } } }
{ kind: "CapabilityFact", capability, version, fact }  // subscription updates, lifecycle facts
```

A host registers the packs it implements:

```ts
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
import { focusCapability } from "…/focus";          // an optional pack; not imported, not loaded

new BrowserKernel(transport, document, diagnostics, { capabilities: [focusCapability()] });
```

A pack's provider is built with `defineCapability`, whose only route from wire
JSON to a typed request is the pack's generated decoder:

```ts
defineCapability<FocusRequest, FocusOutcome, never>({
  offer: CAPABILITY_OFFER,
  decodeRequest: decodeFocusRequest,
  execute: async (request, { signal, document }) => { /* browser mechanism only */ },
});
```

**Correlation ids are unique while in flight.** For every effect kind, a
request whose correlation id belongs to an effect that has not yet been
answered is refused — not executed — and reported as
`BridgeError { phase: "protocol" }`: two answers under one id would be
indistinguishable to the engine. An id may be reused once its earlier effect
has completed.

Rules a pack must follow:

- **Offered is not permitted.** Permission, availability and user-gesture
  failures are variants of the pack's own outcome.
- **Cancellation is reported, not fabricated.** The kernel aborts `signal`;
  the provider returns its own `Cancelled` variant.
- **No hidden policy.** No retries, reconnection, caching or recovery in a
  provider. Those are engine decisions.
- **Nothing browser-owned crosses.** Opaque handles, never DOM nodes, `File`s
  or streams.

An application that registers no pack loads no pack code: packs are separate
modules that Core never imports.

The repository's test-only pack,
[`test/fixtures/capabilities/echo.contract.json`](../test/fixtures/capabilities/echo.contract.json),
is the executable proof that a capability family can be added without touching
Core; [`test/handshake.test.ts`](../test/handshake.test.ts) exercises every rule
above.

### Opaque handles

A browser resource that must outlive one request — an observer, a picked
file, a media stream — stays in the browser, in a **handle table**, and only
its id crosses. `@echelon-foundry/typescript-wasm-kernel/capability-support/handles`
provides one:

```ts
const table = createHandleTable<IntersectionObserver>();  // one per page lifetime
const id = table.create(observer, (o) => o.disconnect()); // "<session>.<n>", never reused
table.use(id);      // { kind: "Live", resource } | { kind: "Stale", reason }
table.dispose(id);  // { kind: "Disposed" } once; then Stale("disposed")
table.disposeAll(); // host teardown: every live cleanup runs exactly once
```

A stale id is an answer, not an exception. Its reason is `unknown` (never
issued here), `disposed`, or `other-session` — an id the engine kept across a
reload, which names a resource that no longer exists. A pack declares handles
as a `brand` in its contract and its stale reasons as its own enum; see
[`test/fixtures/capabilities/handle.contract.json`](../test/fixtures/capabilities/handle.contract.json).
The table is capability-support, not Core: a pack that needs none imports none.

### Provider conformance

`runProviderConformance(provider, fixture)` from
`@echelon-foundry/typescript-wasm-kernel/testing/providers` runs the same checks
against every pack, fed by the pack's own payloads and generated result decoder,
and returns the failures (empty when the provider conforms):

- the descriptor has an id, a positive version and a generated fingerprint;
- a malformed request is `Rejected(malformed-request)` and never throws;
- a valid request `Completed` with a result the pack's decoder accepts;
- the result is plain JSON — no DOM node, `File`, function or non-finite number;
- an aborted request still settles promptly, with a result the decoder accepts.

It proves the seam, not the meaning: each pack still tests its own behavior,
and anything only a browser can establish in a real browser.
[`test/handles.test.ts`](../test/handles.test.ts) runs it against both fixture
packs and against a deliberately broken provider.

## Compatibility notes for existing consumers

- Public TypeScript names are unchanged. `Initialize` and
  `EngineToBrowserMessage` gained one optional field each.
- `EffectRequest`, `EffectResult` and `BrowserToEngineMessage` gained a member
  each. An exhaustive `switch` in your engine now fails to compile until it
  handles `Capability`/`CapabilityResult`/`CapabilityFact` — for an engine that
  negotiates no capability, those are contract violations; throw.
- `DiagnosticEvent` gained `Handshake`, and `BridgeError.phase` gained
  `"protocol"`. A diagnostics sink that assumed only two kinds will misreport
  the new one; switch on `kind`.
