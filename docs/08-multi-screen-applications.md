# Multi-screen applications

**What this answers:** how to structure an application with more than one screen,
and what routing support does and does not exist.

Working example: [`examples/05-multi-screen/`](../examples/05-multi-screen/).

---

## Start with the limitation

**There is no router, and no browser-history integration.** ROADMAP item 8 is
deferred. Concretely:

- The URL does not change when the screen does.
- Back and forward do not navigate between screens. Back leaves the application.
- Screens are not linkable, bookmarkable, or shareable.
- There is no `popstate` handling, because the kernel has no navigation
  capability at all.

If your application needs real URLs, this kernel does not provide them today.
Adding them is a protocol extension (a Navigation capability) plus an
`EffectRequest` variant — see
[15-recipes.md](15-recipes.md#add-a-new-browser-capability). Do not work around
it by calling `history.pushState` from page JavaScript: that puts navigation
state outside the engine and creates exactly the split-brain the architecture
exists to prevent.

What *is* supported is multiple screens within one page load. That is what
follows.

---

## A screen is a value in state

There is no screen abstraction, no component, no mount lifecycle. A screen is a
field:

```ts
export const SCREENS = ["home", "customers", "settings"] as const;
export type Screen = (typeof SCREENS)[number];

export type State = {
  readonly screen: Screen;
  readonly displayName: string;      // shared
  readonly customerFilter: string;   // local to Customers
  readonly settingsDraft: string;    // local to Settings
};
```

Navigation is an ordinary transition, which means it obeys every ordinary rule —
it can be rejected, it is pure, and it is testable without a browser.

---

## Markup: one `data-if` per screen

```html
<template data-if="onHome">
  <section class="panel">
    <h2>Home</h2>
    <p data-text="greeting"></p>
  </section>
</template>

<template data-if="onCustomers">
  <section class="panel">
    <h2>Customers</h2>
    <input id="filter" data-event="filterCustomers" data-on="input" data-bind-value="customerFilter">
    <ul class="list">
      <template data-each="customers" data-key="id">
        <li data-text="name"></li>
      </template>
    </ul>
  </section>
</template>
```

```ts
onHome:      state.screen === "home",
onCustomers: state.screen === "customers",
onSettings:  state.screen === "settings",
```

Exactly one is truthy, so exactly one section exists in the DOM at a time —
asserted by the test suite. The others are not hidden; they are **not there**.

### Consequence: leaving a screen destroys its DOM

Focus, scroll position, caret, and uncommitted input inside that screen are
gone. Anything that must survive navigation has to be in engine state, because
that is the only thing that outlives the DOM.

This is a feature, not a cost: it makes "what survives navigation?" an explicit
decision rather than an accident.

---

## Navigation via `data-each`

For a set of screens, project the nav and let each item carry its own key:

```ts
navItems: SCREENS.map((screen) => ({
  id: screen,
  label: LABELS[screen],
  active: screen === state.screen,
})),
```

```html
<nav class="nav">
  <template data-each="navItems" data-key="id">
    <button data-event="navigate" data-text="label" data-bind-aria-current="active"></button>
  </template>
</nav>
```

A click sends `{ name: "navigate", key: "customers" }`. Adding a screen means
adding it to `SCREENS` — the markup does not change.

**Validate the key.** It arrives as a string from the DOM:

```ts
case "navigate": {
  const target = event.key ?? "";
  if (!isScreen(target)) throw new Error(`Unknown screen: ${target}`);
  return { kind: "Navigate", screen: target };
}
```

### The simpler alternative

For two or three fixed screens, distinct event names are perfectly good and need
no key validation:

```html
<button data-event="goHome">Home</button>
<button data-event="goSettings">Settings</button>
```

Use `data-each` when the set is dynamic or you want CSS to react to `active`.

---

## Shared vs. screen-local state

Both live in the same state value. "Screen-local" is a **lifetime**, and the
lifetime is enforced in one place:

```ts
case "Navigate": {
  if (command.screen === state.screen) return state;
  return {
    ...state,
    screen: command.screen,
    // Leaving a screen discards its local state. A deliberate domain decision
    // written down once — not an accident of components unmounting.
    customerFilter: "",
    settingsDraft: state.displayName,
  };
}
```

Want the filter to survive? Delete one line. There is nowhere else to change.

Guard screen-local commands so they cannot fire from the wrong screen:

```ts
case "FilterCustomers":
  return state.screen === "customers" ? { ...state, customerFilter: command.value } : state;
```

The markup already makes it impossible — but see
[04-state-model.md](04-state-model.md#but-the-button-was-disabled--why-check).

---

## Structuring a larger application

The single `State` union grows. Organize by file, not by inventing a second
runtime mechanism.

```text
src/engine/
  state.ts          the top-level State type and initial value
  navigation.ts     Screen union, navigate transition
  screens/
    customers/
      state.ts      CustomersState and its commands
      transition.ts pure transitions for this screen
      project.ts    this screen's slice of the ViewState
    settings/
      ...
  project.ts        composes the per-screen projections into one ViewState
  transport.ts      the single dispatch entry point
```

Compose the projection:

```ts
export function project(state: State): ViewState {
  return {
    ...projectNavigation(state),
    ...(state.screen === "customers" ? projectCustomers(state.customers) : {}),
    ...(state.screen === "settings"  ? projectSettings(state.settings)   : {}),
  };
}
```

### Careful: conditional spreading and missing keys

The snippet above omits keys when a screen is not active. That is safe **only**
because those keys are bound inside that screen's `data-if` template, which is
unmounted at the time — an unmounted binding is never applied.

A `data-text` binding *outside* any `data-if` whose key disappears throws
`BridgeError { phase: "projection" }` and aborts the round trip. Two safe rules:

- Keep every conditionally-projected key inside its screen's `data-if`, or
- project every key in every branch, using empty defaults.

Prefix keys per screen (`customersFilter`, `settingsDraft`) to keep collisions
from happening quietly.

---

## Loading data per screen

Navigation can request effects like any other transition:

```ts
case "Navigate": {
  const next = { ...state, screen: command.screen, /* … */ };
  return command.screen === "customers"
    ? { state: { ...next, customers: { kind: "Loading", correlationId } },
        effects: [{ kind: "Http", correlationId, method: "GET", url: "/api/customers", timeoutMs: 5000 }] }
    : { state: next, effects: [] };
}
```

Navigating away while a load is in flight is where **cancellation** earns its
place:

```ts
return {
  view: project(next),
  effects: [],
  cancellations: [inFlightCorrelationId],   // we no longer care about the answer
};
```

The result still arrives, as `{ kind: "Cancelled" }`, and your stale-result
guard discards it because the state is no longer waiting for it.

---

## Modals and overlays

A modal is not a screen. It is a boolean in state plus ordinary HTML and CSS:

| Concern | Belongs to |
| --- | --- |
| Whether the modal is open | engine state — project it |
| Whether "Confirm" is enabled | engine — project a capability |
| What the modal says | engine — project the text |
| Backdrop, centering, animation | CSS |
| Dismiss on Escape, focus trapping | native `<dialog>`, or CSS/HTML |
| Focus restoration on close | **not supported** — a known gap |

Prefer a native `<dialog>` with `data-bind-open="modalOpen"` — `open` is one of
the five boolean properties, and the browser handles the rest.

---

## Related

- [04-state-model.md](04-state-model.md) — shared vs. screen-local lifetimes
- [06-rendering.md](06-rendering.md) — `data-if` mechanics and costs
- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — cancellation
- [15-recipes.md](15-recipes.md) — add a screen, add a modal, add a capability
