# Browser capabilities

**What this answers:** every browser operation a Limen engine may request,
what it returns, and how to switch it on — in one place, so that finding out
does not require reading the kernel.

This page is the authoritative list. If a capability is not here, an engine
cannot do it.

---

## The rule

An engine never calls a browser API. It returns an `EffectRequest`; the kernel
performs it and returns an outcome. That is the whole model, and it is the same
for all five capabilities.

```text
engine decides  →  EffectRequest  →  kernel  →  browser API
                                                    ↓
engine transitions  ←  EffectResult  ←  kernel  ←  outcome
```

Three properties hold for every capability below:

1. **Failure is a value, not an exception.** Every outcome type has a
   `Failure` case with a closed set of reasons. Nothing throws into
   application code.
2. **Availability is announced.** `Initialize.capabilities` says what *this*
   kernel can do. A capability that was not wired refuses the effect rather
   than quietly performing it.
3. **The kernel classifies; it never interprets.** It reports that a request
   returned 404, or that a clipboard write was denied. What that *means* is
   the engine's decision.

---

## The five capabilities

| Capability | Default | Operations | Outcome cases |
| --- | --- | --- | --- |
| **Http** | always on | `GET` `PUT` `POST` `PATCH` `DELETE` | `Success` · `Failure` · `Cancelled` · `OutcomeUnknown` |
| **Storage** | always on | `get` `set` `remove` (`localStorage`) | `Success` · `Failure` |
| **Navigation** | **opt-in** | `push` `replace` `back` `forward` | `Success` · `Accepted` · `Failure` |
| **Clipboard** | **opt-in** | `writeText` | `Success` · `Failure` |
| **Document** | **opt-in** | `focusTarget` `scrollToTop` | `Success` · `Failure` |

### Switching the opt-in ones on

```ts
new BrowserKernel(transport, document, {
  diagnostics,                                           // optional, as before
  navigation: { historyEvent: "urlChanged",              // required to enable
                linkEvent: "linkActivated" },            // optional
  clipboard: { enabled: true },
  document: { enabled: true },                           // focus + scroll
});
```

The third argument also still accepts a bare `DiagnosticsSink`, which is what
it always meant.

---

## Http

```ts
{ kind: "Http", correlationId, method, url, headers?, body?, timeoutMs }
```

```ts
type EffectOutcome =
  | { kind: "Success"; status: number; body: unknown }
  | { kind: "Failure"; reason: "network" | "aborted" | "invalid-response"; status?: number }
  | { kind: "Cancelled" }
  | { kind: "OutcomeUnknown"; reason: "timeout-after-dispatch" };
```

The only capability with `OutcomeUnknown`: a timeout cannot prove the request
did not reach the server, so the kernel refuses to claim it did not.
Cancellable via `EngineToBrowserMessage.cancellations`.

**Headers and bodies are never logged** — they commonly carry credentials.

