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

**What comes next (0.9.0).** Every portfolio application must keep its
navigable state in the URL, so that a copied URL opens the same view. The
requirements for that are
[LCP-088..112](https://github.com/kemiller2002/limen/blob/main/docs/requirements/LIMEN-URL-STATE-REQUIREMENTS.md),
not yet built: typed view parameters with defaults and one canonical form, a
typed `parse`/`format` codec in F# and TypeScript, `refine` (replace) beside
`navigate` (push), not-found and not-permitted outcomes, return targets
through sign-in, hash routing for static hosts such as GitHub Pages, legacy
redirects, copy link, a route inventory (`.echelon/routes.json`), and no
secrets in URLs. The decisions are in
[DF-LIMEN-2026-0006](https://github.com/kemiller2002/limen/blob/main/research/decisions/DF-LIMEN-2026-0006--url-state-hash-routing-and-route-inventory.md).

## One set of semantics, any language

The rules are defined once, independent of any language:

- [`conformance/routing/README.md`](../conformance/routing/README.md) states
  them in prose;
- [`conformance/routing/routing.vectors.json`](../conformance/routing/routing.vectors.json)
  states them as data: 40 resolutions, 12 builds and a nine-step
  deep-link / navigate / Back / Forward session.

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
against it.

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
