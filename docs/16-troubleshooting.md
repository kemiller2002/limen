# Troubleshooting

**What this answers:** symptom → cause → fix.

---

## First: install a diagnostics sink

The kernel's error boundary deliberately does not throw, and the default
diagnostics sink is a **no-op**. So a broken projection produces *no console
output at all*. If something silently does nothing, do this before anything
else:

```ts
const kernel = new BrowserKernel(transport, document, {
  report(event) {
    if (event.kind === "BridgeError") console.error(`[bridge:${event.phase}]`, event.detail);
    else console.debug(`[effect] ${event.correlationId} ${event.durationMs.toFixed(1)}ms`);
  },
});
```

Roughly half the entries below become self-diagnosing once this is in place.

---

## An event fires in the browser but the engine does nothing

Work down this list in order.

**1. Is the element actually bound?**
Bindings are collected once, during `start()`. Anything added to the DOM
afterwards by other means is invisible to the kernel forever. Only `data-if` and
`data-each` add bindable content later.

**2. Is the trigger the DOM event you think?**

| Element | Default |
| --- | --- |
| `<form>` | `submit` |
| `<input>`, `<select>`, `<textarea>` | `change` — **on blur, not per keystroke** |
| everything else | `click` |

"It only works after I click away" is the `change` default. Add `data-on="input"`.

**3. Is the attribute spelled right?** `data-event`, not `data-events` or
`data-on-click`. An unrecognized attribute is ignored silently — the kernel has
no allow-list to check it against.

**4. Did `start()` succeed at all?** If `transport.start()` rejected, **nothing
was bound**. The page sits at its placeholder content forever. Check diagnostics
for `BridgeError { phase: "dispatch" }`.

**5. Is `eventToCommand` throwing?** An unrecognized name throws by design. The
error boundary catches it and reports `BridgeError { phase: "dispatch" }` with
the message. Check the name matches the attribute exactly — it is
case-sensitive.

**6. Is native form validation blocking it?** For a `submit` trigger,
`reportValidity()` runs first and returns early if the form is invalid. A
`required` or `type="email"` field that fails silently stops the dispatch.

---

## The form submits and the page reloads

`data-event` is on the button instead of the `<form>`.

```html
<!-- wrong: the kernel never sees the submit, so preventDefault() never runs -->
<form><button type="submit" data-event="save">Save</button></form>

<!-- right -->
<form data-event="save"><button type="submit">Save</button></form>
```

`preventDefault()` is called only for the `submit` trigger, which only attaches
to the element carrying `data-event` — and that must be the form.

---

## State changes but the UI does not

**1. Is the key actually in the projection?**
A missing `data-text`/`data-bind-*` key throws
`View value for "x" is missing or not scalar`, reported as
`BridgeError { phase: "projection" }`. Note the knock-on effect: **the round
trip aborts, so its effects never run.** A "frozen" page with no network
activity is usually this.

**2. Did you bind the key you projected?** `data-text="statusText"` vs.
`statusText` in the projection — compare them character by character.

**3. Is it inside a `data-each` template?** Keys there resolve against the
**item**, not the top-level view. A top-level value is unreachable from inside a
row; project it onto every item.

**4. Are you asserting too early in a test?** Applying the response happens
after a microtask boundary. See
[09-testing-and-debugging.md](09-testing-and-debugging.md).

---

## `data-if` content never appears

**The most common silent failure in the whole system**, because of an asymmetry
worth memorizing:

| Binding | Missing key |
| --- | --- |
| `data-text`, `data-bind-*` | **throws** — loud |
| `data-if` | `Boolean(undefined)` = `false` — **silently unmounted** |

So a typo'd `data-if` *key* never errors. It just never shows.

**A misplaced `data-if` does error now.** If you wrote it on an ordinary
element rather than a `<template>`, you will see
`BridgeError { phase: "binding" }` with
`data-if="…" is only supported on a <template> element, but was found on <p>`,
and the page will stay at its placeholder content. Wrap it:

```html
<!-- wrong: silently did nothing before; a binding error now -->
<p data-if="hasError">Something went wrong.</p>

<!-- right -->
<template data-if="hasError"><p>Something went wrong.</p></template>
```

If the key is merely misspelled, work down this list:

1. Spell-check the key against the projection.
2. Confirm the value is actually truthy — `0` and `""` are falsy, so
   `data-if="count"` hides when the count is zero. Project an explicit
   `hasItems: count > 0` instead.
3. Confirm the template has **exactly one root element**. Zero or two throws
   `template must contain exactly one root element`.

---

## `data-each` renders nothing or throws

| Error | Cause |
| --- | --- |
| `data-each="x" requires data-key` | `data-key` missing — it is mandatory |
| `requires an array view value` | the key is absent or not an array |
| `data-each item missing key field "id"` | items lack the field named by `data-key` |
| `template must contain exactly one root element` | zero or multiple roots |

Project `[]` when empty — never omit the key.

**Nested `data-each` cannot work.** `ViewItem` values are
`string | number | boolean`, so an item cannot contain an array. Flatten, or
project a summary for the inner level.

---

## Items lose focus or reorder wrongly

Unstable `data-key` values. Using the array index means every key changes when an
item is inserted, so reconciliation reuses the node for key `"0"` — now a
different item — and focus, caret, and uncommitted input land on the wrong row.

```ts
items: state.items.map((item, i) => ({ id: String(i), … })),   // wrong
items: state.items.map((item)    => ({ id: item.id,   … })),   // right
```

---

