# Testing and debugging

**What this answers:** how to prove an application works, and how to find out
why it doesn't.

---

# Part 1 — Testing

## The payoff

Because transitions are pure functions, most of an application is testable with
no browser, no DOM, no mocks, and no async. That is the main practical benefit
of the architecture, so use it: push tests down to the pure layer wherever you
can.

## Three levels

| Level | Tests | Needs | Use for |
| --- | --- | --- | --- |
| **Transition** | `transition(state, command)` | nothing | legality, state machine shape, effect requests, stale-evidence guards |
| **Projection** | `project(state)` | nothing | capability keys, formatting, list shape |
| **Integration** | kernel + jsdom | `jsdom`, built `dist/` | bindings, event wiring, applied DOM, effect execution |

Default to the first two. Reach for the third only when the DOM is genuinely
what you are testing.

## Transition tests

Test the shape the architecture cares about: *given state X and evidence Y,
command Z legally transitions to state A and produces effect B* — **and test the
illegal case.**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { transition, initialState } from "../src/engine/domain.ts";

test("checking is illegal without a committed email", () => {
  const result = transition(initialState(), {
    kind: "CheckAvailability", capability: "Http", correlationId: "c1" as CorrelationId,
  });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.error, { kind: "IllegalFromCurrentState" });
});
```

Note there is no build step: engine sources import from `protocol.js`
**type-only**, so `node --experimental-strip-types` runs them directly.

```sh
node --experimental-strip-types --test test/*.test.ts
```

### Always test

1. **The legal path** — the transition happens, the right effects are requested.
2. **The illegal path** — rejected, and the state is *unchanged*.
3. **Stale evidence** — a result with a mismatched `correlationId` is discarded.
4. **All four outcomes** — `Success`, `Failure`, `Cancelled`, `OutcomeUnknown`.

Number 3 is the one people skip, and it is the one that produces the bug where
an old response overwrites a newer one:

```ts
test("a result for a superseded request is discarded", () => {
  const loading = transition({ kind: "Idle" }, { kind: "Load", correlationId: cid("load-2") }).state;
  const stale = transition(loading, {
    kind: "RecordLoad", correlationId: cid("load-1"),
    outcome: { kind: "Success", status: 200, body: CUSTOMERS },
  });
  assert.equal(stale.state.kind, "Loading", "the stale success must not land");
});
```

Number 4 is where `OutcomeUnknown` gets its teeth — the assertion below is the
one that stops someone adding a retry button to a POST later:

```ts
assert.equal(view["needsReconciliation"], true);
assert.equal(view["canRetry"], false, "a POST that may have succeeded must not be repeated");
```

## Integration tests

For DOM behavior. Two setup facts:

**Import `BrowserKernel` from `dist/`, not `src/`.** It has a real runtime
import of `PROTOCOL_VERSION`, and there is no `protocol.js` under `src/` — only the
`.ts` source. `pretest` builds first, so `dist/` is always fresh.

**Install jsdom's classes as real globals.** The kernel checks element identity
with bare `instanceof HTMLInputElement`, matching a real browser. jsdom carries
its own copies, so `withDom` swaps them in for the duration of a test — see
[`test/dom-helpers.ts`](../test/dom-helpers.ts).

### Use a scripted transport

```ts
class ScriptedTransport implements EngineTransport {
  readonly calls: BrowserToEngineMessage[] = [];
  constructor(readonly handler: TransportHandler) {}
  async start(): Promise<void> {}
  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    this.calls.push(message);
    return this.handler(message, this.calls);
  }
}
```

Assert on both what was dispatched (`transport.calls`) and the resulting DOM.

### The two timing regimes — read this before writing one

This is the most common source of tests that pass for the wrong reason.

```ts
button.click();
assert.equal(transport.calls.length, 2);   // SAFE — dispatch is synchronous
                                            // inside the click's own call chain
await flush();                              // setTimeout(resolve, 0)
assert.equal(p.textContent, "Saving…");     // REQUIRED — applying the response
                                            // happens after a microtask boundary
```

- Asserting on **dispatch**: safe immediately.
- Asserting on **applied DOM**: needs `await flush()` first.

Skip the flush and your test either fails flakily or passes because the
assertion was vacuous.

### Never call `start()` twice

It re-binds the whole document and double-registers every listener. To get a
later projection, go through a real event round trip — see the `tick()` helper
in [`test/kernel.test.ts`](../test/kernel.test.ts).

### Stubbing fetch

```ts
function stubFetch(route: Route) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input, init) => {
    calls.push({ url: String(input), init });
    const result = route(String(input), init);
    if (result === "network-error") throw new Error("simulated network failure");
    return { status: result.status, json: async () => result.body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}
```

Recording the calls lets you assert the engine's request survived intact:

```ts
assert.equal(post.init?.body, JSON.stringify({ date: "2026-09-02", hours: 1.5, description: "Review" }));
```

Full working version: [`test/examples.test.ts`](../test/examples.test.ts).

### What not to test at the DOM level

Timeouts. Provoking one needs a real `timeoutMs` to elapse. Test the
`OutcomeUnknown` *transition* directly instead — it is the part that matters and
it runs instantly.

## Testing examples and docs

[`test/examples.test.ts`](../test/examples.test.ts) drives every example through
the real kernel against its **actual `index.html`**, read from disk by
`exampleBody()`. If an example's markup and its engine drift apart, the suite
fails. Examples are product, not decoration.

[`scripts/check-docs.ts`](../scripts/check-docs.ts) checks that Markdown links
resolve, that file paths mentioned in prose exist, and that no document under
`docs/` is orphaned.

## Running everything

```sh
npm run check
```

Which runs: `build` → `build:examples` → `check:architecture` → `check:docs` →
all tests. Run this before calling anything done — not just `tsc`.

### What is *not* covered

- **Real-browser behavior.** jsdom is not Chrome. Anything touching layout,
  focus, or caret needs a real browser. Per this repository's definition of
  done, DOM-affecting changes are exercised in a browser as well.
- **Visual appearance.** No screenshot testing.
- **Accessibility.** No automated a11y assertions.

---

# Part 2 — Debugging

## Install a diagnostics sink first

The single most useful debugging move. The kernel reports its own mechanism
failures — which are otherwise silent, because the error boundary deliberately
does not throw.

```ts
const kernel = new BrowserKernel(transport, document, {
  report(event) {
    if (event.kind === "BridgeError") console.error(`[bridge:${event.phase}]`, event.detail);
    else console.debug(`[effect] ${event.correlationId} ${event.durationMs.toFixed(1)}ms`);
  },
});
```

Without a sink, the default is a **no-op** — a broken projection produces no
console output at all. If "nothing happens and there are no errors", this is
almost certainly why.

| Event | Means |
| --- | --- |
| `BridgeError { phase: "dispatch" }` | the transport threw, or `start()` rejected |
| `BridgeError { phase: "binding" }` | the markup is malformed — nothing was bound, `Initialize` never sent |
| `BridgeError { phase: "projection" }` | applying the view threw — usually a missing key |
| `EffectTiming` | an effect completed; how long it took |

**Never log the raw `EffectRequest`** — headers carry credentials. Log
`correlationId` and timing only.

## Trace the round trip

When behavior is wrong, find which hop is wrong. Log at the transport, which
sees both directions:

```ts
function traced(inner: EngineTransport): EngineTransport {
  return {
    start: () => inner.start(),
    async dispatch(message) {
      console.group(message.kind);
      console.log("→", message);
      const response = await inner.dispatch(message);
      console.log("←", response);
      console.groupEnd();
      return response;
    },
  };
}

await new BrowserKernel(traced(createTransport()), document).start();
```

Then work down the list:

1. Is the message arriving at all? → no: a binding or trigger problem
   ([05](05-events-and-dispatch.md))
2. Is `name`/`key`/`value` what you expect? → no: a markup problem
3. Is the returned `view` right? → no: a transition or projection problem —
   which is a pure function, so write a unit test
4. Is the view right but the DOM wrong? → a binding problem
   ([06](06-rendering.md))

That sequence localizes nearly every bug in three or four steps.

## Inspect state directly

`ReferenceEngine` exposes `get state()`. Doing the same in your own engine
during development is worthwhile — but expose it as a **read-only getter**, and
never let anything write through it.

## Use the kitchen sink

[`examples/kitchen-sink.html`](../examples/kitchen-sink.html) exercises every
bridge primitive and every effect outcome interactively, with a live diagnostics
panel. It has deliberate buttons for a malformed projection and a thrown
transport, so you can see what those failures look like before meeting one in
your own code.

```sh
npm run build && python3 -m http.server 4173
# → http://localhost:4173/examples/kitchen-sink.html
```

## Symptom index

Full version: [16-troubleshooting.md](16-troubleshooting.md).

| Symptom | Look at |
| --- | --- |
| Click does nothing | binding, trigger type, `start()` called once |
| Page stuck on placeholder text | `transport.start()` rejected — check diagnostics |
| Content never appears | typo'd `data-if` key — silently falsy |
| `View value for "x" is missing` | projection isn't total |
| Fetch succeeds, nothing updates | stale-result guard rejecting a valid result |
| Caret jumps while typing | `data-bind-value` fighting the user |
| Everything happens twice | `start()` called twice |

---

## Related

- [03-kernel-lifecycle.md](03-kernel-lifecycle.md) — what should happen, in order
- [11-api-reference.md](11-api-reference.md) — `DiagnosticsSink` signature
- [16-troubleshooting.md](16-troubleshooting.md) — symptom → cause → fix
