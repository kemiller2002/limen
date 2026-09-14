# Rendering

**What this answers:** how application state reaches the screen, and — first —
whether this is a UI framework.

---

## Is the kernel a rendering framework?

**No.** If you are coming from React, Vue, Svelte, or similar, the mental model
transfers badly. Read this section before writing anything.

| | React/Vue/etc. | This kernel |
| --- | --- | --- |
| Who writes the markup? | your component code, at runtime | **you, in an `.html` file, by hand** |
| What does the app layer return? | a tree of elements (VDOM/template) | **a flat record of values** |
| Is there a virtual DOM? | yes | **no** |
| Is there a diff/reconcile pass? | yes, over a tree | **no** — only keyed list reconciliation |
| Can the app create an element? | yes | **no** — it cannot express one |
| Where does styling live? | often in components | **CSS files, untouched** |
| Components? | yes | **no such concept** |

The engine cannot produce HTML. It has no API for it. `ViewState` admits only
strings, numbers, booleans, and flat arrays of those:

```ts
type ViewPrimitive = string | number | boolean;
type ViewItem      = { readonly [field: string]: ViewPrimitive };
type ViewValue     = ViewPrimitive | readonly ViewItem[];
type ViewState     = { readonly [key: string]: ViewValue };
```

There is no element type, no children, no tag name, no `dangerouslySetInnerHTML`
— and `scripts/check-architecture.ts` fails the build on `SetInnerHtml`,
`ExecuteScript`, or `eval(` anywhere in `src/`.

**What stays normal HTML and CSS?** All of it. Your document structure is a
static `.html` file. Your styling is a static `.css` file. The browser does
layout and paint exactly as it always has. The kernel's total contribution to
the DOM is: setting `textContent`, setting attributes and a few properties, and
mounting or removing `<template>` contents.

### Why so limited?

Because the limit is what keeps application logic out of the browser layer. A
layer that can build arbitrary DOM eventually decides *when* to build it, and
that decision is application logic. Restricting output to named values means
there is no room for that to happen.

---

## How it works

The engine returns a `ViewState`. The kernel walks the bindings it collected at
startup and makes the DOM match. That is the whole mechanism.

```text
project(state) → { statusText: "Saving…", saveDisabled: true, entries: [...] }
                        │               │                   │
   <p data-text="statusText">           │                   │
   <button data-bind-disabled="saveDisabled">               │
   <template data-each="entries" data-key="id">  ───────────┘
```

Elements are located **at startup only**, by a single recursive walk of
`document.body` (see [03-kernel-lifecycle.md](03-kernel-lifecycle.md)). There is
no `querySelector` at projection time, and nothing looks elements up by id — the
engine never sees an id.

Every projection is **complete**, not a patch. The engine says what things are
now; the kernel makes the DOM match.

---

## The five primitives

### `data-text="key"` — text content

```html
<p data-text="statusText"></p>
<span>Count: <span data-text="count">0</span></span>
```

Sets `element.textContent`. Always text, never markup — a projected value
containing `<script>` becomes visible characters, not an element. That is a
property of `textContent`, and it is why XSS is not reachable through this path.

Accepts a string, number, or boolean and stringifies it.

> **The key must be present in every projection.** A missing or non-scalar value
> throws `View value for "<key>" is missing or not scalar`, which the error
> boundary reports as `BridgeError { phase: "projection" }` and which **aborts
> the rest of that round trip, including its effects**. Projections must be
> total.

### `data-bind-<attr>="key"` — attributes and properties

```html
<button data-bind-disabled="saveDisabled">Save</button>
<input  data-bind-value="draftText">
<div    data-bind-aria-current="isActive">
<img    data-bind-src="avatarUrl" data-bind-alt="avatarLabel">
```

The part after `data-bind-` is the target name. Behavior depends on which:

| Target | Applied as |
| --- | --- |
| `disabled`, `checked`, `selected`, `hidden`, `open` | the DOM **property**, coerced with `Boolean()` |
| `value` | the `.value` **property**, and only if it differs from the current one |
| anything else | `setAttribute(name, String(value))` |

The boolean-property list exists because `setAttribute("disabled", "false")`
would *enable* the attribute — the string `"false"` is still a present
attribute. Those five are set as properties so `false` means false.

