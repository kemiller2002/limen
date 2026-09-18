# 07 — Clipboard

## What this demonstrates

Copying text to the system clipboard without any application code touching
`navigator.clipboard`. The engine asks for a `Clipboard` effect; the kernel
performs it; the answer comes back as a typed outcome and becomes state.

The most important thing in this example is what is missing: search
[`engine.ts`](engine.ts) for `navigator` and you will not find it. You cannot
add it either — `npm run check:architecture` fails the build if engine code
names a browser global.

## Concepts

| Concept | Where to see it |
| --- | --- |
| `Clipboard` effect request | `transition`, the `Copy` case |
| Three distinct failure reasons | `FailureReason`, and `message()` |
| Waiting is a state, not a flag | `State.Copying` |
| Capability projection | `copyDisabled`, `canRetry` |
| Stale-result rejection | `RecordCopy` checks the correlation id |
| Per-row bindings inside `data-each` | `copyDisabled` repeated on each share |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | structure and `data-*` bindings |
| [`engine.ts`](engine.ts) | state, transitions, projection — never the browser |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
Idle ──copy──▶ Copying ──Success──▶ Copied ──dismiss──▶ Idle
                  │
                  └──Failure(reason)──▶ CopyFailed ──dismiss──▶ Idle
```

A second `copy` while one is in flight is **refused**, not queued. The
projection disables the button and the transition enforces the same rule, so
the guarantee does not depend on the DOM being applied first.

## Event flow

```text
click on a row's Copy button
  → SemanticEvent { name: "copy", key: "<the row's data-key>" }
  → eventToCommand resolves that key to a share, and so to a URL
  → transition → Copying + one Clipboard effect
```

The button carries an opaque key, never the URL. The engine decides what the
key stands for; the kernel never learns that a "share" exists.

## Effect flow

```text
Clipboard { operation: "writeText", text }
  → kernel: navigator.clipboard.writeText(text)
  → ClipboardResult { outcome: Success | Failure{ denied | unavailable | unknown } }
  → transition → Copied | CopyFailed
  → projection → the status line, and whether a retry is worth offering
```

The copied text is never reported to diagnostics, under the same rule that
keeps Http headers out of them.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/07-clipboard/>.

The clipboard needs a **secure context**. `localhost` counts as one; a plain
`http://` page on another host does not, and there you will see the
"unavailable" path for real.

## Expected behavior

| You do | You see |
| --- | --- |
| Click Copy | "Copied to the clipboard." and a Dismiss button |
| Paste anywhere | the URL shown in that row, exactly |
| Click Copy in a browser that refuses | "The browser refused the copy…" and a retry hint |
| Open the page over plain `http://` on a non-localhost host | "This browser will not give the page clipboard access." and **no** retry hint |

## Exercises

1. Add a "Copied *n* times" counter. Note that it belongs in `State`, and that
   the DOM must not count clicks itself.
2. Make `Copied` decay back to `Idle`. You will find there is no timer
   capability — decide whether the honest answer is a new capability or a
   dismissal the user performs.
3. Add a third share. Notice that `index.html` does not change.

## Common mistakes

- **Reading the URL out of the DOM at copy time.** The DOM is output. Copy
  from state, as this example does, and the copied text and the displayed text
  are the same value by construction.
- **Treating every failure the same.** Telling a user to "try again" on a
  browser with no Clipboard API is advice that can never work. `denied` is
  retryable; `unavailable` is not.
- **Using `Initialize`'s `capabilities` list to pre-disable the button.** That
  list says what the *kernel* implements, not what this browser will permit.
  Whether a clipboard write works is only knowable by trying.
- **Binding a top-level view key inside a `data-each` row.** Bindings inside a
  row resolve against the item. Project the value onto each item instead.

## Related

- [docs/clipboard.md](../../docs/clipboard.md) — the capability in full
- [docs/07-effects-and-browser-interop.md](../../docs/07-effects-and-browser-interop.md)
- [08-routing](../08-routing/) — the other new capability
