# Clipboard

**What this answers:** how an application copies text, why that is a capability
rather than a one-line helper, and what to do when it fails.

Working example: the install command's Copy button on the
[Limen site's home page](../site/pages/index.html), driven by
[`site/app/engine.ts`](../site/app/engine.ts).

---

## Why this is not `navigator.clipboard.writeText(value)`

Because that line is wrong in three ways at once, and all three are invisible
until a user hits them:

```js
// Don't.
navigator.clipboard.writeText(value);
element.innerText = "Copied!";
```

1. **It says "Copied!" whether or not anything was copied.** `writeText`
   returns a promise that genuinely rejects — a denied permission, an insecure
   page, a browser without the API. Nothing here waits for it, so the user is
   told a thing that may not be true.
2. **The application's state now lives in the DOM.** "Have we copied?" is
   answered by reading `innerText`. Nothing else can ask.
3. **The engine can no longer be tested without a browser**, because the
   decision to copy and the act of copying are the same statement.

Through the capability, all three go away: the engine decides *what* to copy
and *what it means* to have copied; the kernel performs the write and reports
what actually happened.

---

## The round trip

```text
user clicks Copy
    ↓  SemanticEvent { name: "copyInstall" }
engine: state → Copying, requests an effect
    ↓  { kind: "Clipboard", operation: "writeText", text: … }
kernel: navigator.clipboard.writeText(…)
    ↓  ClipboardOutcome
engine: state → Copied, or CopyFailed with a reason
    ↓  ViewState
the button's label, and the message the user reads
```

The kernel never writes user-facing text, and the engine never touches
`navigator`.

---

## Enable it

```ts
new BrowserKernel(transport, document, { clipboard: { enabled: true } });
```

Omit it and the kernel never touches the clipboard, does not announce the
`"Clipboard"` capability, and refuses any clipboard effect with
`Failure { reason: "unsupported" }` — so an engine is never silently obeyed by
a kernel that did not advertise it could.

`{ enabled: true }` looks redundant today. It is an object rather than a
boolean so the capability can gain options later without a breaking change,
and so that switching it on is a deliberate act rather than a `true` in
argument position.

## Request

```ts
{ kind: "Clipboard", correlationId, operation: "writeText", text: string }
```

`text` is opaque to the kernel: it is written, never read, never inspected,
never logged.

## Outcome

```ts
type ClipboardOutcome =
  | { kind: "Success" }
  | { kind: "Failure"; reason: "permission-denied" | "not-secure-context" | "unsupported" | "failed" };
```

| Reason | What happened | What the application should say |
| --- | --- | --- |
| `permission-denied` | The user or the browser refused. | Offer manual selection. |
| `not-secure-context` | The Clipboard API needs HTTPS or localhost. | Offer manual selection; this one is fixable by deploying over HTTPS. |
| `unsupported` | No Clipboard API at all. | Offer manual selection. |
| `failed` | It existed, was allowed, and still did not finish. | Offer manual selection. |

These are **normalized browser conditions, never browser exception strings**.
An engine must be able to match on them exhaustively, and a message like
`"NotAllowedError: Write permission denied."` is not something an application
can branch on or a user can act on.

`not-secure-context` is told apart from `unsupported` deliberately: one is
fixed by a deployment change and the other cannot be fixed at all, and a
developer reading a diagnostic deserves to know which they have.

There is no `OutcomeUnknown`. Nothing is dispatched to a remote party that
might have acted on a request the kernel then lost track of — either the
browser wrote the text or it did not.

---

## The copy UX pattern

Model the states; do not infer them from the DOM.

```ts
export type CopyState =
  | { kind: "Idle" }
  | { kind: "Copying" }
  | { kind: "Copied" }
  | { kind: "CopyFailed"; reason: string };
```

```ts
case "CopyInstall": {
  // Copying twice at once is not a legal move.
  if (state.copy.kind === "Copying") return { state, effects: [] };
  return {
    state: { ...state, copy: { kind: "Copying" } },
    effects: [{ kind: "Clipboard", correlationId, operation: "writeText", text: INSTALL_COMMAND }],
  };
}

case "RecordCopy":
  return {
    state: {
      ...state,
      copy: command.outcome.kind === "Success"
        ? { kind: "Copied" }
        : { kind: "CopyFailed", reason: COPY_FAILURE[command.outcome.reason] },
    },
    effects: [],
  };
```

Project the button's label and availability rather than letting the markup
derive them:

```ts
copyLabel: state.copy.kind === "Copied" ? "Copied" : state.copy.kind === "Copying" ? "Copying…" : "Copy",
copyBusy: state.copy.kind === "Copying",
copyFailed: state.copy.kind === "CopyFailed",
copyError: state.copy.kind === "CopyFailed" ? state.copy.reason : "",
```

```html
<button data-event="copyInstall" data-bind-disabled="copyBusy" data-text="copyLabel"></button>
<p role="status" aria-live="polite">
  <template data-if="copyFailed"><span data-text="copyError"></span></template>
</p>
```

Announce the result in an `aria-live` region. A copy that silently succeeds is
invisible to a screen reader user, and a copy that silently fails is invisible
to everyone.

---

## Privacy: contents are never logged

**The kernel never puts clipboard text into a `DiagnosticEvent`**, and neither
should your sink. A copied value is commonly a token, a password, a customer
record, or a recovery code — exactly the class of data that must not end up in
a log aggregator because a button was instrumented.

The same rule already applies to Http headers and bodies
([07-effects-and-browser-interop.md](07-effects-and-browser-interop.md#secrets)).
`test/kernel.test.ts` asserts it for the clipboard: a known secret is copied
and the serialized diagnostics are checked for it.

If you need clipboard telemetry, record the operation, the outcome, the
duration, and at most the payload *length* — never the payload.

---

## Browser constraints, stated honestly

A clipboard write **is not guaranteed to succeed**, and no amount of correct
code changes that. It may require:

- a **secure context** (HTTPS, or `localhost` in development);
- a **permission**, which the user may refuse or have already refused;
- a **recent user gesture** — some browsers reject a write that is not
  causally connected to a click or keypress;
- **browser support**, which older and more restricted browsers lack;
- permission not to be blocked by **enterprise or embedding policy**
  (a cross-origin `<iframe>` without `clipboard-write` in its `allow`
  attribute will refuse).

### On the user-gesture requirement

The effect is dispatched inside the click's own call chain — the kernel
executes effects during the same round trip the event started — so an
ordinary "click Copy, copy happens" flow stays within the gesture.

**Do not build a flow that defers a clipboard write far from the gesture**: do
not queue a copy behind a network round trip, a timer, or a confirmation
dialog and expect it to work. If the text must be fetched first, fetch it
before offering the button, then copy from state.

This is a real constraint that has not been measured across every browser
here. What has been verified: the click → effect → `writeText` path succeeds in
Chromium 141 under an automated grant. Safari and Firefox behaviour under a
deferred gesture is **not** verified — treat the rule above as a design
constraint rather than a tested boundary.

### No `execCommand` fallback

There is deliberately no hidden-`<textarea>` / `document.execCommand("copy")`
fallback. It is deprecated, it is a layout hazard, and adding it would mean
carrying compatibility code no measured browser target needs.

If a support target ever requires one, it belongs **inside the kernel** — one
implementation, tested, documented, and marked as compatibility behaviour.
Application code must never learn which mechanism was used.

---

## Reading the clipboard

**Not implemented, deliberately.** `readText` exposes whatever the user last
copied from any application — a far more sensitive capability than writing,
and nothing here needs it. It is left out on the least-capability rule rather
than overlooked.

If a real requirement appears, the shape is:

```ts
type ClipboardEffectRequest =
  | { kind: "Clipboard"; correlationId; operation: "writeText"; text: string }
  | { kind: "Clipboard"; correlationId; operation: "readText" };

type ClipboardOutcome =
  | { kind: "Success" }
  | { kind: "TextRead"; text: string }
  | { kind: "Failure"; reason: … };
```

Adding it should be a decision with a named requirement behind it, and it must
carry the same "never logged" rule — more strictly, if anything, since the text
did not originate in the application.

---

## Testing

The kernel tests stub `navigator.clipboard` and assert the whole matrix:
success, `permission-denied`, `not-secure-context`, `unsupported`, `failed`,
the unwired-capability refusal, and that contents never reach diagnostics.

```ts
await withClipboard(async (text) => { written.push(text); }, () =>
  withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document, { clipboard: { enabled: true } }).start();
    assert.deepEqual(written, ["npm install …"]);
  }));
```

Test the **failure** paths at least as carefully as the success path. A copy
button that works on your machine and fails silently on an HTTP staging server
is the normal way this breaks.

---

## Related

- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — the effect model these follow
- [11-api-reference.md](11-api-reference.md) — the types
- [25-browser-capabilities.md](25-browser-capabilities.md) — every capability in one place
- [09-testing-and-debugging.md](09-testing-and-debugging.md) — testing levels
