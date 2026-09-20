# Limen product-site application engine

The Limen product site is itself a Limen application.

## Authority boundary

Application authority lives in `Limen.Site.Engine`, written in F#.

It owns:

- release evidence state;
- approval legality;
- deployment state;
- reconciliation obligations;
- stale-evidence rejection;
- correlation state;
- the placement challenge;
- challenge scoring;
- projected capabilities;
- the transition trace;
- all values bound by the interactive HTML.

The browser side owns mechanics:

- static HTML and CSS;
- `BrowserKernel`;
- browser effects;
- loading the .NET WebAssembly runtime;
- moving serialized Limen messages across the boundary.

## The C# host is not an application layer

`Limen.Site.Wasm/Program.cs` exists because .NET's `JSExport` source
generator uses a C#/Roslyn boundary.

It must remain a pure marshalling shim.

Allowed:

```csharp
Dispatch(string json) => Limen.Site.Engine.Dispatch.handle(json)
```

Not allowed:

- application state;
- branching on event names;
- interpreting HTTP status;
- deciding retry behavior;
- projecting UI values;
- reading browser globals.

If any of those appear in the C# host, move them back to F#.

## TypeScript site code

`site/app/main.ts` and `site/app/wasm-engine-transport.ts` are mechanism
only.

They may:

- create `BrowserKernel`;
- load the .NET runtime;
- obtain the exported Dispatch function;
- JSON serialize/parse Limen messages;
- report diagnostics.

They must not contain application vocabulary such as:

- release approval;
- evidence gates;
- reconciliation;
- policy-check results;
- placement answers.

`test/site.test.ts` contains a negative assertion for representative
application concepts.

## Build

```sh
npm run build:site
```

The build restores the WebAssembly workload, publishes the WASM host, runs the
F# engine tests, compiles the browser mechanics, and assembles `dist-site/`.

## Verification

```sh
npm run test:site:fsharp
npm run check:site
```

Normal `npm run check` runs both through the site build/test pipeline.

## Design rule

If the application would behave differently because of a value, that value is
F# application state or evidence.

If the code merely carries a browser interaction, performs a requested browser
effect, loads the runtime, or applies a projection, it belongs on the Limen
browser side.

If the needed browser capability does not exist, do not reach around Limen.
File a protocol/capability change.


## Real-browser gate

A source build is not enough to establish that the self-hosting boundary works
in a browser.

`npm run smoke:site:wasm` serves the assembled `dist-site/` artifact, opens
the real page in headless Chrome/Chromium, allows the .NET WebAssembly runtime
to initialize, and asserts values that are projected only by the F# engine.

CI and the Pages workflow both run this gate after the ordinary build and
artifact checks.

This prevents several false-green states:

- static HTML published while the WASM loader is broken;
- `dotnet.js` present but unable to load the exported assembly;
- the C# export present but unable to reach F# dispatch;
- Limen starting without the F# initialization projection reaching the DOM.

Do not replace this with a jsdom-only check. jsdom remains useful for structural
binding tests, but it does not execute the deployed .NET WebAssembly runtime.
