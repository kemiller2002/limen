# Navigation lifecycle, deep links, and GitHub Pages

**What this answers:** the exact order a navigation happens in, why there is
only one source of truth for the URL, and how to deploy a routed Limen
application where deep links actually work.

Routing itself — typed routes, parsing, formatting — is in
[08-multi-screen-applications.md](08-multi-screen-applications.md#putting-the-url-in-step).
This page is about the lifecycle and the deployment.

---

## Who owns what

| | Owns |
| --- | --- |
| **The browser** | the URL bar, the session history, the back/forward stack, and the execution of every History API call |
| **Limen** | the translation across the boundary: normalizing a location, performing a requested history operation, reporting what the browser did |
| **The application engine** | what a route *means*, which routes are legal, parsing, formatting, redirects, and every state transition a route causes |

The kernel never parses a URL for meaning. The engine never touches
`location` or `history`. Both halves are enforced mechanically by
`scripts/check-architecture.ts`.

---

## The two lifecycles

There are exactly two, they run in opposite directions, and keeping them
separate is what stops the URL and the application from disagreeing.

### Engine-initiated: the application decides to move

```text
SemanticEvent (a click, a link, a form)
    ↓
engine validates the move and transitions its own state
    ↓
Navigate { operation: "push" | "replace", url }
    ↓
kernel → history.pushState / replaceState
    ↓
NavigationResult { Success, url }
```

The engine's state changes **here**, in the transition, not later. The browser
does not report a `pushState` back — `pushState` and `replaceState` do not
fire `popstate`, by specification — so there is nothing to wait for and
nothing that could arrive twice.

### Browser-initiated: the browser moves the user

```text
Back / Forward / an edited hash
    ↓
popstate
    ↓
kernel → SemanticEvent { name: <your historyEvent>, value: <the new URL> }
    ↓
engine parses the URL and transitions
```

Here the browser is authoritative and the engine catches up. **It must not
push.** Pushing in response to a history event is the classic routing bug: Back
returns the user to where they just were, and Forward is destroyed.

### Why this is not two sources of truth

Each direction has exactly one path, and the paths cannot both fire for the
same movement:

| Movement | Who changes engine state | Does `popstate` fire? |
| --- | --- | --- |
| Engine pushes or replaces | the transition that requested it | **No** — by specification |
| User presses Back/Forward | the history event | Yes |
| Engine requests `back`/`forward` | the history event that follows | Yes |

That last row is the one worth reading twice. When the engine asks for a
traversal, it does **not** update its own state — it cannot, because it does
not know where the traversal will land. The result comes back as
`Accepted`, meaning only "the browser has been asked", and the real answer
arrives afterwards as an ordinary history event. One movement, one path.

This is the deduplication model. There is no correlation machinery because
none is needed: the shapes make double-handling unrepresentable rather than
detectable.

---

## `push` versus `replace`

| | Adds a history entry | Use for |
| --- | --- | --- |
| `push` | yes | the user chose to go somewhere they may want to come back from |
| `replace` | no | correcting or canonicalizing a URL that should never be a stop on the back button |

**Push:** Home → Docs, Docs → an example, a list → a detail page.

**Replace:** an invalid route corrected to a canonical one, a legacy URL
rewritten to the current one, a post-login redirect being normalized, a
default query parameter being filled in.

Two rules that follow, and that the example enforces:

- **Navigating to where you already are is not a move.** Return no effect at
  all; otherwise clicking the current tab five times costs five presses of
  Back to escape.
- **Catching up with the browser never pushes.** Use `replace`, and only when
  the URL genuinely needs correcting.

Do not reach for `push` by default. An application that pushes indiscriminately
produces a back button the user cannot escape.

---

## `back` and `forward`

```ts
{ kind: "Navigate", correlationId, operation: "back" }
```

These exist so an application with an in-page Back button does not keep a
second history stack. **There is one history — the browser's.** Maintaining a
parallel application stack means two things that can disagree about where the
user has been, and they will.

The outcome is `Accepted`, never `Success { url }`. At the moment the kernel
returns, it genuinely does not know where the browser will land, or whether it
will move at all — the user may be at the end of the stack. Claiming a URL
there would be the kernel asserting something it cannot know.

---

## Initial load

`Initialize` carries `location` whenever navigation is wired:

```ts
case "Initialize": {
  if (message.location === undefined) return { view: project(state), effects: [], cancellations: [] };
  const screen = screenFor(message.location);
  // …start on that screen, and canonicalize the URL with `replace`
}
```

**Never assume the application starts at `/`.** A deep link, a refresh, a
bookmark, and a shared URL all start somewhere else, and they are the normal
case rather than the exception.

The location rides on `Initialize` rather than arriving as an event
immediately after it so the engine can choose its *initial* state. Delivered
one message later, every deep link would render the default screen and then
visibly correct itself.

---

## Link interception

Off by default. Switch it on by naming the event:

```ts
navigation: { historyEvent: "urlChanged", linkEvent: "linkActivated" }
```

The kernel then takes **only** clicks it is confident the browser has nothing
better to do with. Everything below is left entirely alone:

| Left to the browser | Why |
| --- | --- |
| Ctrl / Cmd / Shift / Alt click | each means "open this somewhere else" |
| Middle-click, right-click | new tab, context menu |
| A different origin | not ours to route |
| `mailto:`, `tel:`, any other scheme | belongs to the OS |
| `download` | the browser downloads better than we do |
| `target` other than `_self` | a deliberate instruction |
| `rel="external"` | an explicit opt-out |
| `data-native-link` | an explicit opt-out you can write |
| An anchor with no `href` | not a link |
| A click something else already handled | do not handle it twice |

**A Ctrl-click must still open a new tab. Middle-click must still work.** An
interceptor that swallows those is experienced by the user as a broken page,
and it is the single most common way client-side routing degrades a site.

The kernel does **not** navigate on an intercepted click. It calls
`preventDefault` and reports the href as an event; the engine decides whether
that destination means anything. A link to an unknown route simply does
nothing — which is the correct outcome for a dead link, and is why the example's
route parser returns `null` rather than falling back to Home when resolving a
link.

Use real `<a href="…">` elements with real destinations. They work with
JavaScript disabled, they can be copied and opened in a new tab, and screen
readers announce them as links. Interception is an enhancement on top of a
page that already worked.

---

## Deploying: deep links must load

This is where routed applications break in production, and the failure is
always the same: `/docs/getting-started` works when you click to it and 404s
when you paste it into a fresh tab.

### The Limen site: static pages, no router

The documentation site is **not** a single-page application and does not use
client-side routing at all. `scripts/build-site.ts` emits one real HTML file
per page, each with its own URL and entirely relative links:

```text
dist-site/index.html
dist-site/architecture.html
dist-site/demos.html
dist-site/docs.html
…
```

Every one of those is directly loadable, bookmarkable and shareable because it
is a **file that exists**. There is no fallback to configure, no 404 hack, and
no hash in any URL. Limen runs on top of those pages to drive the interactive
parts; it does not route between them.

This is the recommended strategy, and it is recommended for a reason worth
stating plainly: **a documentation site does not need client-side routing, and
adding it would make deep links strictly less reliable than they are now.**
The architecture already says so — HTML owns structure, Limen owns behaviour —
and a site that turns its own pages into engine state is not dogfooding the
architecture, it is contradicting it.

### The three options, and when each applies

| Option | Deep links | Use when |
| --- | --- | --- |
| **A. Static page paths** | Work natively | You can generate a real file per route. **Prefer this.** |
| **B. Client routing + host fallback** | Work, if the host rewrites unknown paths to `index.html` | Routes are dynamic or unbounded (`/invoices/1042`) and you control the host |
| **C. Hash routing** (`#/customers`) | Always work | You cannot configure the host, and the URL aesthetics are an acceptable price |

**GitHub Pages does not provide SPA route fallback.** Requesting a path with
no matching file serves the 404 page. The common workaround — copying
`index.html` to `404.html` and recovering the intended path from the URL —
works, but it means every deep link is served with an HTTP 404 status, which
is bad for crawlers, bad for monitoring, and a genuine lie about what happened.
Do not adopt it to avoid generating files.

**Option C is not a default.** Example 05 uses hash routes so it runs from any
static file server with no configuration, and that is a property of *the
example*, not a recommendation. Path routing is better wherever you can serve
it. Swapping the example between them is two pure functions:

```ts
// hash                                  // path
home: "#/",                              home: "/",
customers: "#/customers",                customers: "/customers",
```

Nothing else in the application changes. The kernel resolves whatever string
it is handed and reports whatever the browser ends up showing; it has no
opinion about which form you chose.

---

## Scroll, focus, and the document title

A route change is three things at once: the URL moves, the screen changes, and
the user needs to end up somewhere sensible. The third is the part applications
usually forget.

### The document title is a projection, not an effect

```html
<title data-text="pageTitle">Fallback title</title>
```

```ts
pageTitle: TITLES[state.screen],
```

That is all. The kernel binds the document **head** as well as the body, and
`document.title` reflects the `<title>` element's text content, so an ordinary
`data-text` binding sets the real browser tab title.

**There is deliberately no `setTitle` capability**, because a title is a
*function of state*, not an action. As a projection it cannot drift: it changes
whenever the state it describes changes, and no transition has to remember to
fire anything. An imperative `setTitle` effect would have to be issued from
every path that changes the screen, and the one you forget is the bug.

This is the general rule for deciding between the two:

| | Use |
| --- | --- |
| Derivable from state at any moment | a **projection** (`data-text`, `data-bind-*`) |
| A one-shot thing that happens *at* a moment | an **effect** |

A head with no bindings is untouched, so this costs nothing for a page that
does not opt in.

### Focus and scroll are effects

They are the other side of that rule — "put the user at the top of the new
screen" happens once, at a moment the engine chooses. A projected
`focused: true` would re-fire on every round trip and fight the user for the
caret.

Enable them with the `document` capability:

```ts
new BrowserKernel(transport, document, {
  navigation: { historyEvent: "urlChanged" },
  document: { enabled: true },
});
```

```ts
{ kind: "Document", correlationId, operation: "focusTarget" }
{ kind: "Document", correlationId, operation: "scrollToTop" }
```

**Neither names an element.** Mark the target in markup instead:

```html
<h2 data-focus-target data-text="screenHeading">Customers</h2>
```

The division is three-way, and it matters:

| | Decides |
| --- | --- |
| The engine | **when** focus should move |
| The markup | **where** it goes |
| The kernel | **how** — find the mounted target, make it focusable, focus it |

Passing a CSS selector instead would mean the engine knew there was an
`<h2 id="main-heading">` on the Customers screen —
[01-architecture.md](01-architecture.md) says the engine never sees a DOM node
or an element id, and that would break it.

The kernel adds `tabindex="-1"` if the target does not already have one. A
heading is not focusable by default, so `focus()` on one does **nothing at
all** — precisely the silent no-op that lets this class of accessibility bug
survive review. If no marked element is mounted, the outcome is
`Failure { reason: "no-target" }` rather than silence, because that almost
always means the markup is missing the attribute.

Hide the focus ring for pointer users but keep it for keyboard users:

```css
[data-focus-target]:focus { outline: none; }
[data-focus-target]:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
```

### When to fire them

Three arrivals, three different answers. Example 05 encodes exactly this:

| Arrival | Move focus? | Reset scroll? |
| --- | --- | --- |
| **Initial load**, including a deep link | **No** | No |
| **The user navigated** (a tab, a link) | Yes | Yes |
| **The browser moved** (Back / Forward) | Yes | **No** |

**Initial load must not steal focus.** The user has not navigated yet; moving
focus on load jumps them past the skip link and the header they were one Tab
away from. Note that a deep link *does* change the screen — it arrives at
Settings from an initial state of Home — so a rule keyed only on "did the
screen change" gets this wrong. Distinguish arriving from navigating:

```ts
type Arrival = "initial" | "user" | "history";

function arrivalEffects(correlationId: CorrelationId, cause: Arrival): readonly EffectRequest[] {
  if (cause === "initial") return [];
  const focus = { kind: "Document", correlationId, operation: "focusTarget" } as const;
  return cause === "user"
    ? [{ kind: "Document", correlationId, operation: "scrollToTop" }, focus]
    : [focus];
}
```

**Focus moves on Back and Forward too.** Leaving a screen destroys its DOM, so
focus would otherwise fall to `<body>` and a screen-reader user would get no
indication that anything happened. Focusing the new heading announces it, which
is the entire point — no extra `aria-live` region is needed for the route
change itself.

**Scroll resets only when the user navigated.** `pushState` deliberately does
not scroll, so a new screen would otherwise open halfway down. But browsers
already restore scroll for history traversal (`history.scrollRestoration`
defaults to `"auto"`), and doing it again by hand throws away the position the
user came back to see. There is no scroll-restoration capability, and that is
the reason: the native behaviour is the correct behaviour.

### One trap worth knowing

An effect result is a round trip, and every response carries a **complete**
`ViewState`. A response that acknowledges a focus effect by re-projecting a
*different* screen will unmount the element that was just focused. Keep the
projection stable across the acknowledgement — which it is, if you project from
state rather than from the message you happen to be handling.

## Related

- [08-multi-screen-applications.md](08-multi-screen-applications.md) — typed routes, parsing, formatting
- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — the Navigation effect
- [25-browser-capabilities.md](25-browser-capabilities.md) — every capability in one place
- [11-api-reference.md](11-api-reference.md) — the types
