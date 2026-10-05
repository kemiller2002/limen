# Worker-hosted engines

> **Optional — not Limen Core.** This is worker hosting, an optional host. It composes with the Core concept `correlation-compatibility`: the same boundary and handshake run with the engine in a worker. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

The engine can run in a dedicated worker, off the main thread. The boundary,
the kernel and the page stay the same, whatever language the engine is
written in (kemiller2002/limen#41, LCP-035).

```ts
// The page: a transport like any other. The kernel does not know the engine moved.
import { WorkerTransport } from "@echelon-foundry/limen/hosts/worker";

const transport = new WorkerTransport({
  createWorker: () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" }),
});
await new BrowserKernel(transport, document, diagnostics, { requireHandshake: true }).start();
```

```ts
// worker.js: the worker's composition root builds whichever engine it runs.
import { serveEngine } from "@echelon-foundry/limen/hosts/worker-engine";
import { RawWasmTransport } from "@echelon-foundry/limen/hosts/raw-wasm";

serveEngine(self, () => new RawWasmTransport({ loadModule: () => fetch("./engine.wasm") }));
```

## What crosses, and what does not

- **Crosses:** the same serialized `BrowserToEngine` / `EngineToBrowser` JSON an
  in-process WebAssembly transport carries, as strings. On the worker side,
  each message is decoded with the generated contract decoder before the
  engine sees it. On the page side, each reply is decoded before the kernel
  sees it.
- **Does not cross:** DOM objects, functions, `SharedArrayBuffer`, or any other
  shared memory. The kernel, the DOM and every effect (Http, Storage,
  Clipboard, Navigation, capability packs) stay on the main thread. The worker
  holds only the engine: the one owner of application state. There is no
  second owner on the main thread.
- **Not known to the host:** the guest language. The same `WorkerTransport`
  runs the F#, C# and Rust minimal engines. The worker's own composition root
  ([`guests/minimal/host/worker.ts`](../guests/minimal/host/worker.ts)) chooses
  the engine.

Requests are answered strictly in the order they arrived: one engine, one
thread.

## Faults

A worker can fail in several ways. Each is a `WorkerFault` whose name says
which:

| Name | When |
| --- | --- |
| `WorkerStartFailed` | the engine did not load or start (a missing module, a throw in `start`, no answer within `startTimeoutMs`, 60 s by default) |
| `WorkerCrashed` | the worker threw after starting |
| `WorkerMessageError` | a message from the worker could not be deserialized |
| `WorkerEngineFailed` | the engine threw while handling a message |
| `WorkerTimeout` | one dispatch took longer than `dispatchTimeoutMs` (30 s by default) |
| `WorkerTerminated` | the page called `terminate()` |

On any fault, the transport **terminates the worker**, because an engine
whose state is unknown must not keep running. It then rejects everything in
flight and every later dispatch with the same fault. Nothing hangs. The
kernel reports the failed dispatch as a `BridgeError` whose detail names the
fault. Under the fallback host ([docs/44](44-fatal-fallback.md)) the
fault becomes a redacted error id such as `LIMEN-DISPATCH-WorkerTerminated`.
A restart there is a **new worker** whose engine starts from its own initial
state. Restoring state across the restart is the engine's own snapshot, as
with hot reload ([docs/47](47-hot-reload.md)).

A reply that does not decode is refused on the page side, like any other
transport's malformed reply. The worker is not ended for it.

## Measurements

`npm run bench:worker` writes
[`bench/results/worker-hosting.json`](../bench/results/worker-hosting.json):
medians of 5 cold runs in Chromium 141, on a 4-core 2.8 GHz Xeon under Linux.
The method follows `scripts/bench.ts` ([docs/27](27-performance-baseline.md)).
Treat the numbers as ratios on this machine, not as promises.

| Measurement | In the page | In a worker |
| --- | --- | --- |
| Startup to a verified handshake: F# | 1818 ms | 1109 ms |
| Startup: C# | 560 ms | 566 ms |
| Startup: Rust | 73 ms | 99 ms |
| One small event round trip: F# / C# / Rust | 1.6 / 1.4 / 0.1 ms | 1.8 / 1.8 / 0.4 ms |
| A 77 KB view: round trip, and main thread blocked | 3.1 ms, 5 ms | 3.2 ms, 5 ms |
| A 790 KB view | 24.6 ms, 25 ms | 28.8 ms, 23 ms |
| A 4 MB view | 122.6 ms, 123 ms | 136.8 ms, 96 ms |
| An engine transition that computes for 300 ms: main thread blocked | **301 ms** | **11 ms** |

What the numbers say:

- **The hop costs 0.2 to 0.4 ms per message.** That is negligible for
  interaction, and it matters only for very chatty engines.
- **Long transitions are where a worker pays.** A 300 ms transition freezes
  the page for 301 ms in the page, and for none of it in a worker. The 11 ms
  gap is the 10 ms ticker's own interval.
- **Large views are not helped much.** Building a view and stringifying it
  move to the worker, but parsing and decoding the reply stay on the main
  thread, because the kernel needs the decoded view there. At 4 MB the page
  is still blocked for 96 ms instead of 123 ms. The fix for a large view is a
  smaller view: incremental projection, obligations WI-0043 and WI-0045.
  Moving the engine does not fix it.
- **Startup depends on the runtime.** The .NET runtime started faster in a
  worker in these runs (F# 1818 → 1109 ms), because it no longer competes
  with the page's own start. The Rust engine is small enough that the
  worker's own start (about 25 ms) dominates.

## Recommendation

**Optional, and recommended for one workload.**

| Workload | Worker hosting |
| --- | --- |
| Transitions that compute for tens of milliseconds or more (search, layout, pricing, simulation) | **Recommended.** The page stays responsive while the engine works. |
| A heavy runtime that is slow to start (.NET) | **Worth measuring.** It started faster here, off the main thread. |
| Small, chatty engines (most forms and CRUD) | **Optional.** It is correct and cheap, but buys nothing measurable. |
| Views of megabytes | **Unsuitable as the fix.** Most of the cost stays on the main thread. Make the view smaller. |

Everything else is unchanged either way, so moving an engine is a
composition-root change and can be reversed.

## Proof

- [`test/worker-transport.test.ts`](../test/worker-transport.test.ts) (jsdom,
  a scripted worker pair that structured-clones every message):
  - the unchanged kernel drives a counter and an Http round trip through a
    worker;
  - only serialized JSON crosses;
  - replies come back in order;
  - every fault by name, with the worker terminated;
  - a malformed reply is refused;
  - messages outside the contract are refused inside the worker;
  - the fallback host gives an error id and restarts with a new worker.
  A mutation check confirmed that tests fail when a faulted worker is not
  terminated.
- `npm run smoke:guests` (Chromium) runs the F#, C# and Rust engines twice:
  once in the page and once in a worker, through the same page and kernel.
  In worker mode it also proves:
  - every capability's success and failure path;
  - that the main thread loaded **no engine code**. The same probe does see
    the engine in page mode, so its silence in the worker run means
    something;
  - that a terminated worker is a `WorkerTerminated` fault, not a hang;
  - that an engine that cannot load is `WorkerStartFailed`.
