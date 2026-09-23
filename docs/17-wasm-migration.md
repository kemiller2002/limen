# WebAssembly status: what exists now

**What this answers:** where WebAssembly is in the Limen repository, what the
npm package actually ships, and what the F# site proves about the boundary.

---

## Short answer

The historical answer was "there is no WebAssembly here."

That is no longer true.

There are now three distinct surfaces that must not be conflated:

1. **The npm package**
   `@echelon-foundry/typescript-wasm-kernel` still ships a TypeScript browser
   kernel, protocol types, reference engine, documentation, examples, and the
   F# lifecycle CLI. It does **not** ship a domain-specific WASM application
   engine.
2. **The Limen product site**
   The interactive site under `site/` is now a real Limen consumer whose
   application authority lives in F# and runs in .NET WebAssembly.
3. **The external time-entry consumer**
   `kemiller2002/time-entry-state-machine` independently runs an F# engine
   behind the same `EngineTransport` seam.

So the correct statement is:

> Limen is a TypeScript browser boundary with demonstrated F# WebAssembly
> consumers. The package does not require an application's engine to be
> TypeScript, F#, or any other specific language.

---

## The product site now crosses the real boundary

The deployed site follows this path:

```text
static HTML + CSS
        |
        v
Limen BrowserKernel
DOM bindings + browser effects
        |
        v
WasmSiteTransport
JSON in / JSON out
        |
        v
.NET WebAssembly runtime
        |
        v
Limen.Site.Engine (F#)
state + transitions + capabilities
obligations + effect interpretation + projection
```

Source:

- `site/app/main.ts`
- `site/app/wasm-engine-transport.ts`
- `site/fsharp/Limen.Site.Engine/`
- `site/fsharp/Limen.Site.Wasm/`

The old `site/app/engine.ts` no longer exists.

The site build fails if the deployed artifact does not contain a WebAssembly
runtime or if a legacy TypeScript site engine is emitted.

---

## Why there is a tiny C# file

`site/fsharp/Limen.Site.Wasm/Program.cs` contains the single `[JSExport]`
entry point used by .NET's JavaScript interop generator.

It has one job:

```csharp
[JSExport]
internal static string Dispatch(string messageJson) =>
    Limen.Site.Engine.Dispatch.handle(messageJson);
```

It has no state, transition, retry rule, capability, projection, or domain
decision.

The application remains F#. The C# file is marshalling glue at the runtime
boundary.

If .NET gains an equally small F#-native export mechanism that fits this
architecture, the shim can disappear without changing Limen or the application
engine.

---

## What the F# site engine actually owns

The site was deliberately converted with nontrivial examples.

The F# engine owns:

- release evidence state;
- approval legality;
- deployment capability;
- ambiguous external-effect handling;
- reconciliation obligations;
- stale-evidence rejection;
- correlation state;
- the architecture-placement challenge;
- scoring and explanations for that challenge;
- the visible transition trace;
- the full view projection used by HTML bindings.

The TypeScript site files do not contain those concepts.

This matters more than simply proving that WebAssembly can increment a counter.
The point of the boundary is to keep difficult application decisions on the
application side while the browser layer stays generic.

---

## What is now demonstrated

| Requirement | Status | Evidence |
| --- | --- | --- |
| A single narrow engine seam | demonstrated | `EngineTransport.start/dispatch` |
| Async loading hook | demonstrated | site transport loads .NET runtime in `start()` |
| JSON-serializable boundary | demonstrated for site message paths | TS serializes, F# parses/projects, TS parses response |
| F# application engine | demonstrated | `site/fsharp/Limen.Site.Engine/` |
| Real WebAssembly artifact | mechanically required | `scripts/check-site.ts` requires `.wasm` in Pages artifact |
| Kernel unchanged for F# engine | demonstrated | site consumes existing `BrowserKernel` |
| Application engine has no DOM dependency | demonstrated by project/source boundary | F# engine references no browser library or kernel implementation |
| Protocol version check | demonstrated | F# `Dispatch` rejects unsupported version |
| HTTP effect round trip | demonstrated | release deployment exercise |
| Correlation/stale-result guard | tested | F# site-engine tests |
| OutcomeUnknown preserved | tested | F# release state enters reconciliation |
| Storage across F# boundary | demonstrated externally | time-entry consumer |
| Clipboard across F# boundary | not demonstrated | TypeScript examples only |
| Navigation across F# boundary | not demonstrated | TypeScript examples only |
| Performance benefit | not measured | no controlled benchmark |
| Bundle/startup cost | not yet published as a comparative measure | artifact exists, no comparison |

