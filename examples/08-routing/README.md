# 08 — Routing

## What this demonstrates

URL-driven state, with the browser's history as a **capability** rather than an
authority. Typed routes, a parser, a formatter, Push, the browser's own Back
and Forward, and a URL that loads the right screen directly.

It is built on the routing library
[`@echelon-foundry/limen/routing`](../../conformance/routing/README.md) in
**hash mode**: the routed location is the fragment, `#/invoices/1002`. The
route table is a value, and a typed codec maps it onto the example's own
`Route` union.

## Concepts

| Concept | Where to see it |
| --- | --- |
| Routes as a closed union, including `NotFound` and `InvalidLink` | `Route` |
| The URL space as a value, mapped onto `Route` by a typed codec | `defineRoutes`, `createRouteCodec` |
| Parse and format, side by side and round-trippable | `parseRoute`, `routeToUrl` |
| Real relative links (`#/invoices/1001`) next to the engine's own moves | the rows' `href` |
| The initial screen comes from `Initialize.location` | the transport's `Initialize` case |
| An application-initiated move pushes | `Navigate` |
| A browser-initiated move adopts and **never pushes** (at most a replace to the canonical form) | `AdoptLocation` |
| `back` is a request, not a result | `GoBack` → outcome `Dispatched` |
| A navigation that failed is admitted | `urlOutOfSync` |
| **Two capabilities at once** | `shareUrl`, `CopyLink` — composing an absolute link and copying it |

## Files

| File | Responsibility |
| --- | --- |
| [`index.html`](index.html) | one `data-if` section per screen |
| [`engine.ts`](engine.ts) | routes, parsing, state, projection |
| [`main.ts`](main.ts) | constructs the kernel and starts it |

## State model

```text
State = { route: Route, router: RouterState, page: PageLocation, copy: CopyState, urlOutOfSync: boolean }

Route = Home | Invoices | Invoice(id) | NotFound(raw) | InvalidLink(raw, parameter)
```

`NotFound` is a route, not an error. A URL nobody recognises is an ordinary
place for a user to arrive, and it has a screen like any other.

`router` is the routing library's navigation state: the location the engine
last adopted, pushed or replaced, so a move to where you already are is no
move. `page` is the page's own URL, captured at `Initialize`: a shared link
keeps its origin, path and query. Nothing else needs the sub-path the site is
served under, because every link and push is a relative fragment.

## Event flow — the application decides to move

```text
click "Invoices"
  → SemanticEvent { name: "goInvoices" }
  → Command Navigate(Invoices)
  → state.route = Invoices                    ← the engine's route is authoritative
  → effect Navigation { operation: "push", url }
  → kernel: history.pushState
  → NavigationResult { Success, location }    ← an acknowledgement; no state change
```

## Event flow — the browser moves on its own

```text
user presses the browser's Back button
  → popstate
  → kernel sends LocationChanged { location }
  → Command AdoptLocation
  → adopt → state.route
  → NO push                                    ← the address bar is already correct
                                                 (a replace only when it was not canonical)
```

**This asymmetry is the whole example.** Pushing a new URL in response to
`LocationChanged` is the classic routing bug: Back fires popstate, the engine
pushes the old URL back on, and the user cannot leave the page.

## Copy link — the one place two capabilities meet

This example deliberately breaks the one-example-one-lesson rule once, because
the combination is the point:

```ts
export const shareUrl = (page: PageLocation, route: Route): string => shareLink(page, routeToPath(route));
```

`page.origin` arrives in `Initialize.location`, and it is the only reason an engine
can build an absolute link at all — a relative path is not something anyone can
share. The engine composes the link from state it already owns, projects it to
the screen, and copies **that same value**; the link a user sees and the link on
their clipboard cannot drift apart.

Composing a shareable link (Navigation) and putting it on the clipboard
(Clipboard) is the main reason either capability exists, so demonstrating them
only separately would leave the interesting part to guesswork.

## Hash mode vs. path mode

This example puts routes in the fragment (`#/invoices/1002`) so that **any
static host serves it correctly with no configuration**, including GitHub
Pages: the fragment never reaches the server, so a reload of any deep link
loads this one `index.html`, and links need no `<base href>`
(DF-LIMEN-2026-0006). Path mode (`/invoices/1002`) gives prettier URLs and
requires the server to return `index.html` for every path.

The mode is a value passed to `locationFromBrowser`, `hrefFor` and
`shareLink`. Everything else — the table, the union, the transitions, the
projection — is identical.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/08-routing/>.

## Expected behavior

| You do | You see |
| --- | --- |
| Click Invoices, then a row | the invoice screen; the URL gains `#/invoices/1001` |
| Click a row's link, or open it in a new tab | the same invoice screen |
| Press the browser's Back button | the previous screen, without a reload |
| Press Forward | the invoice screen again |
| Copy the URL into a new tab | that same invoice screen, directly |
| Edit the URL to `#/invoices/9999` | the Not found screen, with the URL kept |
| Edit the URL to `#/invoices/abc` | the Invalid link screen, naming `id` |
| Edit the URL to `#/invoices/1001/` and reload | the invoice; the address bar is corrected to `#/invoices/1001` without a new history entry |
| Click Copy link, then paste | the absolute URL of the screen you are on |
| Click Copy link over plain `http://` on a non-localhost host | "Copy the link above manually" — no retry offered |
| Click Invoices twice | the second click does nothing, and Back still works |

## Exercises

1. Add a `tab` query parameter (an `enum` with a `default`) to the invoice
   route. Change it with the codec's `refine`, which replaces, so Back steps
   between invoices and not between tabs.
2. Make an unknown invoice id load the list with a message instead of
   `NotFound`. Notice that this is a routing *policy* decision, and that it
   lives entirely in `ofMatch`.
3. Switch to path mode. Only the mode value changes; the server
   configuration is the hard part.

## Common mistakes

- **Pushing in response to `LocationChanged`.** See above. The test
  `08-routing: adopting a browser-originated location never pushes`
  exists to keep this from coming back.
- **An `<a href>` that leaves the page.** A path link (`/invoices/1001`)
  reloads the document and discards every piece of state the engine owns. A
  fragment link (`#/invoices/1001`, from `hrefFor`) does not: the browser
  moves, and the engine adopts it.
- **Storing state in the history entry.** `pushState`'s state object is
  deliberately left `null`. The engine already owns the state the URL stands
  for; a second copy in the history entry can disagree with it after a reload
  or a deploy.
- **Letting the DOM decide which screen is visible.** The engine projects
  `onHome`/`onInvoices`/`onInvoice`/`onNotFound`; the DOM mounts whichever is
  true and never inspects the URL.
- **Navigating to the route you are already on.** It pushes a duplicate history
  entry, and Back then appears to do nothing.

## Related

- [docs/routing.md](../../docs/routing.md) — the capability in full, including
  GitHub Pages and direct loads
- [05-multi-screen](../05-multi-screen/) — screens without URLs, which is the
  right choice more often than people expect
