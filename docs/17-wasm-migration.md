# WASM: what exists, what doesn't, and what migration would take

**What this answers:** the question that gave this document its own page —
*where is the WebAssembly?*

---

## The short answer

**There is none.** This repository contains:

- no `.wasm` file
- no `WebAssembly.instantiate` or `WebAssembly.compile` call
- no module loader, no glue code, no binding generator
- no build step that produces WebAssembly
- no test that exercises a WebAssembly module

A full-text search for `wasm` or `WebAssembly` across `src/`, `test/`,
`examples/`, and `scripts/` returns exactly two hits, both **comments** in
`test/kernel.test.ts` labelling test sections (`// WASM lifecycle — load,
initialize, version-check`). The package name, description, and keywords mention
WebAssembly; the code does not contain any.

If you are an agent that went looking for the WASM engine and could not find it:
nothing is missing and nothing is broken. This page is the answer.

> This gap between the name and the implementation is the documentation defect
> that prompted the audit. It is recorded as finding **A-2** in
> [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md).

---

## What the name actually means

"WASM kernel" describes the **shape of the boundary**, not the technology
currently on the far side of it.

The kernel talks to the application through exactly one interface:

```ts
export interface EngineTransport {
  start(): Promise<void>;
  dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage>;
}
```

Two methods. Both async. Every value that crosses is plain, JSON-serializable
data — no functions, no DOM nodes, no class instances, no object identity, no
shared memory. That is precisely the set of constraints a WebAssembly module can
be driven through.

So the claim the name makes is: **an application written against this boundary
can be moved into WebAssembly without changing the boundary.** That claim is
currently untested, because no one has done it.

### What is actually shipped

```ts
export class DirectTypeScriptTransport implements EngineTransport {
  readonly #engine = new ReferenceEngine();
  async start(): Promise<void> {}
  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    return this.#engine.handle(message);
  }
}
```

An in-process TypeScript engine, called synchronously behind an async signature.
`start()` does nothing because there is nothing to load, and no serialization
occurs because both sides share a heap.

Throughout the documentation the component that owns application meaning is
called **the engine**, not "the WASM". That is deliberate — the engine is
TypeScript today.

---

## What is already in place

Real work has been done toward this, and it is worth being precise about which
parts are genuinely ready.

| Requirement | Status | Evidence |
| --- | --- | --- |
| A single, narrow interface to swap | ✅ done | `EngineTransport` — two methods |
| Async signature, so a real boundary fits | ✅ done | both methods return promises |
| Only serializable data crosses | ✅ done | `ViewValue` admits primitives and flat item arrays only |
| No DOM references in messages | ✅ done | `SemanticEvent` carries no element id or node |
| Engine free of browser APIs | ✅ done, **enforced** | [`check-architecture.ts`](../scripts/check-architecture.ts) |
| Engine free of dynamic typing | ✅ done, **enforced** | same check bans `any`/`dynamic` |
| Protocol version negotiation | ✅ done | `Initialize.protocolVersion`; `ReferenceEngine` rejects a mismatch |
| Capability announcement | ✅ done | `Initialize.capabilities: ["Http", "Storage"]` |
| Correlation IDs for async effects | ✅ done | effects are already correlated, not awaited in place |
| Loading/instantiation hook | ⚠️ shape only | `start()` exists and is awaited; nothing loads |
| Serialization codec | ❌ **not built** | ROADMAP item 12 — in-process, so none occurs |
| A WASM transport | ❌ **not built** | — |
| Toolchain, build, tests for one | ❌ **not built** | — |

The design work is largely done. The implementation work has not started.

### Why the checker bans `JsValue` and `IJSRuntime`

A detail that reveals the intent. `check-architecture.ts` forbids these two
identifiers in `src/engine/**`:

```ts
for (const forbidden of ["document", "window", "fetch(", "localStorage", "sessionStorage", "JsValue", "IJSRuntime"]) {
```

`JsValue` is the wasm-bindgen (Rust) type for an opaque JavaScript handle.
`IJSRuntime` is Blazor's (C#) JavaScript-interop service. Neither can appear in
TypeScript — they are banned pre-emptively, so that **a future engine ported to
Rust or C# cannot reach back into JavaScript** and quietly reintroduce the
browser dependency the boundary exists to prevent.

