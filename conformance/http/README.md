# HTTP interception and composition semantics

The language-neutral definition of the engine-side HTTP policies that Limen
deliberately keeps out of the kernel (kemiller2002/limen#47, LCP-041).
[`http.vectors.json`](http.vectors.json) is the same definition as data. A
library in any language conforms when every case produces the stated result
exactly.

Every function here is pure: a request or an outcome goes in, a decision or a
new request comes out. None of them sends anything, sleeps, or reads a clock.
The engine turns their decisions into Core `Http` effects and scheduling
requests, and maps the kernel's `EffectOutcome` onto their outcomes. This is
the composition pattern: policies are values the engine applies, not hooks
inside the bridge.

## Requests and outcomes

A **request** is `{ method, url, headers, body?, timeoutMs, responseHeaders }`.
Header names are compared case-insensitively and stored in lower case.

An **outcome** is one of the following, and `unknown` is never treated as a
failure:

- `success { status, body, headers }`;
- `failure { reason, status? }`;
- `cancelled`;
- `unknown`, the kernel's `OutcomeUnknown`.

## Interceptors

`intercept(request, interceptors)` applies each interceptor in order:

| Interceptor | Effect |
| --- | --- |
| `header { name, value }` | sets the header, replacing any with the same name |
| `bearer { token }` | sets `authorization: Bearer <token>`. The token is engine state, such as a session the engine holds; the kernel never supplies one. |
| `timeout { ms }` | sets `timeoutMs` |
| `expose { names }` | adds the names to `responseHeaders`, lower-cased, without duplicates, in order |
| `base { prefix }` | prefixes a URL that starts with `/`; absolute URLs are left alone |

Order matters, and the vectors fix it: a later `header` wins over an earlier
one.

## Retry

`decide(policy, request, attempt, outcome)` answers one of these:

- `done`: this outcome is the answer;
- `retry { delayMs }`: send again after the delay;
- `reconcile`: a non-idempotent request whose outcome is unknown. **Never
  retried blindly**; the engine must ask the server what happened.
- `giveUp { reason }`: `attempts` or `not-idempotent`.

`attempt` is how many attempts have been made, starting at 1. A request is
**idempotent** when its method is `GET`, `HEAD`, `OPTIONS`, `PUT` or
`DELETE`, or when it carries an `idempotency-key` header.

| Outcome | Idempotent | Not idempotent |
| --- | --- | --- |
| `cancelled` | `done` | `done` |
| `unknown` | retry | `reconcile` |
| `failure { network }` | retry | `giveUp { not-idempotent }` |
| `failure { invalid-response, status }` with `status` in `retryStatuses` | retry | `done` |
| any other `failure` | `done` | `done` |
| `success` with `status` in `retryStatuses` | retry | `done` |
| any other `success` | `done` | `done` |

"Retry" means `retry` while `attempt < maxAttempts`, and `giveUp { attempts }`
after that. The delay is:

- the `retry-after` response header, in whole seconds, when present (so ask
  for it with `expose`);
- otherwise `baseDelayMs × 2^(attempt − 1)`;
- in both cases capped at `maxDelayMs`.

There is no jitter here, because a pure function must be deterministic. An
engine that wants jitter adds its own, from its own source of randomness.

## Conditional revalidation cache

A cache maps a URL to `{ etag, body }`. It holds only what the engine
absorbed, and nothing expires on its own.

- `prepare(cache, request)`: for a `GET`, adds `etag` to `responseHeaders`.
  When the URL is cached, it also sets `if-none-match` to the stored ETag.
  Other methods pass through unchanged.
- `absorb(cache, request, outcome)` returns the new cache and the outcome the
  engine should act on:
  - `GET` + `success` with status 200 and an `etag` header: stored, and the
    outcome is unchanged.
  - `GET` + status 304, arriving as `success { 304 }` or as
    `failure { invalid-response, 304 }` (a JSON read of an empty body), with
    the URL cached: becomes `success { status: 200, body: <cached>, headers: {} }`.
    A 304 for an uncached URL is left as it came.
  - `PUT`, `PATCH`, `POST` or `DELETE` + a 2xx `success`: the URL's entry is
    removed, because a write invalidates it.
  - Anything else: unchanged.

## Polling

`next(policy, failures, outcome, stop)` answers `after { delayMs }` or `stop`,
plus the new count of consecutive failures:

| Case | Decision | Failures |
| --- | --- | --- |
| `stop` is true (the engine's own terminal condition) | `stop` | unchanged |
| `cancelled` | `stop` | unchanged |
| `success` | `after { intervalMs }` | 0 |
| `failure` or `unknown` | `after { min(intervalMs × factor^failures', maxIntervalMs) }` | `failures + 1` = `failures'` |

A poll is a read, so `unknown` only slows it down. Nothing about it is
assumed to have failed.

Timing (how long to wait) is exactly the delays these functions compute. The
engine waits with the scheduling pack ([34](../../docs/34-scheduling.md)).
