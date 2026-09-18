# Three complete traces

Most documentation shows fragments. This document follows **three whole
interactions** from a physical click to a changed pixel, naming the real file
and the real function at every step.

If you are an agent trying to place a change, these traces are usually faster
than reading the source: find the step your change belongs to, and you have
your file.

Kernel steps happen in
[`src/kernel/browser-kernel.ts`](../src/kernel/browser-kernel.ts). The contract
is [`src/protocol.ts`](../src/protocol.ts).

---

## Trace 1 — Copy a URL to the clipboard

Example: [`examples/07-clipboard/`](../examples/07-clipboard/README.md).

| # | What happens | Where |
| --- | --- | --- |
| 1 | User clicks a row's **Copy** button | `examples/07-clipboard/index.html` |
| 2 | The listener the kernel registered at `start()` fires | `#bindEvent` |
| 3 | The kernel reads the enclosing `data-each` row's key and the element's value | `#fire`, `readValue` |
| 4 | `SemanticEvent { name: "copy", key: "This page" }` is built | `makeEvent` |
| 5 | It is dispatched through the one chokepoint every round-trip uses | `#send` |
| 6 | The engine turns the opaque key into a URL | `eventToCommand`, `examples/07-clipboard/engine.ts` |
| 7 | `transition` returns `Copying` **and** one `Clipboard` effect | `transition`, same file |
| 8 | The kernel applies the new projection — the button disables *before* the copy runs | `#applyScope` |
| 9 | The kernel executes the effect | `#runEffect` → `#executeClipboard` |
| 10 | `navigator.clipboard.writeText(text)` — the only place this call exists | `writeClipboardText` |
| 11 | The browser grants or refuses | the browser |
| 12 | The result is classified into a closed set | `classifyClipboardError` |
| 13 | `ClipboardResult { outcome }` goes back to the engine | `#executeEffect` → `#send` |
| 14 | The engine checks the correlation id, then transitions to `Copied` or `CopyFailed` | `transition`, the `RecordCopy` case |
| 15 | `project` produces the status line and whether a retry is worth offering | `project` |
| 16 | The kernel writes the status text and re-enables the button | `#applyScope` |

**Three things this trace makes concrete**

- Step 7 is where "waiting" becomes a *state*. The button is disabled by step
  8 — before the browser has done anything — because the engine already knows a
  copy is in flight.
- Step 12 is the kernel's entire contribution to meaning: it classifies a
  transport-level outcome and stops. Whether `denied` deserves a retry button
  is decided at step 15, by the engine.
- The copied text appears at steps 7, 9 and 10 and **nowhere else** — in
  particular not in any diagnostic event.

---

## Trace 2 — The user presses the browser's Back button

Example: [`examples/08-routing/`](../examples/08-routing/README.md).

This one starts in the browser, not in your application, and that is what makes
it worth tracing.

| # | What happens | Where |
| --- | --- | --- |
| 1 | User presses **Back** (or Forward, or a trackpad gesture) | the browser |
| 2 | The browser changes the URL and fires `popstate` | the browser |
| 3 | The listener the kernel registered at `start()` fires | `start()` |
| 4 | The kernel reads `window.location` and splits it mechanically | `readLocation` |
| 5 | `LocationChanged { location: { path, query, hash } }` is dispatched | `#send` |
| 6 | The engine parses the location into a typed `Route` | `parseRoute`, `examples/08-routing/engine.ts` |
| 7 | `AdoptLocation` transitions the route — **and requests no effect** | `transition` |
| 8 | `project` marks exactly one screen as visible | `project` |
| 9 | `data-if` unmounts the old screen and mounts the new one | `#applyIf` |

**The single most important line in the whole document is step 7.**

Asking the browser to navigate in response to `LocationChanged` is the classic
routing bug: Back fires `popstate`, the engine pushes the old URL back onto the
stack, and the user is trapped on the page. The browser has *already* moved;
there is nothing to ask for.

Compare the other direction — the application deciding to move:

