# 08 — Routing

## What this demonstrates

URL-driven state, with the browser's history as a **capability** rather than an
authority. Typed routes, a parser, a formatter, Push, the browser's own Back
and Forward, and a URL that loads the right screen directly.

## Concepts

| Concept | Where to see it |
| --- | --- |
| Routes as a closed union, including `NotFound` | `Route` |
| Parse and format, side by side and round-trippable | `parseRoute`, `routeToUrl` |
| The initial screen comes from `Initialize.location` | the transport's `Initialize` case |
| An application-initiated move pushes | `Navigate` |
| A browser-initiated move adopts and pushes **nothing** | `AdoptLocation` |
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
State = { route: Route, base: string, urlOutOfSync: boolean }

Route = Home | Invoices | Invoice(id) | NotFound(raw)
```

`NotFound` is a route, not an error. A URL nobody recognises is an ordinary
place for a user to arrive, and it has a screen like any other.

`base` is the page's own path, captured at `Initialize`. Without it the example
would push URLs at the site root and break the moment it is served from a
subdirectory — which is how GitHub Pages serves everything.

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
  → parseRoute → state.route
  → NO effect                                  ← the address bar is already correct
```

**This asymmetry is the whole example.** Pushing a new URL in response to
`LocationChanged` is the classic routing bug: Back fires popstate, the engine
pushes the old URL back on, and the user cannot leave the page.

## Copy link — the one place two capabilities meet

This example deliberately breaks the one-example-one-lesson rule once, because
the combination is the point:

```ts
export const shareUrl = (origin: string, base: string, route: Route): string =>
  `${origin}${routeToUrl(base, route)}`;
```

`origin` arrives in `Initialize.location`, and it is the only reason an engine
can build an absolute link at all — a relative path is not something anyone can
share. The engine composes the link from state it already owns, projects it to
the screen, and copies **that same value**; the link a user sees and the link on
their clipboard cannot drift apart.

Composing a shareable link (Navigation) and putting it on the clipboard
(Clipboard) is the main reason either capability exists, so demonstrating them
only separately would leave the interesting part to guesswork.

## Path routing vs. query routing

This example puts routes in the query string (`?route=/invoices/1002`) so that
**any static host serves it correctly with no configuration**, including GitHub
Pages. Path routing (`/invoices/1002`) gives prettier URLs and requires the
server to return `index.html` for unknown paths.

Only `parseRoute` and `routeToUrl` differ between the two. Everything else in
this file — the union, the transitions, the projection — is identical.

## How to run it

```sh
npm install && npm run build && npm run build:examples
python3 -m http.server 4173
```

Then open <http://localhost:4173/examples/08-routing/>.

## Expected behavior

| You do | You see |
| --- | --- |
| Click Invoices, then a row | the invoice screen; the URL gains `?route=/invoices/1001` |
| Press the browser's Back button | the previous screen, without a reload |
| Press Forward | the invoice screen again |
| Copy the URL into a new tab | that same invoice screen, directly |
| Edit the URL to `?route=/invoices/9999` | the Not found screen |
| Click Copy link, then paste | the absolute URL of the screen you are on |
| Click Copy link over plain `http://` on a non-localhost host | "Copy the link above manually" — no retry offered |
| Click Invoices twice | the second click does nothing, and Back still works |

## Exercises

1. Add a `?tab=` sub-route to the invoice screen. Decide whether it should
   `push` or `replace` — a tab the user did not intend to bookmark is usually
   `replace`.
2. Make an unknown invoice id load the list with a message instead of
   `NotFound`. Notice that this is a routing *policy* decision, and that it
   lives entirely in `parseRoute`.
3. Convert the example to path routing. Only two functions change; the server
   configuration is the hard part.

## Common mistakes

- **Pushing in response to `LocationChanged`.** See above. The test
  `08-routing: adopting a browser-originated location requests no navigation`
  exists to keep this from coming back.
- **Using `<a href>` for in-application navigation.** The browser would
  navigate on its own, discarding every piece of state the engine owns. Use an
  `<a href>` when you genuinely mean to leave the site — that needs no
  capability at all.
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