The important distinction is that "demonstrated" means an implementation
exists and is verified. It does not mean that implementation is faster or
better than another architecture.

---

## What the npm package still ships

Limen remains a browser kernel.

Its runtime surface is TypeScript because that is the code executing browser
mechanics:

- event binding;
- projection application;
- HTTP;
- local storage;
- clipboard write;
- browser history/navigation;
- diagnostics.

An application engine may run:

- directly in TypeScript;
- in F#/.NET WebAssembly;
- in another language behind a compatible transport.

The package does not prescribe the application language.

The F# lifecycle CLI is separate from the browser runtime. It manages repository
installation, verification, upgrades, and diagnostics.

---

## Serialization is no longer hypothetical

The original repository documentation said:

> nothing currently proves the protocol survives a round trip through a codec.

That was true when the reference engine and kernel shared a JavaScript heap.

It is no longer true for the message paths used by the F# consumers.

The site does this for every interactive message:

```text
BrowserToEngineMessage
        |
 JSON.stringify
        |
        v
F# Protocol.parseMessage
        |
 F# transition + projection
        |
Protocol.serializeMessage
        |
        v
 JSON.parse
        |
EngineToBrowserMessage
```

This does not prove every future protocol extension or every current capability
has crossed F#. It proves the serialization seam is real and usable.

---

## The transport remains intentionally boring

The site transport is not another application layer.

Conceptually it does this:

```ts
await runtime.start();

async dispatch(message) {
  const response = wasm.Dispatch(JSON.stringify(message));
  return JSON.parse(response);
}
```

If the transport starts interpreting release state, HTTP status meaning, route
meaning, or retry policy, the architecture has failed.

---

## Effects still belong to the browser side

Moving application authority into WebAssembly does **not** mean giving
WebAssembly direct browser access.

The F# engine requests an effect as data.

For example:

```text
F# engine
  -> Http EffectRequest
Limen
  -> fetch(...)
browser
  -> response / failure / timeout
Limen
  -> classified EffectResult
F# engine
  -> application interpretation
```

The distinction between mechanism and meaning remains the entire point.

The F# site treats a timeout-after-dispatch as
`ReconciliationRequired`. Limen reports `OutcomeUnknown`; the engine decides
what that means for deployment safety.

---

## Why the site uses a harmless GET for the deployment exercise

The public Limen site must not perform an actual deployment or create external
state merely to demonstrate write safety.

The deployment challenge uses a harmless local GET for the real success path
and a guaranteed-unreachable reserved domain for the real network-failure path.

The timeout-after-dispatch path is different: a static Pages server cannot
guarantee a response will be slower than an arbitrary browser timeout. Rather
than make the demo flaky, that control injects an already-classified
`OutcomeUnknown` into the F# state machine. The kernel's conversion of an
actual timeout into `OutcomeUnknown{timeout-after-dispatch}` is tested at the
kernel layer.

The F# application then demonstrates the consequential part deterministically:

- unknown removes retry/deploy capability;
- reconciliation becomes required work;
- authoritative "applied" resolves to deployed;
- authoritative "not applied" safely reopens deployment.

The external mutation is intentionally not performed by the public site.

---

## Testing

The site has separate verification at each boundary.

### F# engine

`site/fsharp/tests/Limen.Site.Engine.Tests/`

Covers:

- release evidence gating;
- approval legality;
- immutable evidence after approval;
- effect creation;
- stale deployment result rejection;
- `OutcomeUnknown` to reconciliation;
- blind-retry rejection;
- reconciliation reopening deployment when authoritative evidence says
  "not applied";