| # | What happens | Where |
| --- | --- | --- |
| 1 | User clicks **Invoices** | `examples/08-routing/index.html` |
| 2 | `SemanticEvent { name: "goInvoices" }` | `makeEvent` |
| 3 | `Navigate(Invoices)` — the engine's route changes immediately | `transition` |
| 4 | …*and* one `Navigation { operation: "push", url }` effect is returned | `transition` |
| 5 | `history.pushState(null, "", url)` | `runNavigation` |
| 6 | `NavigationResult { Success, location }` — an acknowledgement | `#executeNavigation` |
| 7 | Nothing changes: the engine was already right | `RecordNavigation` |

The engine's route is authoritative in both directions. The difference is who
moved first, and therefore who has to be told.

`back` and `forward` are a third case: they report `Dispatched`, not `Success`,
because they only *ask*. If there is nowhere to go back to, no `LocationChanged`
ever arrives — and that is a correct outcome, not a lost message.

---

## Trace 3 — Loading JSON over HTTP

Example: [`examples/03-fetch-data/`](../examples/03-fetch-data/README.md).

| # | What happens | Where |
| --- | --- | --- |
| 1 | User clicks **Load** | `examples/03-fetch-data/index.html` |
| 2 | `SemanticEvent { name: "load" }` | `makeEvent` |
| 3 | The engine mints a fresh correlation id | `createFetchTransport` |
| 4 | `transition` returns `Loading` and one `Http` effect | `transition`, `examples/03-fetch-data/engine.ts` |
| 5 | The kernel registers an `AbortController` under that correlation id | `#executeHttp` |
| 6 | A timeout is armed from `effect.timeoutMs` | `#executeHttp` |
| 7 | `fetch(url, { method, signal, headers, body })` | `#runHttp` |
| 8 | The response body is decoded as JSON — and no further | `#runHttp` |
| 9 | The outcome is classified | `#runHttp`, `#classifyAbort` |
| 10 | `HttpResult { correlationId, outcome }` returns to the engine | `#executeEffect` |
| 11 | A result whose id does not match the awaited one is **discarded** | `transition`, the `RecordLoad` case |
| 12 | `Loaded` / `LoadFailed` / `Idle` / `LoadOutcomeUnknown` | `transition` |
| 13 | `project` produces the list and the state flags | `project` |
| 14 | `data-each` reconciles rows by key | `#applyEach` |

**What step 9 will not do for you**

```text
Success{ status, body }                     a response arrived and decoded
Failure{ "invalid-response", status }       a response arrived and did not decode
Failure{ "network" }                        nothing arrived
Failure{ "aborted" }                        something else stopped it
Cancelled                                   the engine asked to stop
OutcomeUnknown{ "timeout-after-dispatch" }  the request may already have been received
```

The kernel never decides that a 404 means "missing" or that a 500 is
retryable — it reports `Success { status: 404 }` and lets the engine decide,
because only the engine knows what that URL meant.

`status` rides along on `invalid-response` for one specific reason: a 500
returning an HTML error page is retryable, and a 200 returning malformed JSON
is not. Without the status they are indistinguishable.

And `OutcomeUnknown` is not a nicer word for failure. The request may have
reached the server. For the GET in this trace that is harmless; for the POST in
[04-save-data](../examples/04-save-data/README.md) it is the difference between
one record and two.

---

## Reading these traces as a map

| If your change is about… | It belongs at step… | So it goes in… |
| --- | --- | --- |
| which control exists | trace 1, step 1 | your HTML |
| what an event name means | trace 1, step 6 | `eventToCommand` |
| whether an action is legal | trace 1, step 7 | `transition` |
| what the user sees | trace 1, step 15 | `project` |
| how a browser API is called | trace 1, step 10 | the kernel — and only if no capability covers it |
| what a URL means | trace 2, step 6 | `parseRoute`, yours |
| how a URL is pushed | trace 2, step 5 | the kernel — already done |
| how a failure is classified | trace 3, step 9 | the kernel — a closed set |
| what a failure *means* | trace 3, step 12 | `transition` |

## Related

- [mental-model.md](mental-model.md) — the ownership rules these traces demonstrate
- [where-code-goes.md](where-code-goes.md) — the same map, as a decision tree
- [03-kernel-lifecycle.md](03-kernel-lifecycle.md) — startup, before any of this
