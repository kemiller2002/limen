# Anti-patterns

**What this answers:** what not to do, what it looks like, why it is harmful,
and what to do instead.

Every entry has a wrong version and a right version. The wrong versions are
things that look reasonable — that is why they are worth writing down.

---

## 1. Moving application state into JavaScript

**The single most damaging mistake available here.**

### Wrong

```ts
// page.js — a "small convenience"
let currentCustomer = null;
let isEditing = false;

button.addEventListener("click", () => {
  isEditing = true;
  form.classList.add("editing");
  saveButton.disabled = currentCustomer === null;
});
```

### Why it's harmful

There are now two owners. The engine believes one thing, `page.js` believes
another, and nothing reconciles them. The first symptom is usually a button
enabled when it shouldn't be, and the cause is invisible because it's in a
different file from the state machine.

It also makes the logic untestable without a browser and unportable to WASM.

### Right

```ts
// engine.ts
case "StartEditing":
  if (state.kind !== "Viewing") return still(state);
  return still({ kind: "Editing", customer: state.customer, draft: state.customer });

// project
editing:     state.kind === "Editing",
saveDisabled: state.kind !== "Editing" || !isDraftValid(state.draft),
```

```html
<button data-event="startEditing">Edit</button>
<button data-event="save" data-bind-disabled="saveDisabled">Save</button>
```

**Rule:** [12-design-rules.md](12-design-rules.md) 1.1, 1.2.

---

## 2. Building a second framework inside the bridge

### Wrong

```ts
// kernel-helpers.ts — this is how it starts
export function registerComponent(name: string, render: (state: unknown) => string) { … }
export function useKernelState<T>(selector: (view: ViewState) => T): T { … }
export function createStore(initial: State) { … }
```

### Why it's harmful

Each helper is individually defensible. Together they become a framework, and
frameworks attract logic. Within a few months the "thin bridge" holds
application decisions, and the boundary exists only on paper.

The kernel's six-attribute vocabulary is deliberately too small to build on.
That is the feature.

### Right

Write the eight lines. If they feel repetitive across features, that repetition
is what keeps each feature independently readable.

```ts
export function createTransport(): EngineTransport {
  let state = initialState;
  return {
    async start() {},
    async dispatch(message) {
      if (message.kind === "Event") state = transition(state, eventToCommand(message.event));
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}
```

**Rule:** 3.1, 3.2.

---

## 3. Duplicating state across layers

### Wrong

```ts
// Engine has it…
state.draft.email

// …page JS caches it…
let cachedEmail = "";

// …and the DOM holds a third copy the code reads back.
const email = document.querySelector("#email").value;
if (email !== cachedEmail) { … }
```

### Why it's harmful

Three copies, three chances to disagree, and no answer to "which is right?" The
bug appears when one path updates two of them.

### Right

One copy, in the engine. The DOM is written to via `data-bind-value` and read
from only as event transport.

```ts
// state
draft: { email: string }
// projection
email: state.draft.email
```

```html
<input data-event="emailChanged" data-on="input" data-bind-value="email">
```

**Rule:** 1.1, 1.4.

---

## 4. Hiding external effects

### Wrong

```ts
// Inside a transition
async function transition(state: State, command: Command) {
  if (command.kind === "Save") {
    const response = await fetch("/api/save", { … });   // ← no
    return { kind: "Saved" };
  }
}
```

### Why it's harmful

Four things break at once: the transition is no longer pure or testable without
a network; the external call is invisible at the boundary; the engine gains a
browser dependency and can't be ported; and nothing forces you to handle
failure, so `OutcomeUnknown` never gets considered.

It also fails the build — `fetch(` in `src/engine/**` is a **Script**-enforced
violation.

### Right

```ts
case "Save":
  return {
    state: { kind: "Saving", text: state.text, correlationId },
    effects: [{ kind: "Http", correlationId, method: "POST", url: "/api/save",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ text: state.text }), timeoutMs: 5000 }],
  };
```

**Rule:** 2.1, 4.1.

---

## 5. Re-implementing React in the engine

### Wrong

```ts
project(state) {
  return {
    html: `<ul>${state.items.map((i) => `<li>${i.label}</li>`).join("")}</ul>`,
  };
}
```

### Why it's harmful

It is markup generation smuggled through a string, and the markup now lives in
application logic — where designers cannot reach it and where `innerHTML` would
be needed to apply it. That is an XSS vector, and `SetInnerHtml` is
**Script**-banned.

