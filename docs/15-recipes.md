# Recipes

**What this answers:** how to accomplish one specific task, with the complete
change listed layer by layer.

Each recipe names every file that changes. "Kernel: none" appears often — that
is the expected answer, and it means the existing primitives already cover it.

---

## Add a button

**Layers:** HTML + engine. **Kernel:** none.

```html
<button data-event="archiveRecord">Archive</button>
```

```ts
// 1. Command
export type Command = /* … */ | { readonly kind: "ArchiveRecord" };

// 2. Map the event name
case "archiveRecord": return { kind: "ArchiveRecord" };

// 3. Transition — reject when illegal
case "ArchiveRecord": {
  if (state.kind !== "Viewing") return still(state);
  return still({ kind: "Archived", record: state.record });
}

// 4. Project the capability
archiveDisabled: state.kind !== "Viewing",
```

```html
<button data-event="archiveRecord" data-bind-disabled="archiveDisabled">Archive</button>
```

Step 4 is not optional — see [13-anti-patterns.md](13-anti-patterns.md#6-re-deriving-capabilities-in-the-dom-or-css).

---

## Add a text field

**Layers:** HTML + engine. **Kernel:** none.

```html
<label for="note">Note</label>
<input id="note" name="note" type="text"
       data-event="noteChanged" data-on="input"
       data-bind-value="note" data-bind-disabled="fieldsDisabled">
```

```ts
case "noteChanged": return { kind: "EditNote", value: event.value ?? "" };

case "EditNote":
  if (state.kind !== "Editing") return still(state);
  return still({ ...state, draft: { ...state.draft, note: command.value } });

// projection
note:           state.draft.note,
fieldsDisabled: state.kind !== "Editing",
```

`data-on="input"` fires per keystroke; the default for `<input>` is `change`,
which fires on blur. Omit it and your validation appears only after clicking
away.

`event.value` is always a **string**. Convert and validate in the engine.

---

## Call an API

**Layers:** engine. **Kernel:** none.

```ts
// 1. States that can hold an in-flight request
export type State =
  | { kind: "Idle" }
  | { kind: "Loading"; correlationId: CorrelationId }
  | { kind: "Loaded";  data: readonly Item[] }
  | { kind: "Failed";  reason: string; retryable: boolean };

// 2. Request the effect
case "Load":
  if (state.kind === "Loading") return still(state);          // no double-flight
  return {
    state: { kind: "Loading", correlationId: command.correlationId },
    effects: [{ kind: "Http", correlationId: command.correlationId,
                method: "GET", url: "/api/items", timeoutMs: 5000 }],
  };

// 3. Record the result
case "RecordLoad": {
  if (state.kind !== "Loading" || state.correlationId !== command.correlationId) {
    return still(state);                                       // stale — discard
  }
  switch (command.outcome.kind) {
    case "Success": {
      if (command.outcome.status !== 200) return still(failed(`Server returned ${command.outcome.status}.`, true));
      const items = decodeItems(command.outcome.body);          // body is `unknown`
      return still(items === null ? failed("Unexpected response shape.", false) : { kind: "Loaded", data: items });
    }
    case "Failure":
      return still(failed(command.outcome.reason === "network" ? "Could not reach the server." : "The response could not be read.",
                          command.outcome.reason === "network"));
    case "Cancelled":      return still({ kind: "Idle" });
    case "OutcomeUnknown": return still(failed("The request timed out. Try again.", true));   // GET: safe
  }
}
```

For a **POST/PATCH/DELETE**, `OutcomeUnknown` is *not* safely retryable — see
the save recipe below.

Full version: [`examples/03-fetch-data/`](../examples/03-fetch-data/).

### Sending a body

```ts
{
  kind: "Http", correlationId, method: "POST", url: "/api/notes",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text }),      // YOU serialize; the kernel doesn't look
  timeoutMs: 5000,
}
```

---

## Add a loading state

**Layers:** engine + HTML. **Kernel:** none.

Do **not** add `isLoading: boolean` to state. Make it a state:

```ts
// projection
busy:         state.kind === "Loading",
loadDisabled: state.kind === "Loading",
statusText:   state.kind === "Loading" ? "Loading…" : "",
```

```html
<button data-event="load" data-bind-disabled="loadDisabled">Load</button>
<p role="status" aria-live="polite" data-text="statusText"></p>
<div data-bind-aria-busy="busy">…</div>
```

The view updates **before** effects run, so "Loading…" appears immediately
rather than after the network settles.

---

## Display an error

**Layers:** engine + HTML + CSS.

```ts
// Errors are states, not exceptions.
| { kind: "Failed"; reason: string; retryable: boolean }

// projection
errorMessage: state.kind === "Failed" ? state.reason : "",
errorVisible: state.kind === "Failed",
canRetry:     state.kind === "Failed" && state.retryable,
```

```html
<template data-if="errorVisible">
  <div class="panel">
    <p class="error" role="alert" data-text="errorMessage"></p>
    <template data-if="canRetry">
      <button data-event="retry">Try again</button>
    </template>
  </div>
</template>
```

Note `canRetry` is separate from `errorVisible`: some failures cannot be fixed
by retrying (`invalid-response` will fail identically every time).

---

## Save data with a full lifecycle

**Layers:** engine. **Kernel:** none.

```text
Editing → Saving → Saved
             ├──→ SaveFailed          (retryable)
             └──→ SaveOutcomeUnknown  (NOT retryable — reconcile)
```

```ts
case "Success":
  return command.outcome.status >= 200 && command.outcome.status < 300
    ? { state: { kind: "Saved", text: state.text }, effects: [clearDraft()] }
    : { state: { kind: "SaveFailed", text: state.text, reason: `Server returned ${command.outcome.status}.`, retryable: false }, effects: [] };

case "OutcomeUnknown":
  // The POST may already have been processed. Do not repeat it.
  return { state: { kind: "SaveOutcomeUnknown", text: state.text }, effects: [] };
```

```ts
canRetry:            state.kind === "SaveFailed" && state.retryable,
needsReconciliation: state.kind === "SaveOutcomeUnknown",   // no retry button
```

Full version: [`examples/04-save-data/`](../examples/04-save-data/).

---

## Add a modal

**Layers:** engine + HTML + CSS. **Kernel:** none.

Prefer a native `<dialog>` — `open` is one of the five boolean properties the
kernel sets directly, so the browser handles the rest.

```html
<dialog data-bind-open="confirmOpen">
  <p data-text="confirmMessage"></p>
  <button data-event="confirmDelete" data-bind-disabled="confirmDisabled">Delete</button>
  <button data-event="cancelDelete">Cancel</button>
</dialog>
```

```ts
confirmOpen:     state.kind === "ConfirmingDelete",
confirmMessage:  state.kind === "ConfirmingDelete" ? `Delete ${state.target}?` : "",
confirmDisabled: state.kind !== "ConfirmingDelete",
```

| Concern | Belongs to |
| --- | --- |
| Whether it's open | engine state |
| Whether Confirm is enabled | engine — project it |
| Backdrop, centering, animation | CSS |
| Escape to dismiss, focus trap | native `<dialog>` |
| Focus restoration on close | **not supported** — known gap |

---

## Add a screen

**Layers:** engine + HTML.

```ts
// 1. Extend the union
export const SCREENS = ["home", "customers", "settings", "reports"] as const;

// 2. Decide explicitly what leaving discards
case "Navigate":
  return { ...state, screen: command.screen, customerFilter: "", reportRange: "month" };

// 3. Project it
onReports: state.screen === "reports",
```

```html
<template data-if="onReports">
  <section class="panel"><h2>Reports</h2>…</section>
</template>
```

With a `data-each` nav, the nav markup does not change at all.

Full version: [`examples/05-multi-screen/`](../examples/05-multi-screen/).

---

## Navigate between screens

**Layers:** engine + HTML. **Kernel:** none.

```html
<nav class="nav">
  <template data-each="navItems" data-key="id">
    <button data-event="navigate" data-text="label" data-bind-aria-current="active"></button>
  </template>
</nav>
```

```ts
case "navigate": {
  const target = event.key ?? "";
  if (!isScreen(target)) throw new Error(`Unknown screen: ${target}`);   // validate it
  return { kind: "Navigate", screen: target };
}
```

This is the **no-URL** case — screens that are not meant to be bookmarked. When
a screen should be linkable, shareable, or survive a reload, use the
`Navigation` capability instead: [routing.md](routing.md), and the
"Handle the browser's Back and Forward buttons" recipe below. See
[08-multi-screen-applications.md](08-multi-screen-applications.md).

---

## Store something locally

**Layers:** engine. **Kernel:** none.

```ts
// Read at startup
case "Initialize":
  return { view: project(state),
           effects: [{ kind: "Storage", correlationId: PREF_GET, operation: "get", key: "theme" }],
           cancellations: [] };

// Write on change
case "SetTheme":
  return { state: { ...state, theme: command.value },
           effects: [{ kind: "Storage", correlationId: PREF_SET, operation: "set", key: "theme", value: command.value }] };
```

Handle both non-success shapes — absent and unavailable:

```ts
const theme = outcome.kind === "Success" ? outcome.value ?? "light" : "light";
```

`Success { value: null }` means the key was absent, which is normal.
`Failure { unavailable }` means storage is disabled — private browsing, blocked
cookies. Neither should break the feature.

Never put secrets in `localStorage`.

---

## Cancel an in-flight request

**Layers:** engine. **Kernel:** none.

```ts
return { view: project(next), effects: [], cancellations: [state.correlationId] };
```

The result still arrives, as `{ kind: "Cancelled" }`, through the ordinary
path — handle it as evidence. Naming a completed ID is a harmless no-op.

---

## Add a new browser capability

**Layers:** protocol + kernel + engine. **This is the only recipe that changes
the kernel.**

Read [12-design-rules.md](12-design-rules.md) 7.4 first: do not build a
capability before a real feature needs it.

The worked example below is **Clipboard, and it is now real** — these are the
steps that were actually taken to add it. Read the finished version alongside
it: [`src/protocol.ts`](../src/protocol.ts) for the types,
[`src/kernel/browser-kernel.ts`](../src/kernel/browser-kernel.ts) for
`writeClipboardText`, and [clipboard.md](clipboard.md) for the guide it
produced. `Navigation` was added the same way, with one extra step: it also
introduced a browser-originated message (`LocationChanged`), which is what you
need when the browser can act without being asked.

**1. Extend the protocol** ([`src/protocol.ts`](../src/protocol.ts)):

```ts
export type ClipboardEffectRequest = {
  readonly kind: "Clipboard";
  readonly correlationId: CorrelationId;
  readonly operation: "writeText";
  readonly text: string;
};

// Three reasons, not two. They are split because an engine answers them
// differently: "denied" is usually a stale user gesture and a retry works,
// "unavailable" means no Clipboard API exists here and a retry never will.
// Deciding that split is the hardest part of adding a capability, and the part
// you cannot revise later without a breaking change.
export type ClipboardOutcome =
  | { readonly kind: "Success" }
  | { readonly kind: "Failure"; readonly reason: "denied" | "unavailable" | "unknown" };

export type EffectRequest = HttpEffectRequest | StorageEffectRequest | ClipboardEffectRequest;

export type EffectResult =
  | /* … existing … */
  | { readonly kind: "ClipboardResult"; readonly correlationId: CorrelationId; readonly outcome: ClipboardOutcome };
```

**2. Announce it** — add `"Clipboard"` to the `Capability` union, which is what
`Initialize` carries. Announce it **unconditionally**: the list says what the
kernel implements, not what this browser will permit. Availability belongs in
the outcome.

**3. Execute it** ([`browser-kernel.ts`](../src/kernel/browser-kernel.ts)):

```ts
async #executeClipboard(effect: ClipboardEffectRequest): Promise<EffectResult> {
  try {
    await navigator.clipboard.writeText(effect.text);
    return { kind: "ClipboardResult", correlationId: effect.correlationId, outcome: { kind: "Success" } };
  } catch (error) {
    return { kind: "ClipboardResult", correlationId: effect.correlationId,
             outcome: { kind: "Failure", reason: isPermissionDenied(error) ? "denied" : "unavailable" } };
  }
}
```

**4. Route it** in `#runEffect`'s `switch`. The switch ends in
`assertNeverEffect`, so a variant you add to `EffectRequest` without a branch
is a **compile error** rather than an effect that silently vanishes.

**5. Test it** in `test/kernel.test.ts`, including every failure
classification. Provoke each one for real — a reason you cannot produce in a
test is a reason you do not understand.

**6. Document it** — [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md),
[11-api-reference.md](11-api-reference.md), and [ROADMAP.md](ROADMAP.md).

### The rules this must obey

- ✅ Generic — `"Clipboard"`, not `"CopyInvoiceNumber"`.
- ✅ Classifies outcomes only — never decides what a failure *means*.
- ✅ Every failure mode is a union member, including permission denial.
- ✅ Include `OutcomeUnknown` **only if** "dispatched but uncertain" is genuinely
  possible. It is for Http; it is not for Storage or a clipboard write.
- ❌ No domain vocabulary anywhere in the kernel.
- ❌ No orchestration, retries, or sequencing.

---

## Copy text to the clipboard

**Layers:** engine. **Kernel:** none — the capability exists.

```ts
// 1. A state for the wait. It is real: the write is async and can be refused.
type State =
  | { kind: "Idle" }
  | { kind: "Copying"; correlationId: CorrelationId }
  | { kind: "Copied" }
  | { kind: "CopyFailed"; reason: "denied" | "unavailable" | "unknown" };

// 2. Ask.
case "Copy":
  if (state.kind === "Copying") return stay(state);   // refuse a racing second click
  return go({ kind: "Copying", correlationId }, [
    { kind: "Clipboard", correlationId, operation: "writeText", text: command.text },
  ]);

// 3. Record. Check the correlation id first.
case "RecordCopy":
  if (state.kind !== "Copying" || state.correlationId !== command.correlationId) return stay(state);
  return command.outcome.kind === "Success"
    ? go({ kind: "Copied" })
    : go({ kind: "CopyFailed", reason: command.outcome.reason });
```

Copy from **state**, never by reading the text back out of the DOM, and keep
the round trip inside the click: a copy that waits on a fetch first has usually
lost the user gesture and will come back `denied`.

Only `denied` is worth offering a retry for. Full detail:
[clipboard.md](clipboard.md). Running example:
[examples/07-clipboard](../examples/07-clipboard/README.md).

---

## Handle the browser's Back and Forward buttons

**Layers:** engine. **Kernel:** none — the capability exists.

Two directions, two commands, and they are **not** symmetrical:

```ts
// The application decided to move: change the route AND ask the browser.
case "Navigate":
  if (sameRoute(state.route, command.route)) return stay(state);   // no duplicate entries
  return go({ ...state, route: command.route }, [
    { kind: "Navigation", correlationId, operation: "push", url: routeToUrl(state.base, command.route) },
  ]);

// The browser moved on its own: adopt, and ask for NOTHING.
case "AdoptLocation":
  return go({ ...state, route: parseRoute(command.location) });
```

```ts
case "LocationChanged":
  return respond(transition(state, { kind: "AdoptLocation", location: message.location }));
```

Requesting a navigation here is the classic trap — Back fires `popstate`, you
push the old URL back on, and the user cannot leave. Assert it in a test:

```ts
assert.equal(routeTransition(state, adoptCommand).effects.length, 0);
```

Take the first screen from `Initialize.location` so a deep link does not render
the default screen first. Full detail: [routing.md](routing.md). Running
example: [examples/08-routing](../examples/08-routing/README.md).

---

## Add a checkbox or a radio button

**Layers:** HTML + engine. **Kernel:** none.

A checkbox needs a different shape from a text field, and the reason is a real
limitation: `SemanticEvent.value` comes from the element's `.value`, **not its
`.checked`**. A checkbox's `.value` is `"on"` whether it is ticked or not, so an
event carrying it tells the engine nothing.

Model the event as *"the user toggled this"* rather than *"here is the new
value"*:

```html
<!-- No data-bind-value: the checkbox's value never changes, its checked does. -->
<input type="checkbox" id="notify"
       data-event="toggleNotify"
       data-bind-checked="notifyEnabled">
<label for="notify">Email me about changes</label>
```

```ts
// The engine flips its own state. It does not read the checkbox.
case "ToggleNotify":
  return go({ ...state, notifyEnabled: !state.notifyEnabled });

// Projected back, so the DOM reflects the engine rather than the click.
const project = (state: State): ViewState => ({ notifyEnabled: state.notifyEnabled });
```

`checked` is one of the attributes the kernel reflects as a DOM **property**, so
`data-bind-checked` works as you would expect.

**Radio buttons are the easy case**, because a radio's `.value` *is*
meaningful — so the ordinary text-field shape works unchanged:

```html
<input type="radio" name="freq" value="daily"  data-event="selectFrequency" data-bind-checked="isDaily">
<input type="radio" name="freq" value="weekly" data-event="selectFrequency" data-bind-checked="isWeekly">
```

Each selection dispatches `{ name: "selectFrequency", value: "daily" }`. One
event name, one transition, and the engine projects one `is…` flag per option.

**Common mistake:** binding `data-bind-value` to a checkbox and wondering why
nothing toggles. The state you want is `checked`.

---

## Validate a form

**Layers:** engine. **Kernel:** none.

```ts
// 1. Rules are pure functions, and they live in exactly one place.
const isEmailValid = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

// 2. An empty field is incomplete, not wrong. Do not scold someone who has not
//    typed yet.
const emailMessage = (value: string): string =>
  value === "" || isEmailValid(value) ? "" : "Enter a valid email address.";

// 3. Project both the message and the capability.
const project = (state: State): ViewState => ({
  emailMessage: emailMessage(state.draft.email),
  showEmailMessage: emailMessage(state.draft.email) !== "",
  submitDisabled: !isDraftValid(state.draft),
});

// 4. And ALSO refuse the illegal transition. The disabled button is a
//    projection of the rule, not the rule.
case "Submit":
  return isDraftValid(state.draft) ? go({ kind: "Submitted", draft: state.draft }) : stay(state);
```

Native `required`/`pattern` attributes are a convenience for the user — the
kernel calls `reportValidity()` before dispatching a submit — but they are not
where the rule lives. Running example:
[examples/02-form](../examples/02-form/README.md).

---

## Debug an event that goes nowhere

**Layers:** diagnostics.

A button does nothing. Work down this list; each step eliminates one layer.

1. **Is the kernel bound?** Install a `DiagnosticsSink`
   ([16-troubleshooting.md](16-troubleshooting.md)). Two different phases mean
   `start()` bailed out and **nothing** on the page is wired, and they have
   different causes: `phase: "binding"` is malformed markup (a `data-each`
   without `data-key`, a `data-if` on a non-`<template>`, a template with more
   than one root element); `phase: "dispatch"` at startup is the transport's own
   `start()` having rejected. Read the `detail` — it names which.
2. **Is the attribute spelled right?** `data-event`, not `data-events`. An
   unrecognised `data-*` attribute is silently ignored — it is just an
   attribute.
3. **Is the trigger what you think?** `<input>` defaults to `change`, not
   `input`. Add `data-on="input"` if you want every keystroke.
4. **Does the event reach the transport?** Wrap it and log both directions:

   ```ts
   const logged: EngineTransport = {
     start: () => inner.start(),
     dispatch: async (message) => {
       console.log("→", message);
       const response = await inner.dispatch(message);
       console.log("←", response);
       return response;
     },
   };
   ```

5. **Does the engine recognise the name?** An unmapped name should throw
   `Unrecognized event: …`, which surfaces as `BridgeError { phase: "dispatch" }`
   rather than a crash. Silence here means your `eventToCommand` has a
   `default` that swallows it.
6. **Did the transition accept it?** Log `accepted`. A refused illegal
   transition looks exactly like nothing happening — and is often correct.
7. **Did the projection change?** If the response's `view` is identical, the
   DOM correctly does nothing.
8. **Is the element inside a `data-each`?** Bindings there resolve against the
   **item**, not the top-level view. A missing key fails the whole projection
   with `BridgeError { phase: "projection" }`.

---

## Add a new binding primitive

**Layers:** kernel. **Rare — requires review.**

A seventh `data-*` attribute must be entirely domain-agnostic: it may describe
*where a value goes*, never *what it means*. `data-bind-style-<prop>` would be
acceptable in principle; `data-format-currency` would not — formatting is a
domain decision and belongs in the projection.

Before doing this, check that `data-text`, `data-bind-*`, `data-if`, and
`data-each` genuinely cannot express the need. They usually can.

---

## Related

- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — effects in depth
- [11-api-reference.md](11-api-reference.md) — exact signatures
- [13-anti-patterns.md](13-anti-patterns.md) — how these go wrong
- [16-troubleshooting.md](16-troubleshooting.md) — when a recipe doesn't work
