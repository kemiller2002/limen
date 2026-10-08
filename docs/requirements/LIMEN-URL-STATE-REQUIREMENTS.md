---
id: LIMEN-REQ-URL-STATE
title: Navigable state in the URL, the routing and URL-state module
status: draft
version: 0.1.0
created: 2026-10-08
updated: 2026-10-08
owners:
  - limen
related_documents:
  - docs/31-routing.md
  - conformance/routing/README.md
  - research/decisions/DF-LIMEN-2026-0006--url-state-hash-routing-and-route-inventory.md
tags: [requirements, routing, url-state, navigation, fsharp, typescript, lcp-005]
work_items: [WI-0167, WI-0168, WI-0169, WI-0170, WI-0171, WI-0172]
external_references: ["kemiller2002/limen#15", "kemiller2002/limen#20"]
provenance:
  contributions:
    EXE-20261008T190446218Z-5a37c83e:
      operations: [created]
      at: 2026-10-08T19:06:44.048Z
      actor:
        kind: agent
        id: anthropic/claude-code
        provider: anthropic
        model: unknown
        runtime: claude-code
      reason: "LCP-088..112 derived from the portfolio URL-state requirement (coordinator 2026-10-08) and LCP-005's routing semantics"
---

# Navigable state in the URL: the routing and URL-state module