It also throws away what `data-each` gives you: keyed reconciliation that
preserves focus, caret, and animation across reorders.

### Right

```ts
items: state.items.map((item) => ({ id: item.id, label: item.label })),
```

```html
<ul>
  <template data-each="items" data-key="id">
    <li data-text="label"></li>
  </template>
</ul>
```

**Rule:** 2.3, 5.7.

---

## 6. Re-deriving capabilities in the DOM or CSS

### Wrong

```js
saveButton.disabled = textarea.value.trim() === "";
```

```css
.entry[data-status="Processed"] .process-button { display: none; }
```

### Why it's harmful

"You may save when the text is non-empty" is a business rule. Now it exists in
two places — the engine and the markup — and they will drift. The CSS version is
worse: the button is invisible but still clickable by keyboard.

### Right

```ts
saveDisabled:    state.text.trim() === "",
processDisabled: entry.status !== "Saved" || state.kind !== "Ready",
```

```html
<button data-event="save" data-bind-disabled="saveDisabled">Save</button>
<button data-event="markProcessed" data-bind-disabled="processDisabled">Mark processed</button>
```

CSS may still *style* the disabled state — `button:disabled { opacity: .45 }` —
because that is appearance, not a rule.

**Rule:** 5.5.

---

## 7. Bypassing the kernel "just for this one thing"

### Wrong

```js
document.querySelector("#panel").classList.toggle("open");
document.querySelector("#count").textContent = String(n + 1);
```

### Why it's harmful

The engine does not know this happened, so its next projection overwrites it —
producing a UI that flickers back, apparently at random. And if the value
matters to a later decision, the engine will decide using the wrong number.

The danger is specifically that it *works* in isolation. It breaks the moment
any other event triggers a projection, which is long after the change was
reviewed.

### Right

Everything that changes what the user sees goes through a round trip. If a
toggle is purely presentational and has no bearing on behavior — a CSS `:hover`,
a `<details>` element — leave it to the browser and don't route it anywhere.

**Rule:** 1.3, 1.4.

---

## 8. Booleans instead of a union

### Wrong

```ts
type State = { isLoading: boolean; isSaving: boolean; hasError: boolean; data: X | null };
```

### Why it's harmful

Covered in full in [04-state-model.md](04-state-model.md). Short version:
impossible combinations are representable, so every reader must handle them,
and adding a state breaks nothing that should break.

### Right

```ts
type State =
  | { kind: "Idle" }
  | { kind: "Loading"; correlationId: CorrelationId }
  | { kind: "Loaded";  data: X }
  | { kind: "Failed";  reason: string; retryable: boolean };
```

**Rule:** 1.5, 1.6.

---

## 9. Treating `OutcomeUnknown` as a failure

### Wrong

```ts
case "Failure":
case "OutcomeUnknown":              // ← collapsing them
  return { state: { kind: "SaveFailed" }, effects: [retrySameEffect()] };
```

### Why it's harmful

This is how duplicate orders, duplicate charges, and duplicate records get
created. `OutcomeUnknown` means the request was dispatched and may have been
processed. Retrying a POST on that basis does the work twice.

### Right

```ts
case "Failure":
  return { state: { kind: "SaveFailed", retryable: outcome.reason === "network" }, effects: [] };
case "OutcomeUnknown":
  return { state: { kind: "SaveOutcomeUnknown", text: state.text }, effects: [] };
```

```ts
// and in the projection — deliberately no retry
needsReconciliation: state.kind === "SaveOutcomeUnknown",
canRetry:            state.kind === "SaveFailed" && state.retryable,
```

A GET is different: it is idempotent, so retrying is safe. Only the engine can
tell the difference, which is why the kernel reports rather than decides.
Compare [03-fetch-data](../examples/03-fetch-data/) with
[04-save-data](../examples/04-save-data/).

**Rule:** 4.3, 4.4.

---

## 10. Forgetting the stale-result guard

### Wrong

```ts
case "RecordLoad":
  return { state: { kind: "Loaded", customers: decode(outcome.body) }, effects: [] };
```

### Why it's harmful

Two clicks produce two in-flight requests. If the first resolves last, its older
data overwrites the newer data, silently, with no error anywhere. Intermittent
and very hard to reproduce.

### Right

```ts
case "RecordLoad": {
  if (state.kind !== "Loading" || state.correlationId !== command.correlationId) {
    return { state, effects: [] };   // stale — discard
  }
  …
}
```

**Rule:** 4.5. Test it: 8.2.

---