Full treatment: [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md#http).

## Storage

```ts
| { kind: "Storage", correlationId, operation: "get",    key }
| { kind: "Storage", correlationId, operation: "set",    key, value }
| { kind: "Storage", correlationId, operation: "remove", key }
```

```ts
type StorageOutcome =
  | { kind: "Success"; value: string | null }
  | { kind: "Failure"; reason: "unavailable" | "quota-exceeded" };
```

`localStorage` only. `value` is the read value for `get`; `null` means the key
was absent, which is a normal outcome and not a failure.

**Do not put anything sensitive in `localStorage`** — any script on the origin
can read it, and it persists indefinitely.

Full treatment: [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md#storage).

## Navigation

```ts
| { kind: "Navigate", correlationId, operation: "push",    url }
| { kind: "Navigate", correlationId, operation: "replace", url }
| { kind: "Navigate", correlationId, operation: "back" }
| { kind: "Navigate", correlationId, operation: "forward" }
```

```ts
type NavigationOutcome =
  | { kind: "Success"; url: string }   // push/replace — the resulting location
  | { kind: "Accepted" }               // back/forward — queued; the history event is authoritative
  | { kind: "Failure"; reason: "unavailable" | "cross-origin" | "invalid-url" };
```

Also has an **inbound** direction, which no other capability does:
`Initialize.location` at startup, and a `SemanticEvent` named by your
`historyEvent` whenever the browser moves through history.

**Cross-origin navigation is refused**, not attempted: this effect must not
become a way to move the page to another site.

Full treatment: [24-navigation-and-github-pages.md](24-navigation-and-github-pages.md)
and [08-multi-screen-applications.md](08-multi-screen-applications.md).

## Clipboard

```ts
{ kind: "Clipboard", correlationId, operation: "writeText", text }
```

```ts
type ClipboardOutcome =
  | { kind: "Success" }
  | { kind: "Failure"; reason: "permission-denied" | "not-secure-context" | "unsupported" | "failed" };
```

Write only. Reading is deliberately not implemented — see
[23-clipboard.md](23-clipboard.md#reading-the-clipboard).

**Clipboard contents are never logged.**

Full treatment: [23-clipboard.md](23-clipboard.md).

---

## Document

```ts
| { kind: "Document", correlationId, operation: "focusTarget" }
| { kind: "Document", correlationId, operation: "scrollToTop" }
```

```ts
type DocumentOutcome =
  | { kind: "Success" }
  | { kind: "Failure"; reason: "unavailable" | "no-target" };
```

Presentation actions for a route change. **Neither names an element**: the
markup marks the destination with `data-focus-target`, the engine decides only
*when* focus should move. `no-target` means no marked element is mounted —
said out loud rather than silently skipped, because it almost always means a
missing attribute.

The kernel adds `tabindex="-1"` to the target if it has none, since `focus()`
on a plain heading does nothing at all.

**The document title is not here.** It is a projection —
`<title data-text="pageTitle">` — because a title is a function of state, not
an action. See
[24-navigation-and-github-pages.md](24-navigation-and-github-pages.md#the-document-title-is-a-projection-not-an-effect).

Full treatment: [24-navigation-and-github-pages.md](24-navigation-and-github-pages.md#scroll-focus-and-the-document-title).

---

## What does not exist

Not oversights. This repository treats building a capability before a feature
needs it as an architecture violation in its own right, because it produces
untested surface with no design pressure behind it
([ROADMAP.md](ROADMAP.md)'s 🧊 legend).

| Not implemented | Notes |
| --- | --- |
| Clipboard **read** | Least-capability: exposes anything the user copied anywhere. Shape recorded in [23-clipboard.md](23-clipboard.md). |
| Page reload | No `location.reload()` capability. Nothing has needed one. |
| External navigation / new tab | Use a real `<a href>`; the kernel never intercepts another origin. |
| Scroll **restoration** | Deliberate. Browsers restore scroll on history traversal natively, and redoing it by hand throws away the position the user came back to see. |
| Focusing an arbitrary element | Only the marked route target. Focusing whatever you like on every state change is how focus management becomes hostile. |
| Timers, `requestAnimationFrame` | No scheduling primitives; no debounce. |
| Files, geolocation, notifications, media, observers | — |
| `sessionStorage`, `IndexedDB`, Cache API | — |

## Adding one

The full recipe, with a worked clipboard-style example, is in
[15-recipes.md](15-recipes.md#add-a-new-browser-capability). In short:

1. Add the request as a **closed union — one member per legal operation**, not
   a record with an operation field and optional extras. `{ operation: "back",
   url: "/x" }` should be impossible to write down.
2. Add an outcome type whose `Failure` reasons are **normalized conditions**,
   never browser exception strings.
3. Include `OutcomeUnknown` **only if** "dispatched but uncertain" is genuinely
   reachable. It is for Http; it is not for anything synchronous or local.
4. Add it to `Capability` and announce it **only when actually wired**.
5. Execute it in `#runEffect`'s exhaustive switch.
6. Decide what must never be logged, and add a test that proves it is not.
7. Document it here and in its own page.

---

## Related

- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — the effect model in depth
- [11-api-reference.md](11-api-reference.md) — every type
- [14-agent-guide.md](14-agent-guide.md) — the rules an agent needs
- [12-design-rules.md](12-design-rules.md) — MUST/SHOULD/MAY
