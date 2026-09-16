# The F# WebAssembly engine

**What this answers:** this project's own website runs on an engine written in
F# and compiled to WebAssembly. How was it built, what did it cost, and what did
building it actually prove?

[17-wasm-migration.md](17-wasm-migration.md) described the migration as designed
but unattempted, and listed the open questions nobody had answered. This
document is what happened when it was attempted. Several of those questions now
have measurements instead of guesses, and one prediction turned out to be wrong.

---

## What exists

| Path | Language | Role |
| --- | --- | --- |
| [`wasm/Limen.Engine/`](../wasm/Limen.Engine/) | F# | The engine. Pure. No browser, no JS interop, no I/O. |
| [`wasm/Limen.Host/`](../wasm/Limen.Host/) | C# | A 41-line marshalling shim. Nothing else. |
| [`wasm/tests/Limen.Engine.Tests/`](../wasm/tests/Limen.Engine.Tests/) | F# | 34 tests, run as ordinary .NET — no browser needed. |
| [`site/app/wasm-transport.ts`](../site/app/wasm-transport.ts) | TypeScript | An `EngineTransport` backed by the module. |
| [`site/app/engine.ts`](../site/app/engine.ts) | TypeScript | The same engine again, as a fallback. See [Two engines](#two-engines-and-why-that-is-not-a-disaster). |
| [`scripts/build-wasm.ts`](../scripts/build-wasm.ts) | TypeScript | `dotnet publish`, then stage the bundle for the site. |
| [`test/wasm.test.ts`](../test/wasm.test.ts) | TypeScript | Drives the real module through the real kernel. |

**This is the site's engine, not the package's.** The published npm package still
ships `DirectTypeScriptTransport` and a TypeScript engine in `src/engine/`;
`wasm/` is not in `package.json`'s `files`. Nothing about a consumer's install
changed. The point of the exercise was to prove the boundary holds under a real
language change, not to force one on anybody.

---

## The one thing that had to change: nothing

The claim [17](17-wasm-migration.md) made was that an application written
against `EngineTransport` can move into WebAssembly **without changing the
boundary**. That claim now has a diff behind it.

`BrowserKernel` was not modified, not subclassed, and not configured
differently. It is handed a different `EngineTransport`:

```ts
await new BrowserKernel(chosen.transport, document, { … }).start();
```

`src/protocol.ts` was not changed for this either. The types were already
"plain, JSON-serializable data only", so `JSON.stringify` on one side and a
hand-written parser on the other was the entire codec.

The two methods `EngineTransport` has turned out to be the two methods a wasm
transport needs, for the reason 17 predicted: `start()` exists and is awaited,
so there was already a place for "load and instantiate the module", and its
rejection was already handled.

---

## `[JSExport]` does not work from F#

The one genuine surprise, and the reason a C# file exists in an otherwise F#
engine.

`[JSExport]` is implemented by a **C# Roslyn source generator**. F# projects do
not run Roslyn source generators. An F# method carrying the attribute compiles
without error, produces no warning, and then registers nothing at all — the
JavaScript side receives an exports object with no members.

This was not deduced from documentation. A pure-F# build was published and
loaded in Chromium, and the exports object came back empty. The failure mode is
silent on both sides, which is what makes it worth writing down.

The route taken is [`wasm/Limen.Host/Interop.cs`](../wasm/Limen.Host/Interop.cs):
a `static partial class` whose entire content is

```csharp
[JSExport]
internal static string Dispatch(string message) => Limen.Engine.Engine.handle(message);
```

`partial` matters — the generator emits the other half.

The shim marshals a string in and a string out, holds no state, makes no
decision, and knows nothing about what a message means. That is the same
contract the kernel has on the other side of the wire, which is a reasonable
sign the boundary was drawn in the right place.

> **How far the evidence goes.** What was tested is the heading of this section:
> `[<JSExport>]` on an F# method registers nothing. That does **not** establish
> that a C# file is *required* to export from a .NET WebAssembly module — no
> alternative was exhausted before this one was reached for, and "the attribute
> does not work" and "C# is necessary" are different claims. Hand-writing what
> the generator emits, or inverting the direction so the module calls out rather
> than being called in, are both unexplored here. If a pure-F# route exists,
> this section is overstated and the shim should go; the engine, the codec and
> the agreement test are F# already, so removing it would change the story
> rather than the architecture.

### `[SupportedOSPlatform("browser")]`

Required, or `CA1416` fails the build: `JSExportAttribute` is only supported on
the browser platform, and the project treats warnings as errors.

---

## The transport touches no browser API

Worth stating, because it is the kind of thing that quietly stops being true.

[`wasm-transport.ts`](../site/app/wasm-transport.ts) takes an **absolute**
bundle URL and never resolves one. Resolving needs `document.baseURI`, and the
transport has no business reaching for it: composition knows where the page is,
a transport does not. [`main.ts`](../site/app/main.ts) does it and hands the
result over.

This was not designed in — `check-architecture.ts` caught `document` in the
transport and the code moved to satisfy it. The rule earned its place twice in
one file.

There is a bug that this signature now makes impossible, and which happened
before it did. A dynamic `import()` with a relative specifier resolves against
*the importing module's* URL, not the page's, so `./wasm` from
`site/app/wasm-transport.js` requests `/site/app/wasm/…` and 404s — and the
TypeScript fallback then hid it behind a page that worked perfectly. An engine
choice that degrades silently is worse than one that fails, which is why
`start()` throws by name when the exports object has no `Dispatch`.

---

## The codec is hand-written

[`wasm/Limen.Engine/Json.fs`](../wasm/Limen.Engine/Json.fs) is 213 lines of
parser and writer. Using `System.Text.Json` would have been shorter.

This follows the Wire Contract Rule from the vendored SDE methodology: a wire
format is rendered by a **hand-written function, never a host language's or
framework's default serializer**. A default serializer makes the wire format a
function of the host language's type system, so renaming an F# field, adding a
case, or upgrading the runtime silently changes what crosses the boundary. The
contract in `src/protocol.ts` is supposed to be the authority on that, and a
reflection-based serializer quietly makes F# the authority instead.

It also keeps the trimmer honest: the engine uses no reflection, so
`PublishTrimmed` can be aggressive.

One detail worth keeping: integers are written without a decimal point. F#
represents them as `float` internally, and `3.0` where the protocol says `3`
would be a wire change nobody intended.

---

## What it costs

Measured, not estimated. Numbers from the staged bundle and from a real
Chromium run — see [How it was verified](#how-it-was-verified).

### Size

| | Bytes |
| --- | --- |
| Staged bundle, everything | 4.8 MB |
| Excluding `.map` and `.symbols` | 4.1 MB |
| The same, gzipped | **1.6 MB** |
| `Limen.Engine.wasm` — the F# engine itself | 104 KB |

The engine is 2.5% of the download. The rest is the .NET runtime:
`System.Private.CoreLib.wasm` (1.6 MB), `dotnet.native.wasm` (1.3 MB) and
`FSharp.Core.wasm` (254 KB).

That is the honest shape of the cost. **You are not shipping an engine, you are
shipping a runtime**, and it dominates by a factor of forty. A language whose
WebAssembly output does not carry a runtime — Rust, or C with no standard
library — would produce a dramatically different number, and this measurement
says nothing about those.

Source maps and symbols (474 KB) are shipped deliberately: this is a site whose
purpose is to be taken apart by people who do not believe it.

### Time

On localhost, headless Chromium, warm cache disabled: **14 requests, engine
ready at ~350 ms.**

Read that as a lower bound and nothing more. It is a loopback interface with no
compression, no latency, and no contention. It does not predict a phone on a
mobile network, and no measurement here does.

### Build

`dotnet publish` takes about a minute and needs the `wasm-tools` workload.
`npm run build:wasm` wraps both and stages the result.

> **On the sandbox limits recorded in [CLAUDE.md](../CLAUDE.md):** Microsoft's
> CDN is proxy-blocked in the hosted agent environment, but `wasm-tools`
> installs from NuGet, which is not. An earlier note concluding WebAssembly
> tooling was unavailable here was wrong, and has been corrected.

---

## Two engines, and why that is not a disaster

The site ships the F# engine **and** a TypeScript engine implementing the same
behaviour, and falls back if the module does not load.

This is textbook Uncoordinated Duplication — one semantic decision, two
implementations, nothing requiring them to match — and it is the first thing
that should be objected to. The fallback is still worth having: 1.6 MB over a
bad network is a real failure, and a site whose every demo dies in that case
would be a poor advertisement for an architecture arguing that failure should be
handled rather than assumed away.

So the duplication is accepted, and the coordination is made mechanical.
[`test/wasm.test.ts`](../test/wasm.test.ts) drives both engines through one
event sequence and requires:

- **identical projections** at every step, key by key;
- **the same set of keys** — a key only one engine projects is a blank element
  on whichever page ships without it;
- **the same effects** for the same event, correlation ids aside;
- **the same refusals** — see below.

Drift fails a test instead of reaching a deployed page. This is not a
theoretical benefit: the F# projection was missing the trace's `event` key, and
this is what caught it.

### The refusal disagreement

The two engines genuinely disagreed once, and the test found it. Given a
`data-event` naming an event that does not exist:

- TypeScript threw `Unrecognized event: …`
- F# returned no command and re-projected unchanged

The F# behaviour was wrong, and not merely different.
[02-getting-started.md](02-getting-started.md) states the rule — *a typo in an
HTML attribute should be loud* — and the quiet version produces a page whose
buttons do nothing with no error anywhere to explain why.

`eventToCommand` in F# now returns `Result<Command, string>` rather than
`Command option`: the function stays total and pure, the reason travels as
ordinary data, and `Engine.handle` is the single place that decides to raise.
The exception surfaces on the JavaScript side as a rejected `dispatch()`, which
the kernel already reports as `BridgeError { phase: "dispatch" }` without
touching the DOM.

---

## How it was verified

Three layers, because each can only see some of it.

1. **[`wasm/tests/Limen.Engine.Tests/`](../wasm/tests/Limen.Engine.Tests/)** —
   34 F# tests over the engine as ordinary .NET. No browser, no WebAssembly.
   Run by `npm run test:wasm`, and in CI on every push.
2. **[`test/wasm.test.ts`](../test/wasm.test.ts)** — hosts the real module under
   Node (`dotnet.js` supports Node as well as browsers), drives it through the
   real `BrowserKernel`, and runs the agreement suite. Part of `npm test`; it
   reports as **skipped** rather than passing when the bundle has not been
   built, because a check that did not run must not look like one that did.
3. **A real browser.** jsdom cannot instantiate a WebAssembly module, so the
   site is driven in headless Chromium over CDP: the page reports
   `data-engine="fsharp-wasm"`, `dotnet.native.wasm` and `Limen.Engine.wasm`
   appear in `performance.getEntriesByType("resource")`, and the demos — counter
   transitions, a refused illegal transition, a real `fetch` classified by F#,
   and an `OutcomeUnknown` timeout — all work end to end. Checked at a domain
   root **and** under a project path (`/typescript-wasm-kernel/…`), because that
   is how Pages actually serves it and because the bundle URL is exactly the
   kind of thing that works at one and not the other.

The Pages workflow builds the bundle before building the site, and runs
`check-site.ts` with `LIMEN_REQUIRE_WASM=1`, which turns a missing engine from a
warning into a failed build. Without that, the TypeScript fallback is good
enough to hide its own absence completely: the site would look perfect and
quietly disprove its own front page.

---

## What this did and did not prove

**Proved.**

- The protocol survives a round trip through a codec. 17 said plainly that
  nothing demonstrated this and that the types made it likely, which is not the
  same as having tested it. Every assertion in `test/wasm.test.ts` crosses JSON
  in both directions through real WebAssembly.
- The boundary holds under a language change. The kernel is untouched and cannot
  tell the difference.
- Discriminated unions, exhaustive matching and pure transitions port to F#
  directly. The engine reads like the TypeScript one because the architecture,
  not the language, was doing the work.
- The `JsValue`/`IJSRuntime` ban in
  [`check-architecture.ts`](../scripts/check-architecture.ts) was worth having
  pre-emptively. `Limen.Engine` has no JS interop reference at all; the one
  assembly that does is the C# shim, on the other side of the line.

**Not proved.**

- **That the C# shim is necessary.** Only that `[<JSExport>]` does not work from
  F#. See the note in
  [`[JSExport]` does not work from F#](#jsexport-does-not-work-from-f).
- **That this is a good idea for a typical application.** 1.6 MB is a real cost
  and there is no budget it was measured against.
- **Anything about performance.** No benchmark was run. The engine does trivial
  work; a page load dominated by runtime instantiation says nothing about an
  engine that computes.
- **That the async boundary stays honest** (17's open question 3). A wasm call
  resolves synchronously inside a promise, exactly as
  `DirectTypeScriptTransport` does, so the timing regimes are unchanged — but
  that is an argument, not a measurement.
- **Module state across a reload.** It lives in linear memory and is lost, the
  same as today. Open question 4 is still open.

The 🧊 policy question — *does anything actually need this?* — is answered
narrowly. The site needed it, because a site claiming a WebAssembly-ready
boundary while running TypeScript is an argument, and running the F# engine
makes it a demonstration. No consumer has asked for one.

---

## Related

- [17-wasm-migration.md](17-wasm-migration.md) — the design, and what migration takes
- [01-architecture.md](01-architecture.md) — why the boundary is shaped this way
- [11-api-reference.md](11-api-reference.md) — `EngineTransport` in full
- [09-testing-and-debugging.md](09-testing-and-debugging.md) — the testing layers
- [ROADMAP.md](ROADMAP.md) — item 12, the serialization boundary
