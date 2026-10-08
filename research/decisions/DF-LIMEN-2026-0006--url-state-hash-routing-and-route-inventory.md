---
identifier: DF-LIMEN-2026-0006
title: Navigable state lives in a hash-routed, canonical URL built by engine libraries; the route inventory is a published schema
type: decision-record
status: accepted
version: 1.0.0
author_agent: claude-code
created: 2026-10-08
updated: 2026-10-08
related_projects: [limen, praxis, conditor, chrona, summa, signal, arca]
related_documents:
  - docs/requirements/LIMEN-URL-STATE-REQUIREMENTS.md
  - docs/31-routing.md
  - conformance/routing/README.md
supersedes: []
superseded_by: []
tags: [routing, url-state, navigation, github-pages, lcp-005]
work_items: [WI-0167]
external_references: ["kemiller2002/limen#20", "kemiller2002/limen#15"]
provenance:
  contributions:
    EXE-20261008T190446218Z-5a37c83e:
      operations: [created]
      at: 2026-10-08T19:07:17.821Z
      actor:
        kind: agent
        id: anthropic/claude-code
        provider: anthropic
        model: unknown
        runtime: claude-code
      reason: "Hash routing on static hosting, the typed canonical codec, return-target safety and the route inventory schema for LCP-088..112"
---

# DF-LIMEN-2026-0006 — URL state: hash routing, a typed canonical codec, safe return targets and a route inventory

## Context

The portfolio now requires every web application to put its navigable state
in the URL (route, identifiers, date or period, filters, sort, tab, page), so
that a copied URL opens the same view.
[The requirements](https://github.com/kemiller2002/limen/blob/main/docs/requirements/LIMEN-URL-STATE-REQUIREMENTS.md)
(LCP-088..112) extend LCP-005, whose semantics and F# library already
resolve, redirect, guard and build routes. The applications are hosted on
GitHub Pages project sites, which serve static files under `/<repository>/`
and have no rewrite rules.

Seven questions needed a decision.

## Decision

### 1. Hash routing is the default; the 404.html fallback is rejected

The routed location is the fragment: `#/invoices/42?tab=history`.

| | Hash routing | `404.html` path-preserving fallback |
| --- | --- | --- |
| Reload of a deep link | Always loads `index.html`: the fragment never reaches the server. | GitHub Pages answers **HTTP 404** with `404.html`, which must redirect (or re-render) to `index.html` and then rewrite the URL. |
| Base path | None needed: links are relative (`#/x`), no `<base href>`. | The fallback script and every link must know `/<repository>/`, which changes with a custom domain or a fork. |
| Status code and crawlers | `200`. | Every deep link is a `404` response first; link checkers and monitors report it as broken. |
| Extra load | None. | A second document load or a script-driven rewrite before the engine starts, and a flash. |
| Works on any static host | Yes. | Only where the host serves a custom `404.html` at the right path. |
| Cost | In-page anchors (`#section`) cannot be URL fragments; the focus and scroll API (docs/30) replaces them. URLs carry a `#`. | Clean paths. |

The requirement names "relative URLs, no base href, and a reload of a deep
link must not 404". Only hash routing meets all three without host
configuration. A **path mode** stays available, as a value the engine passes,
for hosts that serve the application for every path. Nothing else differs
between the modes.

The kernel already supports this: a `#/…` target is same-origin for
`Navigation`, and moves between such entries arrive as `LocationChanged`. No
protocol change.

### 2. One table, a typed codec over it

The route table stays the single description of the URL space. An
application maps it onto its own typed route value with two total functions,
and gets `parse : Location -> Result<'Route, RouteError>` and
`format : 'Route -> Location`.

Alternatives:

- **Code generation from a DSL.** Rejected: a build step per language, and the
  inventory would need a third source.
- **Typed routes only, no table.** Rejected: the inventory, redirects, guards
  and vectors need the URL space as data.

### 3. View parameters are typed; defaults are omitted from the canonical form

Types: `string`, `int`, `bool`, `date` (`YYYY-MM-DD`), `month` (`YYYY-MM`),
`enum` and `set`. A default is reported on resolution and omitted when
building, so one view has one URL. A **set** is one key with sorted, unique,
comma-joined members (`status=open,overdue`), not a repeated key. LCP-005
already makes a repeated key `Invalid`, and one key keeps the order canonical.
A comma inside a member is percent-encoded.

### 4. Push to navigate, replace to refine

`navigate` pushes; `refine` replaces; `adopt` never pushes. The engine
chooses which one an interaction is. The libraries do not infer it from
which parameters changed, because "another invoice" and "another page of
invoices" both change only parameters.

### 5. The return target travels in the sign-in route's own query

`#/sign-in?returnTo=<canonical location>`. It survives a reload of the
sign-in page, needs no storage, and holds no credential. An authentication
library may also carry it through the identity provider in its own state.
`ReturnTo.resume` accepts only a single-slash relative location that resolves
in the table, is not the sign-in route, and passes the guards again;
anything else goes home. That closes the open redirect.

Alternatives:

- **localStorage or sessionStorage.** Rejected as the primary carrier: lost
  across devices and tabs, and a second source of truth beside the URL.

### 6. Copy link is pure

`BrowserLocation` already carries `origin`. `Link.share` composes the
absolute URL from the origin, the document path and query, and the canonical
routed location. The engine writes it with the Core `Clipboard` effect. No
new capability.

### 7. The route inventory is a published schema

`Inventory.render` produces `echelon.routes/v1` JSON, byte-identical from
both libraries. Its JSON Schema ships as `contract/routes.schema.json`, so
that Praxis (`praxis foundations verify`) and Conditor validate
`.echelon/routes.json` without running or depending on the application.

## Consequences

- No protocol, contract or kernel change; Core's fingerprint is unchanged.
- `EchelonFoundry.Limen.Routing` becomes a fourth lockstep F# package, and
  `@echelon-foundry/limen/routing` a new npm subpath, both in 0.9.0.
- Applications that use in-page `#anchors` move them to the focus and scroll
  API.
- Applications already on path URLs under GitHub Pages had deep links that
  404 on reload; hash mode is their fix, and their old path links cannot be
  redirected by the application (LCP-112).
