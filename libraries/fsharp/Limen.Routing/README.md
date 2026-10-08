# EchelonFoundry.Limen.Routing

URL state for Limen engines written in F#: the reference implementation of
Limen's language-neutral routing semantics
([`conformance/routing`](https://github.com/kemiller2002/limen/blob/main/conformance/routing/README.md),
LCP-005 and LCP-088..112). The TypeScript library
`@echelon-foundry/limen/routing` passes the same vectors, and both ship at the
same version.

It is an **engine library**: pure and total, depending on nothing but
FSharp.Core and the BCL's text encoding. It touches no browser. The Limen
kernel reports locations (`Initialize.location`, `LocationChanged`) and
performs the `Navigation` and `Clipboard` effects this library decides on.

```fsharp
open Limen.Routing

// The URL space as a value, validated when it is defined: every problem is a
// DefinitionError, never an exception.
let table =
    RouteTable.define
        [ Route.create "home" ""
          { Route.create "invoices" "invoices" with
              Query = [ QueryParam.optional "status" (ParamType.Set [ "open"; "paid" ]) ]
              Children =
                [ { Route.create "invoice" "{id:int}" with
                      Query = [ QueryParam.optional "tab" (ParamType.Enum [ "summary"; "history" ]) |> QueryParam.withDefault (Value.Text "summary") ] } ] }
          { Route.create "signIn" "sign-in" with ReturnTarget = false; Query = [ QueryParam.optional ReturnTo.parameter ParamType.String ] }
          Route.create "notFound" "{*rest}" ]
        [ { Path = "bills/{id:int}"; To = "invoices.invoice"; Params = [ "id", Template.FromParam "id" ] } ]
        { Home = "home"; SignIn = Some "signIn"; NotFound = Some "notFound" }

// The table mapped onto the application's own union.
type View =
    | Home
    | Invoice of id: int64 * tab: string

let toTarget view : Target =
    match view with
    | Home -> { Route = "home"; Params = Map.empty; Query = Map.empty }
    | Invoice(id, tab) -> { Route = "invoices.invoice"; Params = Map [ "id", Value.Integer id ]; Query = Map [ "tab", Value.Text tab ] }

let ofMatch (matched: Match) =
    match matched.Route, (List.last matched.Chain).Params.TryFind "id", matched.Query.TryFind "tab" with
    | "home", _, _ -> Ok Home
    | "invoices.invoice", Some(Value.Integer id), Some(Value.Text tab) -> Ok(Invoice(id, tab))
    | route, _, _ -> Error $"unmapped {route}"
```

| Need | API |
| --- | --- |
| A location → the application's route, or the route error to render | `RouteCodec.parse codec guard "/invoices/42?tab=history"` |
| The application's route → its one canonical location | `RouteCodec.format codec (Invoice(42L, "history"))` |
| A deep link (`Initialize`) or Back/Forward (`LocationChanged`) | `RouteCodec.adopt`: never a push, at most a replace to the canonical form |
| Another place | `RouteCodec.navigate`: a push |
| The same view refined (a filter, sort, page, tab or date) | `RouteCodec.refine`: a replace, so Back steps between places |
| The routed location of the page, and a link's `href` | `Location.ofBrowser LocationMode.Hash page`, `Location.href LocationMode.Hash location` |
| A deep link through sign-in | `ReturnTo.capture`, `ReturnTo.signIn` (`#/sign-in?returnTo=…`), then `ReturnTo.resume` and `Navigation.replace` |
| Copy link | `Link.share LocationMode.Hash page location`, written with the Core `Clipboard` effect |
| `.echelon/routes.json` (`echelon.routes/v1`) | `Inventory.render LocationMode.Hash table`, byte-identical to the TypeScript library |

`RouteError` is closed: `NotFound`, `NotPermitted`, `Invalid`, `Malformed`,
`RedirectLoop` and `Unmapped`. Render each one, and keep the URL. None of them
is a blank page or another route's view.

**Hash mode is the default for static hosts** such as GitHub Pages. The
routed location is the fragment (`#/invoices/42`), so a reload of any deep
link loads `index.html`, and links need no `<base href>`
(DF-LIMEN-2026-0006).

**Guards are not security.** A guard decides what the *interface* shows
(`Allow`, `Deny` or `Redirect`). The authority that protects data is the
server, which must refuse whatever this person may not do, however the
request arrives.

**No secrets in URLs.** URLs end up in history, logs, referrers, screenshots
and chat. `RouteTable.define` refuses a parameter named like a credential:
`token`, `access_token`, `password`, `secret`, `api_key`, `key`, `session`,
`auth`, `code`, `credentials` and the rest. The comparison ignores case, `-`
and `_`. Carry identifiers and view parameters only, never sensitive personal
data. A return target is a location, never a credential.

Guide: [docs/31-routing.md](https://github.com/kemiller2002/limen/blob/main/docs/31-routing.md).