`value` is special-cased to skip a no-op write, because reassigning an input's
`.value` while someone is typing can move the caret. This is a partial
mitigation, not a full solution — see
[16-troubleshooting.md](16-troubleshooting.md#my-caret-jumps-while-typing).

Requires a scalar; an array throws.

### `data-if="key"` — conditional content

```html
<template data-if="hasError">
  <p class="error" role="alert" data-text="errorMessage"></p>
</template>
```

Mounted when `view[key]` is truthy, removed when it is not. The template must
wrap **exactly one root element**, or mounting throws.

> **`data-if` only works on a `<template>`.** Written on an ordinary element —
> `<p data-if="ready">` — it is a binding error, reported as
> `BridgeError { phase: "binding" }`, and `start()` stops before dispatching
> `Initialize`. It used to be ignored in silence, which is how a real consumer
> project lost an afternoon to an empty-state message that never disappeared
> (finding L-2 in [19-evidence.md](19-evidence.md)).

Mechanics worth knowing:

- The `<template>` is replaced by a comment anchor at startup and is never in
  the document itself.
- Mounting **clones** the content and binds the clone. Unmounting removes the
  node entirely — any browser-local state inside it (focus, scroll, caret,
  uncommitted input) is destroyed. Toggling `data-if` rapidly around an input is
  a bad idea; project `disabled` or `hidden` instead.
- Unlike `data-text`, a **missing key is not an error** here:
  `Boolean(undefined)` is `false`, so the content simply stays unmounted. This
  asymmetry is real and it makes a typo'd `data-if` key silently invisible
  rather than loud. It is the single most common cause of "my content never
  appears" — see [16-troubleshooting.md](16-troubleshooting.md).

### `data-each="key" data-key="field"` — lists

```html
<ul>
  <template data-each="entries" data-key="id">
    <li>
      <span data-text="description"></span>
      <button data-event="remove">Remove</button>
    </li>
  </template>
</ul>
```

`data-key` is **required** — omitting it throws at bind time.

Two rules that surprise people:

1. **Inside the template, keys resolve against the item, not the view.**
   `data-text="description"` reads `item.description`. Top-level view keys are
   not reachable from inside a list item. If a row needs a global value, project
   it onto every item.
2. **An event fired inside an item carries that item's key** as
   `SemanticEvent.key`. That is how the engine knows which row.

`view[key]` must be an array, or it throws — so project `[]`, never omit the
key, when the list is empty.

#### Keyed reconciliation

Items are tracked by their key across projections:

| Change | What happens |
| --- | --- |
| key already present | the existing DOM node is **reused**, its bindings re-applied |
| key is new | a clone is created and bound |
| key no longer present | the node is removed |
| order changed | nodes are **moved**, not recreated |

Reusing nodes preserves focus, caret position, uncommitted input, and running
animations across reorders. It also means **keys must be stable and unique**. A
key derived from the array index defeats all of it — every item's identity
changes when one is inserted.

#### Nested lists are not supported

`ViewItem` values are `string | number | boolean`. An item cannot contain an
array, so a `data-each` inside a `data-each` has nothing valid to read and will
throw `requires an array view value`. Flatten the list, or render one level and
project a summary for the other.

### `data-on="type"` — trigger override

Not a rendering primitive; documented in
[05-events-and-dispatch.md](05-events-and-dispatch.md).

---

## Practical patterns

### Visibility: `data-if` vs. `data-bind-hidden`

| Use | When |
| --- | --- |
| `data-if` | the content should not exist — a different screen, an absent record |
| `data-bind-hidden` | the element should stay alive — preserving focus or input, or it toggles rapidly |

`data-if` destroys and recreates. `data-bind-hidden` sets the `hidden` property
and leaves the node in place.

### Validation messages

Project the message and its visibility separately, then let one template carry
both:

```ts
nameError:        nameMessage(draft.name),        // "" when fine
nameErrorVisible: nameMessage(draft.name) !== "",
```

```html
<template data-if="nameErrorVisible">
  <p class="error" role="alert" data-text="nameError"></p>
</template>
```

Real version: [`examples/02-form/`](../examples/02-form/).

### Accessibility

ARIA is ordinary HTML, so it works without kernel support:

```html
<!-- Announced automatically when textContent changes -->
<p role="status" aria-live="polite" data-text="statusText"></p>

<!-- Projected ARIA state -->
<button data-bind-aria-expanded="panelOpen" data-event="toggle">Details</button>
<div data-bind-aria-busy="loading">…</div>
```

A live region works because the kernel updates `textContent` and the browser
does the rest. No kernel code is involved, which is why there is none to test
(ROADMAP item 15).

**Focus is not managed.** Removing a focused list item drops focus to `<body>`.
That is a known gap, deliberately deferred.

### Styling from projected data

Project data; let CSS decide appearance:

```ts
navItems: SCREENS.map((screen) => ({ id: screen, label: LABELS[screen], active: screen === state.screen })),
```

```html
<button data-event="navigate" data-text="label" data-bind-aria-current="active"></button>
```

```css
.nav button[aria-current="true"] { background: var(--accent); }
```

The engine said *which tab is current*. CSS decided what current looks like.
Neither knows the other's business.

---

## Common mistakes

| Symptom | Cause | Fix |
| --- | --- | --- |
| `BridgeError (projection): View value for "x" is missing` | a `data-text`/`data-bind-` key absent from that projection | project every bound key in every branch |
| Content never appears | typo'd `data-if` key — silently falsy | check spelling against the projection |
| `data-if="..." template must contain exactly one root element` | zero or multiple roots, or leading whitespace text | wrap in one element |
| `data-each="x" requires data-key` | missing `data-key` | add it |
| `requires an array view value` | key absent or not an array | project `[]` when empty |
| List item text is blank | reading a top-level key from inside an item | project it onto each item |
| Focus lost while typing in a list | unstable keys | use a stable id, never the index |
| `disabled="false"` still disables | bound a boolean to a non-boolean-prop attribute | use one of the five boolean props |

---

## Related

- [03-kernel-lifecycle.md](03-kernel-lifecycle.md) — when binding and applying happen
- [04-state-model.md](04-state-model.md) — deriving a projection from state
- [08-multi-screen-applications.md](08-multi-screen-applications.md) — `data-if` at screen scale
- [11-api-reference.md](11-api-reference.md) — exact types