## 11. Partial projections

### Wrong

```ts
project(state) {
  if (state.kind === "Loading") return { statusText: "Loading…" };   // ← where's submitDisabled?
  return { statusText: "Ready", submitDisabled: false };
}
```

### Why it's harmful

A mounted `data-bind-disabled="submitDisabled"` binding throws
`View value for "submitDisabled" is missing or not scalar`. The error boundary
reports it and **aborts the rest of the round trip, including its effects** —
so the page looks frozen and the network call never happens.

### Right

Project every key in every branch.

```ts
project(state) {
  return {
    statusText:     statusTextFor(state),
    submitDisabled: state.kind === "Loading",
  };
}
```

Keys bound only inside a `data-if` template are exempt while that template is
unmounted — see [08-multi-screen-applications.md](08-multi-screen-applications.md).

**Rule:** 5.1.

---

## 12. Index keys in `data-each`

### Wrong

```ts
items: state.items.map((item, index) => ({ id: String(index), label: item.label })),
```

### Why it's harmful

Insert at the front and every item's key changes. Keyed reconciliation reuses
the node for key `"0"` — which is now a different item — so focus, caret, and
uncommitted input land on the wrong row. Removal is worse.

### Right

Use a stable domain identifier.

```ts
items: state.items.map((item) => ({ id: item.id, label: item.label })),
```

**Rule:** 5.3.

---

## 13. Logging whole effect objects

### Wrong

```ts
report(event) { console.log(JSON.stringify(event, null, 2)); }
// and, worse:
console.log("effect", effectRequest);   // headers include Authorization
```

### Why it's harmful

Request headers routinely carry credentials. The kernel goes out of its way to
keep them out of diagnostics, and a test enforces it. A sink that logs raw
objects reintroduces exactly what the kernel prevented.

### Right

```ts
report(event) {
  if (event.kind === "BridgeError") console.error(`[bridge:${event.phase}]`, event.detail);
  else console.debug(`[effect] ${event.correlationId} ${event.durationMs.toFixed(1)}ms`);
}
```

**Rule:** 3.5, 4.8.

---

## 14. Using `DirectTypeScriptTransport` for your application

### Wrong

```ts
import { BrowserKernel, DirectTypeScriptTransport } from "@echelon-foundry/typescript-wasm-kernel";
await new BrowserKernel(new DirectTypeScriptTransport(), document).start();
// then wondering why data-event="save" throws "Unrecognized event"
```

### Why it's harmful

It is hard-wired to this repository's demo domain and understands exactly two
event names — `emailChanged` and `checkAvailability`. It also throws on any
`StorageResult`. It is a reference, not a base class.

This one is genuinely the documentation's fault: it appeared in the old README
quickstart with no warning. Recorded as finding **A-1** in
[DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md).

### Right

Write your own transport. It is about eight lines —
[02-getting-started.md](02-getting-started.md).

---

## 15. Calling `start()` more than once

### Wrong

```ts
await kernel.start();
// later, to "refresh the UI"
await kernel.start();
```

### Why it's harmful

It re-binds the entire document and double-registers every listener. Every
subsequent click dispatches twice, so counters jump by two and effects fire in
pairs.

### Right

Trigger a projection through a real event round trip. In tests, see the `tick()`
helper in [`test/kernel.test.ts`](../test/kernel.test.ts).

---

## Quick reference

| Anti-pattern | Rule | Detected by |
| --- | --- | --- |
| State in JavaScript | 1.1, 1.2 | review |
| Framework in the bridge | 3.1, 3.2 | review |
| Duplicated state | 1.1, 1.4 | review |
| Hidden effects | 2.1, 4.1 | **script** |
| HTML from the engine | 2.3, 5.7 | **script** (`SetInnerHtml`) |
| Capabilities in DOM/CSS | 5.5 | review |
| Bypassing the kernel | 1.3, 1.4 | review |
| Boolean soup | 1.5 | review |
| `OutcomeUnknown` as failure | 4.3, 4.4 | review |
| Missing stale guard | 4.5 | review / test |
| Partial projection | 5.1 | **runtime** |
| Index keys | 5.3 | review |
| Logging credentials | 3.5 | review |
| Reference transport in production | — | runtime throw |
| Double `start()` | — | review |

---

## Related

- [12-design-rules.md](12-design-rules.md) — the rules themselves
- [01-architecture.md](01-architecture.md) — the reasoning behind them
- [16-troubleshooting.md](16-troubleshooting.md) — symptoms these produce
