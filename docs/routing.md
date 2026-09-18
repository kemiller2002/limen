# Routing

Limen's `Navigation` capability gives the engine the browser's history: push,
replace, back, forward, the URL the page was loaded at, and the moves the user
makes with the browser's own controls.

What it deliberately does not give you is a router. There is no route table, no
path-matching DSL, and no notion of a "page" inside the kernel. **What a URL
means is application meaning**, and it lives in your engine like every other
decision.

Worked example: [`examples/08-routing/`](../examples/08-routing/README.md).

> **Available since 0.6.0.** If you installed an earlier version, this
> capability does not exist in your copy: requesting the effect produces a
> `BridgeError` with `phase: "effect"` and **no result**, and an engine waiting
> on that correlation id waits forever. Check your installed version with
> `npm ls @echelon-foundry/typescript-wasm-kernel`.

---

## The shape of it

```text
Engine → Browser          Browser → Engine
──────────────────        ────────────────
Navigation push/replace   NavigationResult Success{ location }
Navigation back/forward   NavigationResult Dispatched
                          LocationChanged { location }   ← the browser moved on its own
Initialize                Initialize { location }        ← where the page was loaded
```

```ts
export type NavigationEffectRequest =
  | { kind: "Navigation"; correlationId; operation: "push";    url: string }
  | { kind: "Navigation"; correlationId; operation: "replace"; url: string }
  | { kind: "Navigation"; correlationId; operation: "back" }
  | { kind: "Navigation"; correlationId; operation: "forward" };

export type NavigationOutcome =
  | { kind: "Success"; location: BrowserLocation }
  | { kind: "Dispatched" }
  | { kind: "Failure"; reason: "unavailable" | "not-same-origin" };

export type BrowserLocation = {
  path: string;   // "/invoices/42"       — always begins with "/"
  query: string;  // "?tab=history" or "" — leading "?" included
  hash: string;   // "#totals" or ""      — leading "#" included
};
```

The kernel splits the URL and stops. It does not parse `/invoices/42`, and the
origin is deliberately absent from `BrowserLocation`: an engine that could read
it would be tempted to branch on it, and same-origin is enforced by the kernel
anyway.

## Typed routes

```ts
export type Route =
  | { readonly kind: "Home" }
  | { readonly kind: "Invoices" }
  | { readonly kind: "Invoice"; readonly id: string }
  | { readonly kind: "NotFound"; readonly raw: string };
```

`NotFound` is a route, not an error. A URL nobody recognises is an ordinary
place for a user to arrive at, and it gets a screen like any other. Leaving it
out means a `parseRoute` that either throws or lies.

An id that is *syntactically* valid but names nothing should also be
`NotFound` — otherwise you get an "Invoice" screen the projection has to
apologise for later.

## Parser and formatter, side by side

Keep them in one file, next to each other. That is what makes "does every route
round-trip?" a question a test can answer:

```ts
export function parseRoute(location: BrowserLocation): Route { /* … */ }
export function routeToUrl(base: string, route: Route): string { /* … */ }
```

```ts
test("every route round-trips through its URL", () => {
  for (const route of ALL_ROUTES) {
    assert.deepEqual(parseRoute(locationOf(routeToUrl(base, route))), route);
  }
});
```

## Composing a link someone can actually use

`Initialize.location` carries the **origin**, and that is the only reason an
engine can build an absolute URL at all:

```ts
export const shareUrl = (origin: string, base: string, route: Route): string =>
  `${origin}${routeToUrl(base, route)}`;
// → "https://example.com/app/?route=%2Finvoices%2F1002"
```

Capture the origin at `Initialize`, next to the base, and compose from state.
This is what makes "Copy link" possible — the combination of Navigation and
Clipboard, which is the main reason either capability exists. Worked example:
the `copyLink` command in
[examples/08-routing](../examples/08-routing/README.md).

Do **not** reach for `window.location` in the composition root and hand it to
the engine: it works, and it smuggles a browser value across the boundary
through a side channel nothing checks. The protocol carries it for you.

## When the URL names data you have not loaded yet

The advice above — an id that names nothing is `NotFound` — assumes
`parseRoute` can see the data. Often it cannot: the record arrives over HTTP
*after* the route is parsed. Deep-linking into fetched data is the common case,
and resolving it inside `parseRoute` is impossible.

Split the two questions:

```ts
// Syntactic only. Does this URL have the SHAPE of a customer route?
export function parseRoute(location: BrowserLocation): Route { /* … */ }

// Semantic, and derived from state — not from the URL.
export type Resolution =
  | { kind: "Pending" }                       // the fetch has not landed yet
  | { kind: "Found"; customer: Customer }
  | { kind: "Missing" }                       // loaded, and no such id
  | { kind: "Unavailable"; reason: string };  // the load failed; we cannot say
```

`NotFound` then means "this URL is malformed", and `Missing` means "this URL is
well-formed and names nothing". They read differently to a user and they recover
differently: the first is never going to work, the second might after a retry.

Projecting `Pending` honestly also stops the screen claiming a record is missing
during the second before it arrives.

## The asymmetry that matters

| Who moved first | Engine does | Effect requested |
| --- | --- | --- |
| The application (a click) | change the route **and** ask the browser to catch up | `push` (or `replace`) |
| The browser (Back, Forward) | adopt the new location | **none** |

Pushing in response to `LocationChanged` is the classic routing bug: Back fires
`popstate`, the engine pushes the old URL back onto the stack, and the user
cannot leave the page.