- stale policy result rejection;
- placement challenge shape;
- projected capabilities;
- serialized dispatch.

### Site artifact

`scripts/check-site.ts`

Requires:

- `site/app/main.js`;
- `site/app/wasm-engine-transport.js`;
- Limen kernel/protocol output;
- `wasm/_framework/dotnet.js`;
- at least one real `.wasm` artifact;
- absence of `site/app/engine.js`.

### HTML/F# contract

`test/site.test.ts`

Cross-checks:

- bound top-level view keys against the F# projection vocabulary;
- HTML `data-event` names against F# `eventToCommand`;
- presence of the difficult scenarios;
- absence of application vocabulary from browser-side site code.

---

## Build requirements

Building the site requires:

- Node.js;
- .NET 8 SDK;
- the WebAssembly workload restored by the build.

```sh
npm run build:site
```

The script:

1. restores the WASM workload;
2. publishes the .NET WebAssembly site host;
3. runs the F# site-engine tests;
4. compiles the TypeScript browser mechanics;
5. assembles the Pages artifact.

Both normal CI and the Pages workflow install .NET.

---

## Multiple WebAssembly engines

Limen now also contains a language-neutral federation runtime in
`src/federation.ts`. It supplies module manifests, independent lifecycle,
versioned envelopes, contract compatibility checks, targeted cross-module
transition requests and compatible domain-event fan-out.

That closes a different question from the one this document originally tracked:
the package now has an explicit composition model for **multiple** engines rather
than requiring an application to grow one engine indefinitely.

It does **not** yet prove that the Limen product site runs several independent
F#/.NET WebAssembly binaries. The site remains one F# WASM engine today.
Federation support is implemented and tested at the transport/composition layer;
multi-F#-WASM self-hosting remains an existence proof to build.

The governing rule is that each module owns its state. Other modules exchange
serializable evidence, projections, events and transition requests rather than
sharing mutable domain objects. See
[23-wasm-federation.md](23-wasm-federation.md).

---

## What remains open

The old question "can Limen host a WASM engine?" is closed by existence proof.

These questions remain open:

1. **Performance.** No controlled TypeScript-engine versus F#-WASM benchmark
   exists.
2. **Startup/bundle budget.** The .NET runtime has a real size/startup cost, but
   no project budget or comparative decision threshold has been set.
3. **All capabilities across F#.** HTTP is exercised by the site; Storage is
   exercised by the time-entry consumer. Clipboard and Navigation are not yet
   demonstrated through an F# codec.
4. **Engine language choice per product.** Limen remains language-neutral. F#
   is the Echelon Foundry preference, not a protocol requirement.
5. **Controlled engineering outcome comparison.** No experiment isolates Limen
   as the variable for time, defects, rework, context, or cost.
6. **Multi-WASM self-hosting.** The federation runtime is implemented, but the
   product site has not yet been decomposed into multiple independently loaded
   F# WASM engines.

---

## If you are building a new F# consumer

The proven shape is now simple:

1. Model application state and transitions in F#.
2. Mirror Limen's protocol as explicit DTO/union types.
3. Parse one serialized `BrowserToEngineMessage`.
4. Return one serialized `EngineToBrowserMessage`.
5. Expose one marshalling entry point from the WASM host.
6. Implement `EngineTransport` as mechanical loader/serializer code.
7. Let `BrowserKernel` continue to own DOM and browser effects.

Do not expose browser objects to F# merely because the runtime can technically
interop with JavaScript. Doing so defeats the boundary.

---

## Evidence status

This document describes implementation status.

For claim strength, controlled measurements, adjacent SDE evidence, and known
limitations, see [19-evidence.md](19-evidence.md).

---

## Related

- [01-architecture.md](01-architecture.md)
- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md)
- [09-testing-and-debugging.md](09-testing-and-debugging.md)
- [11-api-reference.md](11-api-reference.md)
- [19-evidence.md](19-evidence.md)
- [23-wasm-federation.md](23-wasm-federation.md)
- [ROADMAP.md](ROADMAP.md)
