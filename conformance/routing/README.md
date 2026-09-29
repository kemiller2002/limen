# Routing semantics

The language-neutral definition of routing for Limen engines
(kemiller2002/limen#20, LCP-005). [`routing.vectors.json`](routing.vectors.json)
is the same definition as data. A routing library in any language conforms
when it produces exactly those results from those tables.

Routing is **application meaning**, so it lives in the engine. The browser
side stays mechanism: the kernel reports locations (`Initialize.location`,
`LocationChanged`) and performs `Navigation` effects (`push`, `replace`,
`back`, `forward`). It never parses a route. Nothing here is a Limen protocol
type, and no library's API shape is canonical. The F# reference library
([`libraries/fsharp/Limen.Routing`](../../libraries/fsharp/Limen.Routing)) is
one conforming implementation.

## Route tables

```json
{ "name": "invoice", "path": "{id:int}", "requires": ["invoice"],
  "query": [ { "name": "tab", "type": "string", "required": false } ],
  "children": [ { "name": "summary", "path": "" }, { "name": "history", "path": "history" } ] }
```

| Field | Meaning |
| --- | --- |
| `name` | unique among siblings. A route's full name joins its chain with `.`, e.g. `invoices.invoice.history`. |
| `path` | segments separated by `/`, relative to the parent. `""` is the parent's own location (an index). |
| segment `literal` | matches exactly, case-sensitively |
| segment `{name:string}` / `{name:int}` | matches any one segment, then converts it (see below) |
| segment `{*name}` | last segment only; captures the rest, zero or more segments, joined by `/` |
| `query` | declared query parameters: `name`, `type` (`string` or `int`), `required` |
| `children` | nested routes. A route with children is matched only through one of them, and is not itself a destination. |
| `redirect` | `{ "to": fullName, "params": { name: "{sourceParam}" or literal } }` |
| `guard` | the name of an engine-supplied decision (below) |
| `requires` | resource keys the engine should have loaded before rendering. Returned with the match; the router loads nothing. |

## Resolving a location

A location is a path and a query string (`?` optional). Resolution runs these
steps in order, and the first failure is the result:

1. **Decode the path.** Split on `/`, and drop empty segments, so trailing and
   repeated slashes are ignored. Percent-decode each segment as UTF-8. An
   invalid escape or invalid UTF-8 gives `MalformedPath`. An encoded `%2F`
   stays inside its segment.
2. **Decode the query.** Split on `&`, then on the first `=`. A key without
   `=` has the value `""`. `+` is a space. Percent-decode as UTF-8; failure
   gives `MalformedQuery`.
3. **Match structurally.** Try routes in declaration order, depth first. A
   route matches when its literal segments match and every parameter segment
   has a segment to take. It must end on a destination with no segment left.
   The **first** structural match decides. None gives `NotFound`, which a
   trailing `{*rest}` route turns into an ordinary match.
4. **Convert path parameters.**
   - `int` is a canonical decimal integer: `0` or `-?[1-9][0-9]*`, within
     ±(2⁵³−1).
   - `string` is any decoded segment.
   - A failure gives `Invalid { route, parameter, value, expected }` for the
     matched route. Resolution does **not** fall through to a later route or
     the wildcard, because a malformed identifier is an error, not a
     different page.
5. **Follow redirects.** `params` values of the form `{x}` take source
   parameter `x`; anything else is literal. The query carries over. Visiting
   a route a second time gives `RedirectLoop { chain }`.
6. **Convert query parameters**, declared along the whole chain, parent
   first. Undeclared keys are ignored.
   - A declared key given twice gives `Invalid`, with `value` the values
     joined by `,` and `expected` `"a single value"`.
   - A missing required key gives `Invalid`, with `value` `""` and
     `expected` `"<type> (required)"`.
   - A type failure gives `Invalid`, as for path parameters.
7. **Consult guards**, outermost first along the chain. Each is the engine's
   decision: `allow`, `deny` (gives `Denied { route }`), or
   `redirect { to, params, query }`. A redirect continues at step 5 with the
   guard's own query, under the same loop rule.

A success is `Matched { route, chain, query, requires, redirectedFrom }`:

| Field | Contents |
| --- | --- |
| `route` | the destination's full name |
| `chain` | each level's local name and typed parameters |
| `query` | the typed declared values; absent optional parameters are omitted |
| `requires` | the union along the chain |
| `redirectedFrom` | the full names that redirected, in order |

**Guards are not security.** A guard decides what the *interface* shows. The
authority that protects data is the server, which must refuse whatever this
user may not do, however the request arrives.

## Building a location

`build(route, params, query)` gives the canonical location, or an error.

- **Path.** The chain's segments, with each parameter percent-encoded. A
  wildcard is encoded segment by segment. The root is `/`, and there is never
  a trailing slash.
- **Query.** Declared parameters only, parent first, in declaration order.
  Absent optional parameters are omitted. `int` values are written in
  decimal.
- **Encoding.** Every UTF-8 byte except `A–Z a–z 0–9 - . _ ~` becomes `%XX`
  with upper-case hex. A space is `%20`, never `+`.
- **Errors:**
  - `UnknownRoute`: not a destination, including a route with children;
  - `MissingParameter`: a path parameter or required query parameter is
    absent;
  - `InvalidParameter`: the wrong type, or an `int` that is not 53-bit safe.

## Adopting locations and navigating

The engine keeps the current canonical location as state. Three rules follow.
Together they make `LocationChanged` never cause a redundant push.

- **Adopt** a location the browser reports, from `Initialize` (a deep link)
  or `LocationChanged` (Back, Forward): resolve it.
  - If it matched and its canonical form differs, because of a redirect, a
    trailing slash or undeclared query keys, the effect is
    `replace(canonical)`. The browser's entry is corrected in place.
  - Otherwise there is **no effect**. An adopted location is never answered
    with a push.
- **Navigate** in-app to `(route, params, query)`: build it. If it equals the
  current location there is no effect; otherwise `push(built)`.
- A location that does not match (`Invalid`, `NotFound`, `Malformed…`) is
  adopted as-is and renders the engine's own error. It produces no effect.
