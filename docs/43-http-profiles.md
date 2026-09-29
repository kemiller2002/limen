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

| Evidence | Where |
| --- | --- |
| JSON regression; text; base64 bytes; none for HEAD, 204 and OPTIONS; too-large read incrementally and abandoned; exact response headers only when asked; each credentials mode passed exactly; XSRF same-origin, absolute same-origin, cross-origin refused, missing cookie, and no secret in diagnostics or outcomes; OutcomeUnknown in every representation | [`test/http-profile.test.ts`](../test/http-profile.test.ts) |
| The same against real `fetch` in Chromium, including real response headers (and `Set-Cookie` withheld by the browser), real cookies with `omit` against the default, and the XSRF header checked by the server | [`test/browser/packs/core-http/`](../test/browser/packs/core-http/), [`test/browser/servers/http.ts`](../test/browser/servers/http.ts), `npm run smoke:packs` |
