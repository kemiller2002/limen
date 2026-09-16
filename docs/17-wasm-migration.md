# WASM: what exists, what doesn't, and what migration would take

**What this answers:** the question that gave this document its own page —
*where is the WebAssembly?*

---

## The short answer

**In [`wasm/`](../wasm/), and it runs this project's website.** The engine is
F#, compiled to WebAssembly, and it drives every interactive part of the Limen
site through the unmodified `BrowserKernel`.

**Not in the published package.** `src/engine/` is TypeScript,
`DirectTypeScriptTransport` is what the package ships, and `wasm/` is not in
`package.json`'s `files`. If you installed `@echelon-foundry/typescript-wasm-kernel`
and went looking for a `.wasm` file in it, nothing is missing: your engine is
TypeScript, which is the supported default.

So there are two honest answers depending on which question was meant:

| Question | Answer |
| --- | --- |
| Does the package ship a WebAssembly engine? | No. It ships a TypeScript one. |
| Does a WebAssembly engine exist, built against this boundary? | Yes — [26-fsharp-wasm-engine.md](26-fsharp-wasm-engine.md). |
| Did moving an engine into WebAssembly require changing the boundary? | No. That is the claim the name makes, and it has now been tested. |

> An earlier version of this page said there was no WebAssembly anywhere in the
> repository. That was true when it was written and is recorded as finding
> **A-2** in [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md). The gap between
> the name and the implementation is what prompted the audit; the gap is now
> closed on the demonstration side and deliberately left open on the package
> side.

This document remains the guide to **moving your own engine** into WebAssembly.
For what actually happened when this project did it — the surprises, the
measured cost, and what it did and did not prove — read
[26-fsharp-wasm-engine.md](26-fsharp-wasm-engine.md).

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
can be moved into WebAssembly without changing the boundary.** That claim has
now been tested once, by doing it: neither `BrowserKernel` nor `src/protocol.ts`
changed. See [26-fsharp-wasm-engine.md](26-fsharp-wasm-engine.md).

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
| Loading/instantiation hook | ✅ done | `start()` loads and instantiates the module in [`wasm-transport.ts`](../site/app/wasm-transport.ts) |
| Serialization codec | ✅ built | JSON both ways; hand-written on the engine side ([`Json.fs`](../wasm/Limen.Engine/Json.fs)) |
| A WASM transport | ✅ built | [`site/app/wasm-transport.ts`](../site/app/wasm-transport.ts) |
| Toolchain, build, tests for one | ✅ built | [`scripts/build-wasm.ts`](../scripts/build-wasm.ts), [`test/wasm.test.ts`](../test/wasm.test.ts), 34 F# tests |

The design work was already done; the implementation has now been done once, for
the project's own site. **None of it is in the published package**, which still
ships the TypeScript engine — the right-hand column above describes `wasm/` and
`site/`, not `src/`.

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

That pre-emptive ban earned its keep. The F# engine in `wasm/Limen.Engine/` has
no JavaScript-interop reference at all — the one assembly that does is the 41-line
C# shim, on the other side of the line the check draws.

---

## What a real WASM transport would have to do

Written before one existed, as a description of the work so the size was
visible. Kept, because it is still the guide for **your** engine — and it can
now be checked against a real one:
[`site/app/wasm-transport.ts`](../site/app/wasm-transport.ts) is 96 lines
(mostly comment), [`Json.fs`](../wasm/Limen.Engine/Json.fs) is 213, and the shim
is 41. The estimate below was roughly the right shape.

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

`BrowserToEngineMessage` must become bytes the module can read, and
`EngineToBrowserMessage` must come back.

Decisions to make:

- **Format.** JSON is the obvious first move — the types are already
  JSON-shaped, so `JSON.stringify`/`parse` on both sides works with no protocol
  change. A compact binary format would be faster and much more work.
- **Memory.** Who allocates, who frees, and how a returned pointer/length pair
  is read out of `WebAssembly.Memory`.
