# Multi-screen applications

**What this answers:** how to structure an application with more than one screen,
and how to keep the URL and the browser's history in step with it.

Working example: [`examples/05-multi-screen/`](../examples/05-multi-screen/).

---

## Start with the shape

There is still no router. There is a **Navigation capability**: the engine says
where the application is, and the kernel owns the browser mechanism that makes
the address bar agree.

That split is the whole design, and it runs in both directions:

| The user does this | The kernel does | The engine decides |
| --- | --- | --- |
| Clicks a tab | dispatches the click as an ordinary `SemanticEvent` | which screen, and to **push** a history entry |
| Presses Back or Forward | dispatches a `SemanticEvent` carrying the new URL | what that URL means — and **not** to push |
| Opens or reloads a link | puts the URL on `Initialize.location` | the screen to start on |

The kernel never parses a URL for meaning, and the engine never touches
`location` or `history`. Neither side can do the other's job, which is why
there is exactly one answer to "which screen are we on" at any moment.

You still must not call `history.pushState` from page JavaScript. It was
already wrong — it puts navigation state outside the engine and creates exactly
the split-brain the architecture exists to prevent — and now there is a
supported way to do it.

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

## Putting the URL in step

Everything above works with no URL at all. Three additions give you real links.

### 1. Opt the kernel in

```ts
await new BrowserKernel(transport, document, {
  navigation: { historyEvent: "urlChanged" },
}).start();
```

The third argument also still accepts a bare `DiagnosticsSink`, which is what
it always meant; pass an options object when you want capabilities too.

`historyEvent` is the `SemanticEvent` name dispatched when the browser moves the
user through session history. **The kernel does not invent it.** You supply your
application's own word, the same way `data-event="navigate"` supplies one in
markup. Leave `navigation` out and nothing about the kernel changes: no
listener, no capability announced, no `location` sent.

### 2. Translate between URLs and screens — in the engine

Two pure string functions. No `location`, no `history`, nothing the engine is
forbidden to touch:

```ts
const ROUTES: Readonly<Record<Screen, string>> = {
  home: "#/", customers: "#/customers", settings: "#/settings",
};

export const urlFor = (screen: Screen): string => ROUTES[screen];

/** Every URL that is not a known route is Home. A route is evidence, not a command. */
export function screenFor(url: string): Screen {
  const name = url.slice(url.indexOf("#") + 1).replace(/^\/+/, "");
  return isScreen(name) ? name : "home";
}
```

**Hash or path?** The kernel does not care — it resolves whatever string you
hand it. Hash routes (`#/customers`) work from any static file server.
Path routes (`/customers`) are tidier but need the server to serve your
`index.html` for unknown paths, or a reload 404s. Example 05 uses hashes so it
runs anywhere; swapping the two functions above is the entire change.

### 3. Make "the user chose" and "the browser moved" different commands

This is the one rule that matters, and getting it wrong is the classic routing
bug: responding to Back by pushing a new entry, so Back puts the user straight
back where they were and Forward is destroyed.

Encode it in the command union rather than a comment someone has to remember:

```ts
export type Command =
  // The user chose to go somewhere: the move deserves a history entry.
  | { kind: "Navigate"; screen: Screen; correlationId: CorrelationId }
  // The browser already moved the user. Catch up; do NOT push.
  | { kind: "RestoreRoute"; screen: Screen }
  | /* … */;

export function eventToCommand(event: SemanticEvent, correlationId: CorrelationId): Command {
  switch (event.name) {
    case "navigate":
      return { kind: "Navigate", screen: validated(event.key), correlationId };
    case "urlChanged":                            // ← the name from step 1
      return { kind: "RestoreRoute", screen: screenFor(event.value ?? "") };
    /* … */
  }
}
```

Both commands land on the same screen. Only one asks for an effect:

