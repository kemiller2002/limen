# Clipboard

Limen's `Clipboard` capability writes text to the system clipboard. The engine
asks; the kernel performs; the answer comes back as a typed outcome and becomes
state like any other evidence.

Worked example: [`examples/07-clipboard/`](../examples/07-clipboard/README.md).

---

## The shape of it

```ts
export type ClipboardEffectRequest = {
  kind: "Clipboard";
  correlationId: CorrelationId;
  operation: "writeText";
  text: string;
};

export type ClipboardOutcome =
  | { kind: "Success" }
  | { kind: "Failure"; reason: "denied" | "unavailable" | "unknown" };
```

Requesting it:

```ts
return {
  state: { kind: "Copying", correlationId, url },
  effects: [{ kind: "Clipboard", correlationId, operation: "writeText", text: url }],
  accepted: true,
};
```

Success carries no payload: a clipboard write either happened or it did not,
and there is nothing to read back.

## Write-only, deliberately

There is no `readText`. Reading the clipboard would let an engine pull whatever
the user last copied — a password, an address, a message — across the boundary
on its own initiative. Every use case in this repository is a write, and a
capability that dangerous should not exist speculatively.

If you genuinely need to read the clipboard, add it as a capability with the
same care the [recipes](15-recipes.md) describe, and decide deliberately what
your engine is allowed to do with what it finds.

## The three failure reasons

They are distinguished because an engine answers them differently. Collapsing
them costs you the only honest advice you can give.

| Reason | Means | Tell the user |
| --- | --- | --- |
| `denied` | The browser refused this attempt — usually because the user gesture had gone stale | "Click Copy again." It genuinely often works. |
| `unavailable` | This browser or this context has no Clipboard API at all | "Select the link and copy it manually." A retry can never succeed. |
| `unknown` | Something else went wrong | "The copy did not complete." Do not invent a cause. |

```ts
const canRetry = state.kind === "CopyFailed" && state.reason === "denied";
```

Offering a retry for `unavailable` is advice that cannot work. That is the
mistake this split exists to prevent.

## Browser constraints you cannot engineer around

These are the browser's rules, not Limen's:

- **Secure context required.** `https://` or `localhost`. A plain `http://`
  page on another host has no `navigator.clipboard`, and you get `unavailable`.
- **A user gesture is usually required**, and it must be *recent*. A write
  triggered by a timer, a fetch completing, or anything the user did not just
  click will typically be `denied`.
- **Permissions and iframes.** An iframe without `clipboard-write` in its
  `allow` attribute is denied.
- **Focus.** Some browsers refuse a write while the document is not focused.

The practical consequence for a Limen application: **keep the round-trip
short.** A copy that waits on a fetch before writing has usually lost the
gesture by the time it runs. Copy what you already have, or fetch first and
copy on the next click.

## Waiting is a state

A clipboard write is asynchronous and can be refused, so the gap between asking
and knowing is real:

```text
Idle ──copy──▶ Copying ──Success──▶ Copied
                  └──Failure(reason)──▶ CopyFailed
```

Representing `Copying` is what lets the button disable itself honestly rather
than inviting a second click that races the first. Refuse the second copy in
`transition` too — the projection and the rule should not be the same line of
code twice.

## Do not use the capability list to pre-disable the button

`Initialize.capabilities` says what the **kernel implements**, not what this
browser will permit. It always contains `"Clipboard"`. Whether a write actually
works is only knowable by trying, and the outcome says so.

## What is never logged

`ClipboardEffectRequest.text` is never surfaced in a `DiagnosticEvent`, under
the same rule that keeps Http headers out of them: whatever an application
copies for its user is the user's, and a bridge that logged it would make every
consumer's log a place secrets accumulate. There is a test asserting this.

If you write your own `DiagnosticsSink`, hold the same line.

## Testing it

`jsdom` has no Clipboard API at all, so a test that stubs nothing exercises the
`unavailable` path for free. Installing a stub on `window.navigator` reaches the
granted and denied paths; this repository's helper is `withClipboard` in
[`test/dom-helpers.ts`](../test/dom-helpers.ts).

For the transition logic, skip the DOM entirely — `transition` and `project` are
pure functions of an outcome you can write down by hand.

## Common mistakes

| Mistake | What goes wrong |
| --- | --- |
| Calling `navigator.clipboard` from application code | the architecture check fails the build, and the behavior becomes untestable |
| Reading the text out of the DOM at copy time | the copied text and the displayed text can drift apart |
| Treating every failure the same | you tell users to retry something that cannot succeed |
| Copying after an `await` on a network request | the user gesture has gone stale; expect `denied` |
| Using `capabilities` to decide whether copying is possible | it says what the kernel implements, not what the browser permits |

## Related

- [examples/07-clipboard](../examples/07-clipboard/README.md) — the whole thing, running
- [traces.md](traces.md) — a copy traced from click to "Copied"
- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — the effect model
- [15-recipes.md](15-recipes.md) — adding a capability of your own
