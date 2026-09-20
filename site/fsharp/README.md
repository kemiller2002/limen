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