That is the strongest evidence of intent in the repository, and it is currently
undocumented anywhere else.

---

## What a real WASM transport would have to do

Not a plan of record — a description of the actual work, so the size is visible.

### 1. Loading

```ts
export function createWasmTransport(url: string): EngineTransport {
  let instance: WebAssembly.Instance | null = null;
  return {
    async start(): Promise<void> {
      const { instance: created } = await WebAssembly.instantiateStreaming(fetch(url), imports);
      instance = created;
      // whatever the module needs to set up its own state
    },
    async dispatch(message) { /* … */ },
  };
}
```

`start()` already exists and is already awaited, and its rejection path is
already handled (the kernel reports `BridgeError` and does not bind). That part
needs no change.

Serving requires the `application/wasm` MIME type, or
`instantiateStreaming` fails.

### 2. Serialization

The part that does not exist. `BrowserToEngineMessage` must become bytes in
linear memory, and `EngineToBrowserMessage` must come back.

Decisions to make:

- **Format.** JSON is the obvious first move — the types are already
  JSON-shaped, so `JSON.stringify`/`parse` on both sides works with no protocol
  change. A compact binary format would be faster and much more work.
- **Memory.** Who allocates, who frees, and how a returned pointer/length pair
  is read out of `WebAssembly.Memory`.
- **Strings.** UTF-8 encode/decode across the boundary.
- **Errors.** A trap or a decode failure must surface as a rejected `dispatch`,
  which the kernel already handles as `BridgeError { phase: "dispatch" }`.

Because no serialization happens today, **nothing currently proves the protocol
survives a round trip through a codec.** The types make it very likely; that is
not the same as having tested it.

### 3. The engine itself

Port the state, transitions, and projection to the target language. These are
pure functions over discriminated unions, which map cleanly onto F#, Rust, and
Kotlin, and reasonably onto C# and Java.

Two things must be preserved, or the port loses the guarantees:

- **Exhaustive matching.** The TypeScript version relies on the compiler
  catching an unhandled state. The target language needs the same, or a
  fallback that fails loudly.
- **No host callbacks.** The engine must not call back into JavaScript — which
  is exactly what the `JsValue`/`IJSRuntime` ban is protecting.

### 4. Testing

- Engine tests port to the target language's test framework.
- Kernel tests are unaffected — they use a `ScriptedTransport` and never touch a
  real engine.
- New tests needed: round-trip serialization, instantiation failure, trap
  handling.

### 5. Build and distribution

A second toolchain in CI, a `.wasm` artifact in the published package, and a
decision about size — a WebAssembly runtime plus the module is much larger than
the current zero-dependency JavaScript.

---

## Open questions

Genuinely unresolved. Recorded rather than guessed.

1. **Which language?** The repository mentions F#, C#, Rust, Kotlin, and Java as
   candidates. No decision record exists.
2. **Which serialization format?** JSON first, or binary immediately?
3. **Does the async boundary stay honest?** `dispatch` returns a promise, but a
   synchronous WASM call resolves immediately. Anything relying on a real
   microtask gap between dispatch and response — including the timing regimes
   the tests depend on — should be re-verified.
4. **How is the module's own state persisted?** It lives in linear memory. A
   page reload loses it, same as today, but a long-lived module raises questions
   the protocol does not currently address.
5. **Is the size cost acceptable?** No budget has been set.
6. **Does anything actually need this yet?** Per the repository's own 🧊 policy,
   building ahead of a demonstrated requirement is itself an architecture
   violation. No consumer has filed one.

---

## What to do in the meantime

**Write your engine as though it were already WASM.** Every constraint the
target imposes is already enforceable today:

- No browser APIs — the build already fails on this.
- No `any` — the build already fails on this.
- Only serializable data across the boundary — the types already enforce this.
- Exhaustive matching — the compiler already enforces this.
- No callbacks into the host — nothing in the protocol permits them.

An engine written that way is portable whether or not the port ever happens. And
the constraints pay for themselves immediately in testability and in having one
place to look — which is why the architecture is worth using even if WebAssembly
never arrives.

---

## Related

- [01-architecture.md](01-architecture.md) — why the boundary is shaped this way
- [11-api-reference.md](11-api-reference.md) — `EngineTransport` in full
- [ROADMAP.md](ROADMAP.md) — item 12, the serialization boundary
- [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md) — finding A-2
