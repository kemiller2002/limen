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

⚠️ **URL and history are not supported.** See
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

Worked example — clipboard:

**1. Extend the protocol** ([`src/protocol.ts`](../src/protocol.ts)):

```ts
export type ClipboardEffectRequest = {
  readonly kind: "Clipboard";
  readonly correlationId: CorrelationId;
  readonly operation: "write";
  readonly text: string;
};

export type ClipboardOutcome =
  | { readonly kind: "Success" }
  | { readonly kind: "Failure"; readonly reason: "denied" | "unavailable" };

export type EffectRequest = HttpEffectRequest | StorageEffectRequest | ClipboardEffectRequest;

export type EffectResult =
  | /* … existing … */
  | { readonly kind: "ClipboardResult"; readonly correlationId: CorrelationId; readonly outcome: ClipboardOutcome };
```

**2. Announce it** — add `"Clipboard"` to the `Initialize` capabilities tuple.

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

**4. Route it** in `#executeEffect`.

**5. Test it** in `test/kernel.test.ts`, including the failure classification.

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
