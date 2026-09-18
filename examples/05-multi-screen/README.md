# 05 — Multi-screen

## What this demonstrates

More than one screen, with **no URLs involved**. Screens are ordinary state,
and the choice not to route is a real one — see the note at the bottom.

## Concepts

| Concept | Where to see it |
| --- | --- |
| A screen as a value in `State` | `State.screen` |
| `data-each` navigation carrying item keys | `index.html`'s `<nav>` |
| Shared vs. screen-local lifetimes | `displayName` vs. `customerFilter` |
| Engine-side filtering | the customers projection |
| `data-bind-aria-current` — accessibility state is projected too | `index.html` |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | one `data-if` template per screen |
| [`engine.ts`](engine.ts) | screen state, shared state, filtering |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
State = {
  screen: "home" | "customers" | "settings",   // which screen is showing
  displayName: string,                         // shared: set here, shown there
  customerFilter: string,                      // screen-local *lifetime*
  settingsDraft: string,                       // screen-local *lifetime*
}
```

"Screen-local" describes how long a value stays meaningful — not a second
store. Every field lives in the one authoritative place.

## Event flow

```text
click a nav button
  → SemanticEvent { name: "navigate", key: "<screen id>" }
  → transition → a new screen
  → project → exactly one of onHome/onCustomers/onSettings is true
```

The nav is a `data-each`, so a click inside an instantiated row carries that
row's key. That is how the engine learns which tab was clicked without the
kernel knowing tabs exist.

## Effect flow

None. Filtering is a pure projection over state the engine already holds.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/05-multi-screen/>.

## Expected behavior

| You do | You see |
| --- | --- |
| Click Customers, type a filter, leave, come back | the filter is still there |
| Change the display name in Settings, go Home | the new name |
| Press the browser's Back button | **nothing happens** — this example has no URLs |

## Screens without URLs is a real choice

Not every screen deserves a URL. A tab strip inside one page, a wizard step, a
detail pane — none of those are usually worth being bookmarkable, and giving
them URLs means committing to keeping them working forever.

When a screen *should* be linkable, shareable, or survive a reload, that is
routing: see [08-routing](../08-routing/), which adds exactly that and nothing
else.

## Exercises

1. Add a fourth screen. Notice that the kernel is untouched.
2. Give the customer filter a "clear" button, and project whether it is
   available.

## Common mistakes

- **Hiding screens with CSS and letting all of them stay bound.** `data-if`
  mounts and unmounts; a screen that is not showing does not exist in the DOM.
- **Keeping the filter in a JavaScript variable "because it's just UI".** It is
  application state with a short lifetime. It belongs in `State`.
- **Assuming this gives you Back.** It does not, on purpose. Routing is
  [08-routing](../08-routing/).

## Related

- [docs/08-multi-screen-applications.md](../../docs/08-multi-screen-applications.md)
- [08-routing](../08-routing/)