This document extends **LCP-005** (routing, kemiller2002/limen#20) of the
Limen Capability Parity Specification (kemiller2002/limen#15). It uses the
same requirement format as that specification:

- an `LCP-NNN` heading;
- Status, Priority and Placement, in its vocabulary;
- Requirement, Acceptance criteria and Reference tests.

Each requirement adds a **Rationale** and its **Sources**.

The new IDs are **LCP-088 to LCP-112**. They continue the numbering after the
IndexedDB cluster (LCP-043..087) and form one cluster under LCP-005. Keywords
follow RFC 2119.

> **Scope of this document: requirements and backlog only.** Nothing here is
> implemented by WI-0167. The build is sliced into WI-0168..WI-0172 (section
> 14) and released as **Limen 0.9.0**, with the npm package and the F#
> packages at one version. The decisions are recorded in
> [DF-LIMEN-2026-0006](https://github.com/kemiller2002/limen/blob/main/research/decisions/DF-LIMEN-2026-0006--url-state-hash-routing-and-route-inventory.md).

## 1. The portfolio requirement

Every web application in the portfolio puts its **navigable state** in the
URL, so that a copied URL opens the same view:

- the route (which screen);
- entity identifiers (which invoice, which activity);
- view parameters: date or period, filters, sort, tab and page.

Navigable state is what a person would expect a link, a bookmark, Back,
Forward or a reload to bring back. Ephemeral interface state (an open menu,
a hover, an unsaved draft, a toast) is not navigable state and stays out of
the URL.

A separate Praxis work item adds the matching shared requirement and a
`praxis foundations verify` check, and Conditor gains scaffolding for it.
Both consume this module's route inventory (LCP-107, LCP-108).

## 2. What already exists

| Piece | State before 0.9.0 |
| --- | --- |
| Kernel | Reports `Initialize.location` and `LocationChanged` (`popstate`) as `{ origin, path, query, hash }`, and performs `Navigation` `push`, `replace`, `back`, `forward` to same-origin URLs. It writes no history state. |
| Semantics | [`conformance/routing/`](https://github.com/kemiller2002/limen/blob/main/conformance/routing/README.md): route tables, resolution, redirects with loop rejection, guards, canonical building, adopt and navigate. 40 resolve, 12 build and 1 session vector. |
| F# | `libraries/fsharp/Limen.Routing` passes those vectors. It is not packaged. |
| TypeScript | None. `examples/08-routing` keeps its own small router. |

The kernel side is sufficient: a relative URL such as `#/invoices/42` is
same-origin, and `popstate` fires for history moves between such entries. **No
protocol or contract change is needed.** All new work is engine-library,
tooling and documentation.

## 3. Scope and layering

## LCP-088 — URL meaning stays in the engine; the kernel stays mechanism
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
Route parsing, formatting, defaults, redirects, guards, return targets and
the route inventory MUST be engine-library code: pure, total, with no
browser, network, storage or clock authority. The kernel MUST NOT parse
routes. The Core protocol and contracts MUST NOT change for this cluster.

### Rationale
LCP-005 already placed routing in the engine. The new rules are application
meaning too, and the kernel's existing location reports and `Navigation`
effects carry everything they need.

### Acceptance criteria
- `check:layers` passes with the libraries under the engine boundary.
- The Core contract fingerprint is unchanged in 0.9.0.

### Reference tests
- The architecture and layer checks; the frozen fingerprint test.

*Sources: LCP-005; DF-LIMEN-2026-0001.*

---

## LCP-089 — One semantics, an F# and a TypeScript library, one version
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Tooling

### Requirement
The routing semantics MUST stay language-neutral, in
`conformance/routing/README.md` and its vectors. Limen MUST ship two
conforming libraries:

- **F#:** `EchelonFoundry.Limen.Routing` (`libraries/fsharp/Limen.Routing`);
- **TypeScript:** `@echelon-foundry/limen/routing`.

Both MUST pass every vector, and both MUST ship at the npm package's version.

### Rationale
Engines are written in F# and in TypeScript. Two libraries that each pass the
same vectors cannot drift in the parts a URL depends on.

### Acceptance criteria
- `npm test` runs every vector against the TypeScript library.
- `npm run test:libraries` runs every vector against the F# library.
- The F# package's version equals `package.json`'s.

### Reference tests
- The vector runners in both languages.

*Sources: LCP-005; OQ-LIMEN-IDB-005 (lockstep versions); portfolio requirement.*

---

## 4. Route definitions and the codec

## LCP-090 — Route tables are values, validated when they are defined
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
A route table MUST be an immutable value. Building one MUST return a result,
not throw, and MUST refuse:

- duplicate sibling names;
- a parameter declared twice along one chain;
- a default that does not convert to its parameter's type;
- an enum or set without values, or with duplicates;
- a redirect, legacy entry or return route that names no destination;
- a parameter name reserved for credentials (LCP-109).

### Rationale
A table error found at startup, as a value, is cheaper than a wrong URL in
production. The existing F# `Route.create` throws on a bad segment; the new
definition API returns a result, and the old one stays for compatibility.

### Acceptance criteria
- Every refusal above is a distinct error value in both libraries.
- No definition input throws.

### Reference tests
- Definition vectors: one valid table and one invalid table per refusal.

*Sources: LCP-005.*

---

## LCP-091 — Typed view parameters
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
Path and query parameters MUST support these types:

| Type | Canonical text | Example |
| --- | --- | --- |
| `string` | the text | `q=late%20fees` |
| `int` | decimal, `0` or `-?[1-9][0-9]*`, within ±(2⁵³−1) | `page=3` |
| `bool` | `true` or `false` | `archived=true` |
| `date` | ISO-8601 calendar date `YYYY-MM-DD`, a real date | `on=2026-10-08` |
| `month` | `YYYY-MM`, for a period | `period=2026-10` |
| `enum` | one of the declared values | `sort=due` |
| `set` | declared values or strings, sorted, unique, joined by `,` | `status=open,overdue` |

Path parameters MAY use `string`, `int`, `date`, `month` and `enum`.

### Rationale
Date or period, sort, tab and filters are the view parameters the portfolio
requirement names. Typing them means a malformed value is a deterministic
`Invalid`, never a wrong view.

### Acceptance criteria
- Each type has valid, boundary and invalid resolve vectors, for example
  `2026-02-29` is invalid and `2024-02-29` is valid.

### Reference tests
- Resolve and build vectors per type.

*Sources: portfolio requirement; LCP-005.*

---

## LCP-092 — Defaults and one canonical form
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
A query parameter MAY declare a `default`. Resolution MUST then report the
default when the key is absent, so the engine always sees the full view
state. Building MUST produce exactly one canonical location per state:

- path parameters percent-encoded as today;
- declared query parameters only, parent first, in declaration order;
- a parameter equal to its default omitted;
- a set's members sorted by code point and deduplicated, an empty set
  omitted;
- a space is `%20`, hex is upper case, never `+`.

### Rationale
A canonical form makes URLs comparable. Equal views have equal URLs, so a
navigation to the current view is no navigation, and a link never carries
noise such as `page=1`.

### Acceptance criteria
- `format(parse(u))` equals the canonical form of `u` for every matched
  vector.
- A default given explicitly resolves to the same state as the key omitted,
  and adopting it replaces the URL with the canonical form.

### Reference tests
- Canonical build vectors; adopt vectors that canonicalize.

*Sources: portfolio requirement ("a copied URL opens the same view").*

---

## LCP-093 — A typed codec: `parse` and `format`
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
An application MUST be able to map the table onto its own typed route value,
and get:

```text
parse  : Location -> Result<'Route, RouteError>
format : 'Route   -> Location
```

`RouteError` MUST be closed: `NotFound`, `NotPermitted`, `Invalid`,
`Malformed`, `RedirectLoop`, and `Unmapped` (the application's mapping
refused a match). `format` MUST produce the canonical location.

### Rationale
Engines branch on their own route type, not on strings. The table stays the
single description of the URL space, so the inventory (LCP-107) and the
codec cannot disagree.

### Acceptance criteria
- In F# the route is a discriminated union; in TypeScript a discriminated
  union type. Both reject a mapping that is not total (F# with incomplete
  match warnings as errors; TypeScript with `never` checks).

### Reference tests
- A typed example application in each language, round-tripped by property
  tests (LCP-094).

*Sources: portfolio requirement.*

---

## LCP-094 — Round-trip properties
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Tooling

### Requirement
Both libraries MUST prove, by generated inputs:

1. `parse(format(r)) = Ok r` for every generated route value `r`;
2. `format` of a parsed location is canonical: formatting again changes
   nothing;
3. `parse` is total: for generated and mutated location strings it returns a
   value and never throws.

### Rationale
Examples prove the cases someone thought of; properties prove the codec.

### Acceptance criteria
- At least 1,000 generated cases per property per language, with unicode,
  reserved characters, boundary integers and dates, empty and repeated sets.

### Reference tests
- The property suites in `npm test` and `npm run test:libraries`.

*Sources: portfolio requirement ("property tests for round-trips").*

---

## LCP-095 — Malformed input is a value, never an exception
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
Every location string, including invalid percent escapes, invalid UTF-8,
control characters and very long input, MUST resolve to a result. Input over
8,192 characters MUST be `Malformed` without being decoded.

### Rationale
A URL is input from anyone who can send a link.

### Acceptance criteria
- Totality vectors and the fuzz property (LCP-094.3).

### Reference tests
- Resolve vectors for each malformed class.

*Sources: LCP-005.*

---

## 5. History

## LCP-096 — Push to navigate, replace to refine, never push on adopt
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
The libraries MUST offer three operations on the router state:

| Operation | When | Effect |
| --- | --- | --- |
| `navigate` | the person goes somewhere: another screen or entity | `push(canonical)`, or none when already there |
| `refine` | the same view changes in place: a filter, sort, page, tab or date | `replace(canonical)`, or none when unchanged |
| `adopt` | the browser reports a location (`Initialize`, `LocationChanged`) | `replace(canonical)` when the canonical form differs, else none; never a push |

### Rationale
Back should step between places, not undo every filter click. A refinement
still changes the URL, so the copied link and a reload keep it.

### Acceptance criteria
- Session vectors: a refinement followed by Back returns to the previous
  place, not the previous filter.

### Reference tests
- Session vectors in both languages.

*Sources: portfolio requirement ("push for navigation, replace for in-place refinements").*

---

## LCP-097 — Back, Forward and reload restore the state from the URL alone
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Browser proof

### Requirement
An engine using the module MUST be able to rebuild its navigable state from
the location alone. The kernel writes no history state, and the libraries
MUST NOT depend on any.

### Rationale
After a reload or a deploy, only the URL is reliable.

### Acceptance criteria
- In real Chromium and WebKit, a page using the module restores route,
  identifiers and view parameters after Back, Forward and a reload.

### Reference tests
- The URL-state browser page (LCP-103).

*Sources: portfolio requirement; LCP-005.*

---

## 6. Outcomes

## LCP-098 — Not found and not permitted are values the engine renders
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Engine

### Requirement
Every resolution MUST be one of the closed outcomes of LCP-093. An engine
MUST render each one:

- `NotFound`: a not-found view that keeps the URL, with a way home;
- `NotPermitted`: a not-permitted view that keeps the URL, distinct from not
  found, with a way to sign in when the person is signed out;
- `Invalid` and `Malformed`: an invalid-link view naming the parameter;
- `RedirectLoop`: a configuration-error view.

None of them may render a blank page or another route's view. A resource
the server refuses (`403`) or cannot find (`404`) after a match MUST map to
the same `NotPermitted` and `NotFound` views.

### Rationale
A blank or wrong view after a bad link hides the problem from the person and
from support.

### Acceptance criteria
- The libraries offer `RouteOutcome` (or the typed `Result`) with these cases
  and no other.
- The browser page renders each outcome from a deep link.

### Reference tests
- Resolve vectors per outcome; the browser page.

*Sources: portfolio requirement ("not-found and not-permitted route outcomes as values").*

---

## LCP-099 — Guards decide the interface, not access
**Status:** Required · **Priority:** P0 · **Placement:** Documentation + Engine Library

### Requirement
Guards remain engine decisions (`allow`, `deny`, `redirect`). Documentation
MUST state that a guard is not security: the server refuses what this person
may not do, however the request arrives.

### Acceptance criteria
- docs/31 and the library README say so.

### Reference tests
- Documentation check.

*Sources: LCP-005.*

---

## 7. Sign-in

## LCP-100 — A deep link survives sign-in
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Engine

### Requirement
When a route needs a signed-in person and none is signed in, the engine MUST
keep the requested location and, after authentication, return to it:

- `ReturnTo.capture (location)` gives a return target from the requested
  canonical location;
- the sign-in route carries it as its own query parameter
  (`#/sign-in?returnTo=%2Finvoices%2F42%3Ftab%3Dhistory`), so it survives a
  reload of the sign-in page;
- `ReturnTo.resume (target)` gives the location to `replace` to after
  sign-in, or the home route when the target is absent or unsafe (LCP-101).

The authentication library MAY also carry it through the identity provider in
its own state. The return target is never a credential.

### Rationale
Losing the destination at sign-in breaks every shared link to a signed-in
page.

### Acceptance criteria
- A session vector: deep link, redirect to sign-in with `returnTo`, sign-in,
  replace to the original canonical location, and Back does not return to the
  sign-in page.

### Reference tests
- Session vectors; the browser page.

*Sources: portfolio requirement ("deep-link preservation through sign-in"); Fides FID-CLI-002.*

---

## LCP-101 — Return targets cannot leave the application
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library

### Requirement
`ReturnTo.resume` MUST accept only a location that:

- starts with a single `/`, with no scheme, host, `//`, `\` or control
  character;
- resolves in the table to `Matched` (after redirects);
- is not the sign-in route or any route marked `returnTo: false`.

Anything else MUST resume to the home route. Resuming MUST re-run guards.

### Rationale
An unchecked return parameter is an open redirect.

### Acceptance criteria
- Vectors for `//evil.example`, `https://…`, `/\evil`, an encoded `//`, the
  sign-in route itself, an unknown route and a denied route.

### Reference tests
- Return-target vectors in both languages.

*Sources: OWASP open-redirect guidance; portfolio requirement.*

---

## 8. Static hosting

## LCP-102 — Hash routing on static hosts
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Documentation

### Requirement
The default location mode MUST be **hash**: the routed location is the
fragment, `#/<path>?<query>`. The document's own path and query are left
alone. Links and navigation targets MUST be relative (`#/invoices/42`). No
`<base href>` and no knowledge of the site's base path is needed.

A **path** mode MAY be used on hosts that serve the application for every
path. The mode is a value the engine passes; nothing else changes with it.
The choice and the rejected 404.html fallback are recorded in
DF-LIMEN-2026-0006.

### Rationale
GitHub Pages serves project sites under `/<repository>/` and has no rewrite
rules. The fragment never reaches the server, so a reload of any deep link
loads `index.html`.

### Acceptance criteria
- `Location.ofBrowser` and `Location.href` in both libraries, for both modes.
- An in-page anchor is not lost: the documentation shows the focus and
  scroll API (docs/30) in its place.

### Reference tests
- Location vectors for both modes.

*Sources: portfolio requirement ("works on static GitHub Pages hosting").*

---

## LCP-103 — A reload of a deep link never 404s
**Status:** Required · **Priority:** P0 · **Placement:** Browser proof + Tooling

### Requirement
A browser page MUST prove, in Chromium and WebKit, on a static server that
serves the application under a sub-path and answers 404 for any other path
(as GitHub Pages does):

- a deep link with route, identifier and view parameters opens that view;
- a reload keeps it;
- `navigate` then Back and Forward step between places;
- `refine` does not add a history entry;
- the not-found and not-permitted outcomes render from deep links;
- a deep link to a signed-in route goes through sign-in and returns.

### Acceptance criteria
- `npm run smoke:packs` and `npm run smoke:packs:webkit` include the page,
  and CI fails if it fails.

### Reference tests
- `test/browser/packs/url-state/`.

*Sources: portfolio requirement.*

---

## LCP-104 — Relative links in rendered markup
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library + Documentation

### Requirement
Links an engine renders for in-app destinations MUST use `Location.href` of
the built location (a relative `#/…` in hash mode), so that opening in a new
tab, middle-click and copy-link-address work. A click on such a link MUST be
handled as `navigate`, because the browser's own fragment navigation reaches
the engine as `LocationChanged` and is adopted.

### Rationale
A real `href` keeps the browser's own link behaviour, and costs nothing in
hash mode.

### Acceptance criteria
- The browser page uses real links, and both a click and a new-tab open land
  on the same view.

### Reference tests
- The browser page.

*Sources: portfolio requirement.*

---

## 9. Legacy routes

## LCP-105 — Legacy routes redirect to the current ones
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library

### Requirement
A table MAY declare legacy entries: an old path pattern and the current
destination with a parameter mapping. Resolution MUST follow them as
redirects (same loop rule), and `adopt` MUST `replace` to the canonical
current location. Legacy entries MUST appear in the route inventory, and MUST
never be produced by `format`.

Legacy entries live inside the routed location. A path URL that a static
host never served cannot be redirected by the application, because the host
answers 404 before the application loads; moving an existing path-mode site
to hash mode is out of scope (LCP-112).

### Rationale
Links in mail, chat and bookmarks outlive a route rename.

### Acceptance criteria
- Vectors: a renamed route, a moved parameter, a legacy chain into a loop.

### Reference tests
- Resolve and session vectors.

*Sources: portfolio requirement ("legacy-route redirects"); LCP-005 redirects.*

---

## 10. Copy link

## LCP-106 — A copy-link helper
**Status:** Required · **Priority:** P1 · **Placement:** Engine Library + Core Clipboard

### Requirement
`Link.share (page, location)` MUST give the absolute URL of a canonical
location: the page's `origin`, its document path and query from the browser
location, and the location in the current mode. The engine writes it with
the Core `Clipboard` effect and renders the typed outcome (copied, or the
reason it was not). The shared URL MUST be the canonical form, with no
credential or return target added.

### Rationale
"Copy link" is how the portfolio requirement is exercised daily. Building the
URL from the canonical location means the copied link is exactly the view.

### Acceptance criteria
- Vectors: hash and path mode, a sub-path, a document query that is kept.
- The browser page copies a link and opening it in a new page shows the same
  view.

### Reference tests
- Link vectors; the browser page.

*Sources: portfolio requirement ("a copy link helper"); LCP-019 (clipboard).*

---

## 11. Route inventory

## LCP-107 — A route inventory export
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Tooling

### Requirement
`Inventory.render (table)` MUST produce a deterministic JSON document, schema
`echelon.routes/v1`, that an application writes to `.echelon/routes.json`.
It lists the location mode and, for every destination and legacy entry:

- the full name and the path pattern;
- each parameter: name, place (`path` or `query`), type, required, default,
  and the values of an enum or set;
- the guard name, `requires`, whether it may be a return target, and for a
  legacy entry its target;
- the routes marked as the sign-in, not-found and home routes.

The same table MUST always render byte-identical output (sorted keys,
two-space indentation, a final newline).

### Rationale
Praxis (`praxis foundations verify`) and Conditor need the URL space without
running the application.

### Acceptance criteria
- The F# and TypeScript libraries render the same bytes for every vector
  table.

### Reference tests
- Inventory vectors: table → expected document.

*Sources: portfolio requirement ("a route-inventory export").*

---

## LCP-108 — The inventory schema is published
**Status:** Required · **Priority:** P0 · **Placement:** Contract (tooling)

### Requirement
The schema MUST be published as `contract/routes.schema.json` (JSON Schema
2020-12) in the npm package, and both libraries' output MUST validate
against it. Changes to it MUST be additive within `v1`.

### Rationale
Praxis and Conditor validate `.echelon/routes.json` without depending on
Limen's code.

### Acceptance criteria
- A test validates every inventory vector's output against the schema.

### Reference tests
- The schema test.

*Sources: portfolio requirement; Praxis foundations work item.*

---

## 12. Privacy

## LCP-109 — No secrets, tokens or sensitive data in URLs
**Status:** Required · **Priority:** P0 · **Placement:** Engine Library + Documentation

### Requirement
- A table MUST refuse a parameter whose name, compared case-insensitively
  with `-` and `_` removed, is one of: `token`, `accesstoken`, `idtoken`,
  `refreshtoken`, `password`, `passwd`, `secret`, `clientsecret`, `apikey`,
  `key`, `session`, `sessionid`, `auth`, `authorization`, `code`,
  `credential`, `credentials`.
- Documentation MUST say that URLs end up in history, logs, referrers,
  screenshots and chat, so they MUST NOT carry secrets, tokens or sensitive
  personal data (names, email addresses, free text a person typed about
  someone), only identifiers and view parameters.
- After an OAuth redirect, parameters in the document query (outside the
  routed fragment) MUST be removed by a `replace` once consumed. That is the
  authentication library's job; the routing library never reads them.

### Rationale
Navigable state is shared on purpose. Anything secret in it leaks.

### Acceptance criteria
- Definition vectors for the reserved names.
- docs/31 carries the guidance.

### Reference tests
- Definition vectors; documentation check.

*Sources: portfolio requirement; LCP-068 (no secrets in storage); FID-CLI-002.*

---

## 13. Release

## LCP-110 — Packages at one version
**Status:** Required · **Priority:** P0 · **Placement:** Tooling / release

### Requirement
0.9.0 MUST ship:

- `@echelon-foundry/limen` with the `./routing` subpath, published with
  provenance;
- `EchelonFoundry.Limen.Routing`, at the same version, as a Sigstore-attested
  GitHub release asset beside the other F# packages, recorded under the
  `limen-fsharp` registry system and installed through Conditor.

### Acceptance criteria
- `check:nuget`'s clean room consumes the routing package.
- The release is verified by checksum and attestation from an empty directory.

### Reference tests
- `npm run check:nuget`; the release verification.

*Sources: LCP-079, LCP-080.*

---

## LCP-111 — The routing example uses the module
**Status:** Required · **Priority:** P2 · **Placement:** Example

### Requirement
`examples/08-routing` MUST use `@echelon-foundry/limen/routing` in hash mode
instead of its own router, and keep its tests.

### Rationale
The example is what people copy.

### Acceptance criteria
- The example's tests pass against the library.

### Reference tests
- `test/examples.test.ts`.

*Sources: LCP-005.*

---

## 13a. Out of scope

## LCP-112 — Out of scope for 0.9.0
**Status:** Intentional Non-Parity (for now) · **Placement:** Intentional Non-Parity

### Requirement
Not in this cluster:

- server-side routing, rewrites and prerendering;
- nested layout outlets (the engine composes its own view);
- scroll restoration (docs/30 owns focus and scroll);
- localized path segments;
- redirecting path URLs that a static host answers with 404 before the
  application loads;
- ephemeral interface state in the URL (open menus, hovers, drafts);
- a kernel-side router or any protocol change.

*Sources: LCP-005; DF-LIMEN-2026-0006.*

---

## 14. Backlog

Order of the build. Each item is one PR, with its Praxis lifecycle.

| Order | Work item | Requirements |
| --- | --- | --- |
| 0 | WI-0167: this document, DF-LIMEN-2026-0006, the backlog, and the issue #15 reservation | — |
| 1 | WI-0168: semantics and F#. Typed definitions, view parameter types, defaults and canonical form, `refine`, outcomes, the typed codec, legacy entries, reserved names, return targets, locations and links, and the inventory. New vectors, F# property tests. | LCP-088, 090..096, 098..102, 105..107, 109 |
| 2 | WI-0169: the TypeScript library `@echelon-foundry/limen/routing`, passing every vector, with property tests; the inventory schema | LCP-089, 093, 094, 107, 108 |
| 3 | WI-0170: the URL-state browser page in Chromium and WebKit on a sub-path static server; `examples/08-routing` on the module | LCP-097, 103, 104, 106, 111 |
| 4 | WI-0171: `EchelonFoundry.Limen.Routing` as a fourth attested F# package; docs/31 guidance (privacy, hash mode, outcomes, sign-in) | LCP-099, 109, 110 |
| 5 | WI-0172: release 0.9.0, the registry entry, and verification from a clean directory | LCP-110 |

## 15. Open questions

None blocking. The decisions the portfolio requirement left open (hash or
404.html, list encoding, where the return target travels) are made in
DF-LIMEN-2026-0006.

## 16. Requirement count

| Area | IDs | Count |
|---|---|---:|
| Scope and layering | LCP-088..089 | 2 |
| Definitions and codec | LCP-090..095 | 6 |
| History | LCP-096..097 | 2 |
| Outcomes | LCP-098..099 | 2 |
| Sign-in | LCP-100..101 | 2 |
| Static hosting | LCP-102..104 | 3 |
| Legacy routes | LCP-105 | 1 |
| Copy link | LCP-106 | 1 |
| Route inventory | LCP-107..108 | 2 |
| Privacy | LCP-109 | 1 |
| Release and example | LCP-110..111 | 2 |
| Out of scope | LCP-112 | 1 |
| **Total** | | **25** |
