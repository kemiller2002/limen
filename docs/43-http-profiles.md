# HTTP profiles

Closing the practical HTTP gaps without turning Limen into an HTTP framework
(kemiller2002/limen#47, LCP-041).

The work is split three ways, by where each piece belongs:

| Piece | Where | Why there |
| --- | --- | --- |
| Response representation, response headers, credentials, HEAD/OPTIONS, the XSRF binding | **Core Http effect**, protocol 1.3 | They are properties of the one `fetch` call the Http effect already makes. A pack could only supply them by becoming a second, competing Http path. |
| Progress, binary and multipart uploads of picked files | an **optional transfer profile pack** | Progress needs a different transport (XHR upload events, streamed reads), and costs something. Applications that do not register it pay nothing. |
| Retry, caching, auth-header injection, timing, polling, request transformation | an **engine library** | These are policy. The kernel must not decide whether a request is retried or cached. |

## The Core profile (protocol 1.3)

All four options are optional request fields. Absent, the request is exactly
the JSON request of protocol 1.0: same `accept` header, same body handling,
same outcome. **JSON stays the smallest path.** An engine that negotiated 1.2
or older never sends the new fields, and a 1.3 kernel never sends a new outcome
field that was not asked for.

### `response`: how the body comes back

| Value | `Success.body` | Notes |
| --- | --- | --- |
| `json` (default) | the decoded value | a body that does not parse is `Failure { invalid-response, status }`, as before |
| `text` | a string, decoded as UTF-8 | no `accept` header is added |
| `base64` | the exact bytes, base64-encoded | for small binary resources (an image thumbnail, a signature) |
| `none` | `null` | nothing is read: `HEAD`, `204 No Content`, or a body the engine does not need |

A non-JSON response is therefore **representable without a fake
`invalid-response` failure**. Before 1.3, a CSV download, a plain-text health
check and a `204` from a `DELETE` all failed as "invalid JSON".

`text` and `base64` bodies are read incrementally and capped at
`MAX_HTTP_TEXT_BYTES` (8 MiB). Past the cap, reading stops and the outcome is
`Failure { reason: "too-large", status }`. The transfer profile pack handles
anything larger.

### `responseHeaders`: headers on request

```ts
{ kind: "Http", …, responseHeaders: ["ETag", "Location", "Retry-After"] }
// → Success { status, body, headers: { etag: "\"v7\"", location: "/orders/7" } }
```

The response carries back exactly the named headers it has, by lower-case
name. Nothing else is returned, and nothing is returned unless asked. Browsers
never expose `Set-Cookie`. Cross-origin, only CORS-safelisted headers and those
the server lists in `Access-Control-Expose-Headers` are visible. Returned values
never appear in diagnostics.

### `credentials`: explicit cookie policy

`omit`, `same-origin` or `include`, passed to `fetch` exactly. Absent means
the browser default, `same-origin`. The Chromium smoke proves `omit` withholds
a session cookie that the default and `same-origin` send.

`include` for a **cross-origin** request is passed through and unit-tested,
but not exercised in Chromium: the smoke pages run under
`connect-src 'self'`, which forbids cross-origin requests. That is an
evidence gap, recorded rather than worked around by loosening the policy.

### `xsrf`: the cookie-to-header pattern, without `document.cookie`

Many servers defend against cross-site request forgery by setting a readable
cookie (`XSRF-TOKEN`) and requiring its value back in a header
(`X-XSRF-TOKEN`). The engine must not read `document.cookie`. It asks instead:

```ts
{ kind: "Http", method: "POST", url: "/api/orders", body, timeoutMs: 5000,
  xsrf: { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" } }
```

The kernel copies **that one cookie** into **that one header**, and it does so
**only when the URL is same-origin**, so a token can never be sent to another
origin. If the cookie is absent, no header is added, and the server's own
check decides. The value never reaches the engine and is never logged.
Headers the engine sets itself still win on a name conflict.

### Methods

`HEAD` and `OPTIONS` join `GET`, `PUT`, `POST`, `PATCH` and `DELETE`. A
non-standard method (a WebDAV `PROPFIND`, say) would be added to the
`HttpMethod` enum by a contract revision, with the same compile pressure in
every language. It is never accepted as a free string, which would weaken the
typing for everyone to serve one server.

### What did not change

- **`OutcomeUnknown`.** A timeout after dispatch is still never a confident
  failure. That holds in every representation, including a timeout while a
  `text` or `base64` body is being read.
- **Redaction.** No request header, body, cookie, XSRF token or returned
  header value appears in any diagnostic.
- **The kernel decides nothing.** It does not interpret status codes, retry,
  cache, or pick credentials on its own.

### Deliberately not in Core

`redirect`, `cache`, `mode`, `integrity` and `referrerPolicy` are not in the
contract. No reference consumer needs them yet, and each is a new way for a
request to behave differently from what the engine reasons about. Each would
arrive the way the 1.3 options did: optional, explicit, and with the current
behaviour as the default.

## The transfer profile pack

```ts
import { filesCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/files";
import { transferCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/transfer";

const files = filesCapability();
await new BrowserKernel(transport, document, diagnostics, {
  capabilities: [files, transferCapability({ files })],
}).start();
```

The contract is [`contract/transfer.contract.json`](../contract/transfer.contract.json),
with bindings for TypeScript, F#, C# and Rust.

```text
send { method, url, headers?, body, response, responseHeaders?, credentials?, timeoutMs, progress, progressIntervalMs }
```

`body` is one of these four:

- `empty`;
- `text { text, contentType }`;
- `file { file, contentType? }`: the raw bytes of a file the user picked with
  the files pack ([40](40-files.md)), named by its opaque id;
- `multipart { parts }`: fields and picked files. The pack builds the
  `FormData` itself, and the browser sets the boundary.

**Progress is opt-in, twice over.** An application that does not register the
pack loads none of it. A request with `progress: false` registers no progress
listener at all. With `progress: true`, the engine hears
`Progress { request, direction, loaded, total? }` facts under the request's
correlation id:

- at most one per `progressIntervalMs` in each direction;
- the final value always arrives.

**Picked files, not `File` objects.** The application hands the transfer pack
the files pack's `fileFor` accessor. That is explicit wiring: nothing is
shared implicitly between packs. The engine names a file by the id it got in
`Selected`. An id the files pack did not issue, or has released, is
`Failure { unknown-file }`; a file body with no files pack wired is
`Failure { no-files }`. Uploading from disk streams through the browser, so
the pack does not hold a large file in memory.

**The same outcomes as Core Http:**

- `Success { status, body, headers? }`;
- `Failure { reason, status? }`;
- `Cancelled`;
- `OutcomeUnknown` when the timeout passes after the request was sent;
- `InvalidRequest { problem }` for a request that could not be sent as
  written.

**One honest limit.** The transport is `XMLHttpRequest`, because `fetch`
cannot report upload progress. `XMLHttpRequest` always sends same-origin
cookies and cannot omit them, so `credentials: "omit"` is refused as
`InvalidRequest` rather than silently ignored. Core Http honours it.

## Engine-side policy: interception and composition

Retry, caching, auth-header injection, polling and request transformation
are **application policy**. The kernel never decides whether a request is
retried, served from a cache, or given a token. They are pure functions the
engine applies to its own requests and to the outcomes it receives. The
semantics are defined once, in any language, in
[`conformance/http/`](../conformance/http/README.md): 42 cases.
[`libraries/fsharp/Limen.Http`](../libraries/fsharp/Limen.Http/Http.fs) is
the F# reference.

| Policy | Function | Rule worth knowing |
| --- | --- | --- |
| Interceptors | `intercept(request, [header, bearer, timeout, expose, base])` | applied in order; a later one wins; the bearer token is engine state |
| Retry | `decide(policy, request, attempt, outcome)` → `done`, `retry { delayMs }`, `reconcile` or `giveUp` | **an unknown outcome on a non-idempotent request is `reconcile`, never a retry.** An `idempotency-key` header makes a `POST` retryable. `Retry-After` is honoured when it was asked for. |
| Revalidation | `prepare` / `absorb` over an ETag cache | a 304 is recognised whether it arrives as `Success { 304 }` or as `Failure { invalid-response, 304 }`; a successful write invalidates its URL |
| Polling | `next(policy, failures, outcome, stop)` | an unknown poll only slows down; the engine's own condition stops it |

Each function returns a value, never a side effect. The engine turns
`retry { delayMs }` into a scheduling request ([34](34-scheduling.md)) and
then an `Http` effect. That is the composition pattern the issue asks for:
reusable, testable in any language, and entirely outside the bridge. A
mutation check confirmed the vectors are not vacuous: making an unknown
`POST` retry fails the two `reconcile` cases.

## Evidence

| Evidence | Where |
| --- | --- |
| JSON regression; text; base64 bytes; none for HEAD, 204 and OPTIONS; too-large read incrementally and abandoned; exact response headers only when asked; each credentials mode passed exactly; XSRF same-origin, absolute same-origin, cross-origin refused, missing cookie, and no secret in diagnostics or outcomes; OutcomeUnknown in every representation | [`test/http-profile.test.ts`](../test/http-profile.test.ts) |
| Transfer: no listener without progress; throttled progress per direction with the final value; a picked file by id and as multipart (FormData built inside the pack, the file's own name unless given, cross-realm files); the files pack's accessor and release; text, base64, none, invalid-response, network, cancel, OutcomeUnknown; validation, including `omit` refused; conformance suite | [`test/transfer.test.ts`](../test/transfer.test.ts) |
| The same against real `fetch` in Chromium, including real response headers (and `Set-Cookie` withheld by the browser), real cookies with `omit` against the default, and the XSRF header checked by the server | [`test/browser/packs/core-http/`](../test/browser/packs/core-http/), [`test/browser/servers/http.ts`](../test/browser/servers/http.ts), `npm run smoke:packs` |
| Engine-side policy: 42 language-neutral cases (interceptor order, retry by idempotency and outcome, Retry-After, revalidation, invalidation, polling backoff), run against the F# reference in `npm run test:libraries` | [`conformance/http/`](../conformance/http/), [`libraries/fsharp/Limen.Http`](../libraries/fsharp/Limen.Http/) |
| Transfer in Chromium: a real picked 4 MiB file uploaded by id with real progress to the total; multipart parts seen by the server; no progress facts when not asked; throttled download progress to a known total; an unknown id; OutcomeUnknown after a timeout | [`test/browser/packs/transfer/`](../test/browser/packs/transfer/), `npm run smoke:packs` |
