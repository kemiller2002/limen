# Routing

> **Optional — not Limen Core.** This is the routing library, an engine library. It composes with the Core concept `engine-owns-meaning`: what a URL means is engine state; the built-in Navigation family moves the browser. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

How a Limen application routes (kemiller2002/limen#20, LCP-005). Routing is
**application meaning**: which screen a URL names, whether its identifier is
valid, where an old URL now lives, and whether this user should see the page.
So it is decided in the engine. The browser side stays mechanism:

| Side | Does |
| --- | --- |
| Kernel (Core) | reports the location in `Initialize` and in `LocationChanged` (Back, Forward), and performs `Navigation` effects: `push`, `replace`, `back`, `forward` |
| Engine | resolves locations, keeps the current location as state, and decides which effect, if any, to request |

The kernel never parses a route, and no routing type is a Limen protocol
type.

**Navigable state in the URL (0.9.0).** Every portfolio application keeps
its navigable state in the URL, so that a copied URL opens the same view: the
route, entity identifiers, and view parameters such as date or period,
filters, sort, tab and page. Two conforming libraries do it, at the npm
package's version:

- **F#:** `EchelonFoundry.Limen.Routing`
  ([`libraries/fsharp/Limen.Routing`](../libraries/fsharp/Limen.Routing));
- **TypeScript:** `@echelon-foundry/limen/routing` ([`src/routing`](../src/routing)).

The requirements are
[LCP-088..112](https://github.com/kemiller2002/limen/blob/main/docs/requirements/LIMEN-URL-STATE-REQUIREMENTS.md),
and the decisions are in
[DF-LIMEN-2026-0006](https://github.com/kemiller2002/limen/blob/main/research/decisions/DF-LIMEN-2026-0006--url-state-hash-routing-and-route-inventory.md).
The [URL-state guide](#url-state-the-guide) below is how to use them.

## One set of semantics, any language

The rules are defined once, independent of any language:

- [`conformance/routing/README.md`](../conformance/routing/README.md) states
  them in prose;
- [`conformance/routing/routing.vectors.json`](../conformance/routing/routing.vectors.json)
  states them as data: 40 resolutions, 12 builds and a nine-step
  deep-link / navigate / Back / Forward session;
- [`conformance/routing/url-state.vectors.json`](../conformance/routing/url-state.vectors.json)
  adds the URL-state semantics as 104 more vectors: typed view parameters,
  defaults and the canonical form, definitions, legacy entries, refinements,
  return targets, locations and links, outcomes and the route inventory.

They cover:

- nested and static segments;
- typed path and query parameters, with deterministic failures;
- wildcard fallback;
- redirects with loop rejection;
- resource preconditions (`requires`);
- guards as engine decisions;
- canonical link building;
- adoption of deep links and history moves.

A library in any guest language conforms by producing exactly the vectors'
results. Its API may look however suits the language.

## The F# reference library

[`libraries/fsharp/Limen.Routing`](../libraries/fsharp/Limen.Routing) is the
first conforming implementation. It is an **engine library**: pure,
depending on nothing but FSharp.Core and text encoding. `check:layers`
refuses any browser, interop, network, filesystem or process authority in it.
`npm run test:libraries` (part of `test:guests` in CI) runs every vector
against it. It ships as the NuGet package `EchelonFoundry.Limen.Routing`, a
Sigstore-attested asset of each GitHub release, at the npm version. Its
[README](../libraries/fsharp/Limen.Routing/README.md) shows the typed codec.

```fsharp
open Limen.Routing

let table =
    [ Route.create "home" ""
      { Route.create "invoices" "invoices" with
          Children =
            [ Route.create "list" ""
              { Route.create "invoice" "{id:int}" with
                  Requires = [ "invoice" ]
                  Children = [ Route.create "summary" ""; Route.create "history" "history" ] } ] }
      { Route.create "admin" "admin" with Guard = Some "adminOnly" }
      Route.create "notFound" "{*rest}" ]

// A guard is interface policy the engine decides, not security: the server
// still refuses whatever this user may not do.
let guard name (candidate: Match) =
    match name with
    | "adminOnly" when not state.IsAdmin -> GuardDecision.Deny
    | _ -> GuardDecision.Allow

// Initialize (a deep link) and LocationChanged (Back, Forward): adopt.
// Never a push; at most a replace to the canonical URL.
let routerState, resolution, effect = Navigation.adopt table guard routerState "/invoices/42/history"

// A click in the application: navigate. A push, unless it is already current.
let navigated = Navigation.navigate table routerState "invoices.invoice.summary" (Map [ "id", Value.Integer 42L ]) Map.empty
```

The engine maps the returned `NavigationEffect` onto the core `Navigation`
effect request, and a `Resolution` onto its own state and projection. For
example, `Invalid` renders an error for a malformed identifier, and `Denied`
renders a refusal. The library performs nothing itself.

## What the acceptance criteria mean in practice

| Criterion | How it holds |
| --- | --- |
| Pure and testable without a browser | The library has no authority to lack; the vectors run under `dotnet run` with no browser. |
| `LocationChanged` never causes a redundant push | `adopt` has no push branch. A replace happens only when the canonical form differs. The session vectors cover deep link, repeat navigation, Back and Forward. |
| Malformed parameters fail deterministically | A non-canonical int, one beyond 53-bit safety, an ambiguous repeated query key, a missing required key, a bad escape and invalid UTF-8 each have one specified result. The first structural match decides, so an invalid identifier never slides to the not-found page. |
| Guards reject or redirect without becoming an authorization boundary | A guard is an engine callback returning `Allow`, `Deny` or `Redirect`. Guard redirects share the redirect loop rule. This document and the semantics state that the server remains the authority. |

The TypeScript library [`@echelon-foundry/limen/routing`](../src/routing)
passes the same vectors (`test/routing.test.ts`). The example
[`examples/08-routing`](../examples/08-routing) uses it in hash mode, and
`test/browser/packs/url-state` proves the URL-state behaviour in real Chromium
and WebKit on a static host that answers 404 for every path it has no file
for.

## URL state: the guide

What to put in the URL, and how the libraries keep it there. The names are
TypeScript's (`@echelon-foundry/limen/routing`). F# has the same operations
under `RouteTable`, `RouteCodec`, `Navigation`, `Location`, `ReturnTo`, `Link`
and `Inventory`.

### What goes in the URL

Navigable state is what a person expects a link, a bookmark, Back, Forward or
a reload to bring back:

- the route (which screen);
- identifiers (which invoice);
- view parameters (date or period, filters, sort, tab, page).

Declare them in the table as typed parameters: `string`, `int`, `bool`,
`date`, `month`, `enum` and `set`. Give a parameter a `default` when it has
one. Resolution then reports the default, so the engine always sees the full
view state. Building omits it, so `page=1` never appears in a link.

Ephemeral interface state stays out of the URL: an open menu, a hover, an
unsaved draft, a toast.

One view has **one** canonical location:

- declared parameters only, parent first, in declaration order;
- defaults omitted;
- set members sorted and de-duplicated;
- `%20` with upper-case hex, never `+`.

`format(parse(u))` is that canonical form. Equal views have equal URLs, so a
navigation to the current view is no navigation.

### Hash routing on static hosts

The default **location mode is hash**. The routed location is the fragment,
`#/invoices/42?tab=history`, and the document's own path and query are left
alone. This is what makes a static host such as GitHub Pages work:

- **Reloads:** the fragment never reaches the server, so a reload of any deep
  link loads `index.html` with a `200`, never a `404`.
- **Links:** links are relative (`hrefFor` gives `#/invoices/42`), so no
  `<base href>` and no knowledge of the site's sub-path is needed.

A **path mode** exists for hosts that serve the application at every path. It
is only a value passed to `locationFromBrowser`, `hrefFor` and `shareLink`;
nothing else changes. The `404.html` fallback was rejected
(DF-LIMEN-2026-0006). The browser proof `test/browser/packs/url-state`
reloads deep links in Chromium and WebKit on a server that answers 404 for
every other path.

In hash mode an in-page anchor (`#section`) is not a URL fragment any more.
Move focus and scroll with the focus capability (docs/30). Render in-app
links with real `href`s from `hrefFor`, so that open-in-new-tab, middle-click
and copy-link-address keep working. A click on such a link reaches the engine
as `LocationChanged`, which it adopts.

### Push, replace, adopt

| Operation | When | Effect |
| --- | --- | --- |
| `navigate` | the person goes somewhere: another screen or entity | `push`, or nothing when already there |
| `refine` | the same view changes in place: a filter, sort, page, tab or date | `replace`, or nothing when unchanged |
| `adopt` | the browser reports a location (`Initialize`, `LocationChanged`) | `replace` to the canonical form when it differs, else nothing; **never a push** |

So Back steps between *places*, not between filter clicks. A refinement still
changes the URL, so a copied link and a reload keep it. The engine decides
which operation an interaction is. The library does not guess from which
parameters changed, because another invoice and another page of invoices
both change only parameters.

The kernel writes no history state, and the libraries do not depend on any.
The engine rebuilds its navigable state from the location alone after Back,
Forward, a reload or a deploy.

### Outcomes

Resolution through the typed codec (`createRouteCodec`, `RouteCodec.create`)
gives the application's own route or a closed `RouteError`. Render every case,
and keep the URL:

| Outcome | Render |
| --- | --- |
| `NotFound` (including a match of the table's `notFound` route) | a not-found view with a way home |
| `NotPermitted` | a not-permitted view, distinct from not found, with a way to sign in when signed out |
| `Invalid`, `Malformed` | an invalid-link view naming the parameter (or `path`, `query`, `length`) |
| `RedirectLoop` | a configuration-error view |
| `Unmapped` | the application's own mapping refused a match: treat as not found, or fix the mapping |

None of them is a blank page or another route's view. A resource the server
refuses (`403`) or cannot find (`404`) after a match maps to the same
`NotPermitted` and `NotFound` views.

### Guards are not security

A guard (`Allow`, `Deny`, `Redirect`) decides what the **interface** shows.
It is not an authorization boundary. The server must refuse whatever this
person may not do, however the request arrives: a URL is input from anyone
who can send a link.

### A deep link through sign-in

When a route needs a signed-in person and none is signed in, the guard
redirects to the sign-in route, carrying the target in that route's own query
parameter. The target survives a reload of the sign-in page and needs no
storage:

```text
#/reports/2026-10?tags=a,b   →   #/sign-in?returnTo=%2Freports%2F2026-10%3Ftags%3Da%2Cb
```

1. `captureReturnTo(table, location)` gives the canonical target. Guards are
   not consulted here.
2. After sign-in, `resumeReturnTo(table, target, guard)` gives the location to
   **replace** to, so Back does not return to sign-in. It goes home instead
   when the target is:
   - absent;
   - not a single-slash relative location (`//evil.example`, `https://…`,
     `\`, an encoded `//`, `javascript:`, a control character);
   - the sign-in or not-found route, or a route marked `returnTarget: false`;
   - refused by the guards, which are run again.

That closes the open redirect. The return target is a location, never a
credential.

### Copy link

`shareLink(page, location)` gives the absolute URL of the canonical location:
the page's origin, its document path and query (whatever sub-path it is
served under), and the routed location in the current mode. The engine
writes it with the Core `Clipboard` effect and renders the typed outcome
(copied, or why not). The shared URL carries no credential and no return
target.

### Legacy routes

When a route is renamed, declare the old pattern as a legacy entry
(`{ path, to, params }`). Resolution follows it as a redirect, and `adopt`
replaces the address bar with the current canonical location. Legacy entries
are listed in the inventory and never produced by `format`. They live inside
the routed location. A path URL that a static host answered with 404 before
the application loaded cannot be redirected by the application (LCP-112).

### The route inventory

`renderRouteInventory(table)` (F#: `Inventory.render`) produces
`echelon.routes/v1`. An application writes it to `.echelon/routes.json`. The
output is byte-identical between the two libraries: keys sorted, two-space
indentation, a final newline. It lists:

- the mode and the home, sign-in and not-found routes;
- every destination with its pattern, typed parameters, guards, `requires`
  and whether it may be a return target;
- every legacy entry.

Its JSON Schema ships in the npm package as
`@echelon-foundry/limen/contract/routes.schema.json`. Praxis
(`praxis foundations verify`) and Conditor validate the file without running
the application.

### No secrets in URLs

URLs end up in browser history, server and proxy logs, `Referer` headers,
screenshots and chat. So a URL MUST NOT carry secrets, tokens or sensitive
personal data: names, email addresses, or free text a person typed about
someone. Carry identifiers and view parameters only.

Both libraries refuse a table that declares a parameter named like a
credential. The comparison ignores case, `-` and `_`, and the refused names
are:

- `token`, `access_token`, `id_token`, `refresh_token`;
- `password`, `passwd`, `secret`, `client_secret`;
- `api_key`, `key`;
- `session`, `session_id`;
- `auth`, `authorization`;
- `code`, `credential`, `credentials`.

After an OAuth redirect, the authentication library removes the parameters
it consumed from the document query with a `replace`. The routing library
never reads them.