## My caret jumps while typing

`data-bind-value` writes the engine's value back into the input. The kernel
already skips a write when the value is unchanged, which handles the common
case — but if the engine *canonicalizes* (trims, lowercases, reformats) on every
keystroke, the value genuinely differs and the write moves the caret.

Options:

1. **Don't canonicalize per keystroke.** Store the raw text; normalize on
   commit. This is what the examples do.
2. **Drop `data-bind-value`** if the engine never needs to overwrite the field.
3. **Canonicalize on `change`** (blur), not `input`.

This is a known limitation, recorded in [USAGE.md](USAGE.md)'s "Known gaps".

---

## A checkbox always reports the same value

Known gap. `readValue()` returns `.value`, not `.checked`, so a checkbox always
reports its `value` attribute regardless of whether it is ticked.

Workarounds:

- Project and bind `data-bind-checked` for display, and model the toggle as a
  distinct event (`toggleThing`) whose meaning is "flip it" rather than "here is
  the new value".
- Use two radio inputs with different `value`s.

Recorded in [USAGE.md](USAGE.md)'s "Known gaps" and
[DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md).

---

## Fetch succeeds but the application never updates

**1. The stale-result guard is rejecting a valid result.** This is the usual
cause. Check that the `correlationId` in the effect request is the same one
stored in the state:

```ts
if (state.kind !== "Loading" || state.correlationId !== command.correlationId) {
  return still(state);    // ← is this firing when it shouldn't?
}
```

A common bug is generating a fresh correlation ID when building the effect but
storing a different one in the state.

**2. You are in the wrong state.** The guard also checks `state.kind`. If an
intervening event moved the state, the result no longer applies.

**3. The response was a `Success` you rejected.** Remember every response is
`Success`, including 404 and 500. Check `outcome.status` handling.

**4. Decoding returned `null`.** Log the raw `outcome.body` — it is `unknown`
and nothing validated it.

**5. It came back as `Cancelled`.** Something named its ID in `cancellations`.

---

## Everything happens twice

`start()` was called more than once. It re-binds the whole document and
double-registers every listener. Call it exactly once; there is no
`stop()`/`unbind()` to undo it.

---

## The page stays on placeholder text forever

One of two things happened, and the diagnostics sink tells you which:

| Reported | Cause |
| --- | --- |
| `BridgeError { phase: "dispatch" }` | `transport.start()` rejected. The kernel **returns before binding anything** — no bindings, no `Initialize`, no first projection. |
| `BridgeError { phase: "binding" }` | The markup is malformed — a `data-each` without `data-key`, a `data-if`/`data-each` on a non-`<template>` element, or a template with zero or several root elements. Binding stops and `Initialize` is never dispatched. |

Install a diagnostics sink to see which, and the message. In a WASM transport
the first row is where a failed module fetch or instantiation lands: check the
file is served, the path is right, and the MIME type is `application/wasm`.

---

## `npm run check` fails

| Message | Meaning |
| --- | --- |
| `forbidden browser dependency document` | `src/engine/**` references a browser API — move it behind an `EffectRequest` |
| `dynamic type escape` | the word `any` or `dynamic` appears in `src/engine/**` — including inside a comment or a string ⚠️ |
| `forbidden escape hatch` | `eval(`, `SetInnerHtml`, or `ExecuteScript` somewhere in `src/` |
| `broken link ->` | a Markdown link points at a nonexistent file |
| `orphaned` | a doc under `docs/` is not linked from any index |
| `Cannot find package 'jsdom'` | run `npm install` |

> ⚠️ The `any`/`dynamic` check is a **word-boundary regex over raw file text**
> (`/\b(any|dynamic)\b/`), not a type-aware analysis. It matches in comments and
> string literals too, so a comment reading "any of these" fails the build —
> rephrase it. It is case-sensitive and respects word boundaries, so `Any` and
> `company` are fine. Recorded as finding **N-2** in
> [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md).

---

## Tests fail intermittently

Almost always the timing regimes. Asserting on **dispatch** is safe immediately;
asserting on **applied DOM state** needs `await flush()` first.

```ts
button.click();
assert.equal(transport.calls.length, 2);   // safe
await flush();
assert.equal(p.textContent, "Saving…");     // needed the flush
```

Also check you are not calling `start()` twice to force a re-render — use a real
event round trip.

---

## Types don't resolve from the package

`moduleResolution` must be `"bundler"`, `"node16"`, or `"nodenext"`. The package
uses the `exports` field, and older modes do not read it.

```json
{ "compilerOptions": { "moduleResolution": "bundler" } }
```

---

## `Unrecognized event: …` at runtime

`DirectTypeScriptTransport` is wired to this repository's demo domain and
understands only `emailChanged` and `checkAvailability`. It is a reference, not
a base class.

Write your own `EngineTransport` — about eight lines,
[02-getting-started.md](02-getting-started.md).

---

## Nothing loads from `file://`

ES modules require `http://`. Serve the directory:

```sh
python3 -m http.server 4173
```

---

## Still stuck

1. Trace the round trip — wrap the transport and log both directions
   ([09-testing-and-debugging.md](09-testing-and-debugging.md)).
2. Compare against the closest example; they are all verified by the test suite.
3. Open [`examples/kitchen-sink.html`](../examples/kitchen-sink.html) — it has
   deliberate buttons for a malformed projection and a thrown transport, so you
   can see what those failures look like.
4. Reduce to the smallest reproduction and check it against
   [13-anti-patterns.md](13-anti-patterns.md).