```ts
// RIGHT
case "LocationChanged":
  return respond(transition(state, { kind: "AdoptLocation", location: message.location }));
```

## push vs. replace

| Use | When |
| --- | --- |
| `push` | the user would expect Back to undo this — opening a record, changing screens |
| `replace` | the URL is being corrected rather than navigated — canonicalising a path, recording a filter the user did not deliberately navigate to, redirecting after a completed action |

Navigating to the route you are already on should be refused. It pushes a
duplicate history entry, and Back then appears to do nothing once per redundant
click.

## back and forward report `Dispatched`, not `Success`

`history.back()` only *asks*. Whether the browser moves — and where to — arrives
later as `LocationChanged`, or never, if there was no entry to go back to.
Reporting `Success` with a location would be a claim the kernel cannot support.

An engine should therefore **not** change its route when it asks to go back. It
changes when the move actually happens.

## The initial location

`Initialize` carries the URL the page was loaded at, so a routing engine picks
its first state from the address bar:

```ts
case "Initialize":
  state = { route: parseRoute(message.location), base: message.location.path, urlOutOfSync: false };
  return { view: project(state), effects: [], cancellations: [] };
```

Without this, every deep link renders the default screen for one frame and then
corrects itself — visible, and wrong if the default screen starts a fetch.

## Same-origin only

A `push`/`replace` to another origin is refused with
`Failure { reason: "not-same-origin" }` and the page does not move. Leaving the
origin ends the application and discards every piece of state the engine owns;
that is not a decision a projection should be able to make by accident.

To genuinely leave the site, use an ordinary `<a href>`. It needs no capability
at all.

## Two failures that are not the same failure

`Failure { reason: "unavailable" }` means the browser has no usable `history`.
`Failure { reason: "not-same-origin" }` means the engine asked to leave the
site. The first is an environment problem; the second is a **bug in your
engine**, because nothing should be composing an off-origin URL to push.

Projecting one "the URL could not be updated" message for both is convenient and
hides a real defect. If you only handle one, handle them separately in a
`switch` so the compiler tells you when a third appears.

## When a navigation fails

The screen still changed — the engine's route is authoritative — but the
address bar now disagrees with it. Say so rather than pretending:

```ts
case "RecordNavigation":
  return command.failed ? go({ ...state, urlOutOfSync: true }) : stay(state);
```

```html
<template data-if="urlOutOfSync">
  <p class="error" role="alert">The address bar could not be updated, so this link will not reopen this screen.</p>
</template>
```

## No history state is stored

The kernel passes `null` as `pushState`'s state object, always. The engine
already holds the state a URL stands for, and a copy living in the history
entry is a second source of truth that can disagree with it after a reload or a
deploy. On the way back, the engine re-derives from the URL — the only thing
the browser can be trusted to have preserved.

The practical consequence: **anything that must survive Back has to be
recoverable from the URL.** That is a design constraint, and a good one.

## Path routing vs. query routing, and static hosting

| | Path routing | Query routing |
| --- | --- | --- |
| URL | `/invoices/42` | `?route=/invoices/42` |
| Looks like | a normal site | obviously an application |
| Direct load / refresh | needs the server to serve `index.html` for unknown paths | works anywhere, unchanged |
| GitHub Pages | needs the `404.html` trick | works as-is |

Only `parseRoute` and `routeToUrl` differ between them. Everything else — the
union, the transitions, the projection — is identical, which is why
[08-routing](../examples/08-routing/README.md) uses query routing: it loads
correctly from any static host with no configuration, so the example works
where you run it.

**On GitHub Pages with path routing**, a direct load of `/invoices/42` returns
the 404 page, because no such file exists. The usual workaround is a `404.html`
that is a copy of `index.html`; the URL is preserved and your parser still sees
it. Test a *direct load and a refresh*, not just in-app navigation — in-app
navigation works in both configurations and hides the problem.

## Base paths

An application served from a subdirectory (`/my-app/`) must not push URLs at
the site root. Capture the base from `Initialize`:

```ts
base: message.location.path   // e.g. "/my-app/"
```

and build every URL from it. Forgetting this is the most common reason an
application works locally and breaks on GitHub Pages.

## Do you need routing at all?

Not every screen has earned a URL. A tab strip, a wizard step, a detail
pane — giving those URLs commits you to keeping them working forever.

Route a screen when it should be **linkable, shareable, or survive a reload**.
Otherwise screens are ordinary state:
[05-multi-screen](../examples/05-multi-screen/README.md) does exactly that, on
purpose.

## Common mistakes

| Mistake | What goes wrong |
| --- | --- |
| Pushing in response to `LocationChanged` | Back becomes impossible |
| `<a href>` for in-app navigation | full reload; all engine state discarded |
| Storing state in the history entry | a second source of truth that outlives its schema |
| Changing the route when asking to go `back` | the route changes even when the browser cannot move |
| Ignoring the base path | works locally, 404s on GitHub Pages |
| No `NotFound` route | `parseRoute` has to throw or lie |
| Re-navigating to the current route | duplicate history entries; Back looks broken |

## Related

- [examples/08-routing](../examples/08-routing/README.md) — the whole thing, running
- [traces.md](traces.md) — Back traced from `popstate` to the rendered screen
- [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) — the effect model
- [08-multi-screen-applications.md](08-multi-screen-applications.md) — screens without URLs
