# Explicit HTTP cache mode for the Core Http effect — Limen input

Status: proposed source input for Praxis.
Stable requirement: `RQ-LIMEN-2026-A008`.
Defect class: `DC-005` (stale mutable reads served from the browser HTTP cache).
Work item: `WI-0175`.

## Problem

The browser kernel performs every Http effect with `fetch(url, init)` and
sets no `cache` mode, so the browser HTTP cache may answer a read from a
stored response. For mutable resources that is wrong. Observed twice, in the
indy-init rehearsals 2 and 3: GitHub's `GET /repos/{o}/{r}/commits/main`
returns `cache-control: private, max-age=60`; after the user replaced their
token, the cached `200` masked the `401` the server would now return. The
consumer worked around it by adding a per-request `?fresh=<nonce>` query
parameter to mutable URLs. The engine has no typed way to say "this read must
not be served from, or stored in, the HTTP cache".

## Requirements

1. The Http effect request MUST gain an optional, typed `cache` field whose
   values are exactly `default`, `no-store`, `no-cache` and `reload` (fetch's
   `RequestCache` values of the same names). It is a contract enum, modelled
   like the 1.3 `credentials` option, and every language binding MUST be
   generated from the contract.
2. Absent, the request MUST be exactly today's request: no `cache` key is
   passed to `fetch`. Present, the kernel MUST pass the value to `fetch`'s
   `cache` init unchanged and MUST NOT choose a mode on its own.
3. A value outside the enum MUST be refused by every generated decoder at
   `$.cache`, as other contract enums are.
4. The addition is a protocol revision (1.5). An engine MUST send `cache`
   only to a kernel that negotiated 1.5 or later, because an older WASM
   transport's strict decoder would refuse the field.
5. `force-cache` and `only-if-cached` are deliberately excluded: the first
   serves stale responses by design, the second needs `mode: same-origin`,
   which the contract does not model.
6. Documentation MUST state the invariant: a read of a mutable resource
   (whose answer can change with server state or credentials) sets
   `cache: "no-store"`. Correlation ids are a separate concern: they match
   answers to questions and reject stale *results*; they do not prevent a
   stale *response*.

## Acceptance

- Kernel unit tests: no `cache` init when absent; each mode passed exactly.
- Shared wire vectors: a request with `cache: "no-store"` round-trips in
  TypeScript, F#, C# and Rust; an undeclared value is rejected at `$.cache`.
- A typed F# check encodes `Cache = Some HttpCacheMode.NoStore` as
  `"cache":"no-store"` and decodes it back.
- A real-browser check: a response with `cache-control: max-age=60` is served
  from the HTTP cache by default, and a `no-store` read reaches the server.