- **Strings.** UTF-8 encode/decode across the boundary.
- **Errors.** A trap or a decode failure must surface as a rejected `dispatch`,
  which the kernel already handles as `BridgeError { phase: "dispatch" }`.

This used to end by noting that nothing proved the protocol survived a round
trip through a codec — the types made it likely, which is not the same as having
tested it. **That is no longer the case.**
[`test/wasm.test.ts`](../test/wasm.test.ts) crosses JSON in both directions
through a real WebAssembly module on every run, and the answers to the
decisions above turned out to be: JSON, no protocol change required, and a
hand-written writer on the engine side rather than a reflection-based
serializer — for the reasons in
[26-fsharp-wasm-engine.md](26-fsharp-wasm-engine.md#the-codec-is-hand-written).

The memory and string questions did not arise: .NET's JavaScript interop
marshals `string` across the boundary itself, so no pointer/length handling was
written by hand. A toolchain without that facility would still face them.

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

A third, learned by getting it wrong: **the port must refuse what the original
refuses.** The F# engine initially treated an unrecognized event as a no-op
where TypeScript threw. Both are defensible in isolation; only one matches the
documented rule, and the difference is invisible until a typo in someone's
markup produces a button that silently does nothing. If you port an engine, port
its failure behaviour and write a test that holds the two to it — see
[26-fsharp-wasm-engine.md](26-fsharp-wasm-engine.md#the-refusal-disagreement).

### 4. Testing

- Engine tests port to the target language's test framework.
- Kernel tests are unaffected — they use a `ScriptedTransport` and never touch a
  real engine.
- New tests needed: round-trip serialization, instantiation failure, trap
  handling.

### 5. Build and distribution

A second toolchain in CI, a `.wasm` artifact wherever it is served from, and a
decision about size — a WebAssembly runtime plus the module is much larger than
the current zero-dependency JavaScript.

Measured for the site's engine: **1.6 MB gzipped, of which the engine itself is
104 KB.** The runtime is forty times the size of the thing you wrote. Budget for
the runtime, not the engine.

---

## Open questions

Six were recorded here. Building the site's engine answered three, partly
answered one, and left two open. Kept together so the answers are visible as
answers rather than as prose that quietly replaced them.

1. ~~**Which language?**~~ **Answered for the site: F#.** Discriminated unions
   and exhaustive matching port directly, which is most of what an engine is.
   This is not a recommendation for anyone else — it is one data point, and the
   runtime it drags along is the dominant cost (below).
2. ~~**Which serialization format?**~~ **Answered: JSON, and no protocol change
   was needed.** A binary format was not attempted and there is no measurement
   saying it would be worth it.
3. **Does the async boundary stay honest?** *Argued, not measured.* A wasm call
   resolves synchronously inside a promise — exactly as
   `DirectTypeScriptTransport` already does — so the timing regimes the tests
   depend on are unchanged, and the site's tests pass under both engines. No
   experiment was run to try to break it.
4. **How is the module's own state persisted?** *Still open.* It lives in linear
   memory and a reload loses it, the same as today.
5. ~~**Is the size cost acceptable?**~~ **Measured, not judged: 1.6 MB gzipped,
   of which the engine is 104 KB.** Whether that is acceptable depends on the
   application; no budget has been set, and the measurement is the point rather
   than the verdict. See
   [26-fsharp-wasm-engine.md](26-fsharp-wasm-engine.md#what-it-costs).
6. **Does anything actually need this yet?** *Narrowly.* The site needed it: a
   site claiming a WebAssembly-ready boundary while running TypeScript is an
   argument, and running the F# engine makes it a demonstration. **No consumer
   has filed a requirement**, and per the repository's own 🧊 policy that is
   still the bar for putting one in the published package.

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

- [26-fsharp-wasm-engine.md](26-fsharp-wasm-engine.md) — the engine that was actually built, and what it cost
- [01-architecture.md](01-architecture.md) — why the boundary is shaped this way
- [11-api-reference.md](11-api-reference.md) — `EngineTransport` in full
- [ROADMAP.md](ROADMAP.md) — item 12, the serialization boundary
- [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md) — finding A-2