```ts
case "Navigate": {
  // Not a move, so not a history entry — otherwise clicking the current tab
  // five times costs five presses of Back to escape.
  if (command.screen === state.screen) return { state, effects: [] };
  return {
    state: arriveAt(state, command.screen),
    effects: [{ kind: "Navigate", correlationId: command.correlationId,
                operation: "push", url: urlFor(command.screen) }],
  };
}

case "RestoreRoute":
  // No effect. The browser is already at this URL — it is what told us.
  return { state: arriveAt(state, command.screen), effects: [] };
```

### 4. Start from the URL, not from the default

`Initialize` carries `location` whenever navigation is wired. Use it to choose
the *initial* state, so a deep link renders the right screen first rather than
flashing the default and correcting itself:

```ts
case "Initialize": {
  // Absent means the host did not wire navigation. The app still works; it
  // just stays within one page load.
  if (message.location === undefined) return { view: project(state), effects: [], cancellations: [] };

  const screen = screenFor(message.location);
  state = arriveAt(state, screen);
  return {
    view: project(state),
    // Canonicalize what the address bar shows: no hash at all, or a hash
    // naming no screen, should still leave a URL that round-trips. `replace`,
    // because arriving somewhere is not a step the user can go Back from.
    effects: [{ kind: "Navigate", correlationId: next(), mode: "replace", url: urlFor(screen) }],
    cancellations: [],
  };
}
```

### push vs. replace

| | Adds a history entry | Use for |
| --- | --- | --- |
| `push` | yes | the user chose to go somewhere they may want to come back from |
| `replace` | no | correcting or canonicalizing a URL that should never be a stop on the back button |

Which one a change deserves is a domain decision, so the engine makes it.

### What can go wrong

`NavigationOutcome` has two cases, like `StorageOutcome` and unlike
`EffectOutcome` — `pushState` is synchronous and same-document, so there is no
"dispatched but uncertain":

```ts
| { kind: "Success"; url: string }
| { kind: "Failure"; reason: "unavailable" | "cross-origin" | "invalid-url" }
```

- **`unavailable`** — navigation was not wired, or `pushState` is blocked
  (a sandboxed frame, an opaque origin, some browsers on `file://`).
- **`cross-origin`** — the kernel refuses to move the page off its own origin,
  whatever the engine asks for. An engine, or a value that reached one, must
  not be able to use this effect to send the user to another site.
- **`invalid-url`** — the string would not resolve against the current location.

A refused navigation means the address bar and the application now disagree.
That is worth projecting — a quiet failure here is a user who bookmarks the
wrong page. Example 05 acknowledges the result without surfacing it, and says
so in a comment, because inventing an error banner would obscure what it is
teaching; a real application should do better.

### Deciding whether URLs are even available

`Initialize` announces what this kernel can actually do:

```ts
capabilities: readonly Capability[]   // "Http" | "Storage" | "Navigation"
```

`"Navigation"` is present only when the host wired it, so an engine can tell
rather than assume. `location` is present on exactly the same condition.

### What this deliberately does not do

**It does not intercept `<a href>` clicks.** The responsibility spec's §28 says
to prefer native links and not to replace browser behavior unless application
semantics require it, and a blanket anchor interceptor would also swallow
in-page fragment links, downloads and `mailto:`. Navigate with a `data-event`
on a button, as everything above does; leave anchors to the browser. An in-app
`<a href="#/customers">` is not broken by this — it is a same-document move, so
it fires the history event and your engine handles it like any other.

**There is no engine-driven `back` or `forward`.** The browser's own buttons
already reach the engine through the history event. No feature has needed the
engine to *drive* a traversal, and building it before one does would be
untested surface with nothing to validate the design against — the same rule
[ROADMAP.md](ROADMAP.md) applies to every deferred capability.

**Scroll position is not restored.** Leaving a screen destroys its DOM, and
nothing puts the scroll offset back. If it matters, it is engine state like
anything else that outlives the DOM.

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
