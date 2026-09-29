// Limen HTTP policies: the F# reference implementation of the language-neutral
// semantics in conformance/http/README.md (kemiller2002/limen#47, LCP-041).
//
// Interceptors, retry decisions, conditional revalidation and polling are
// application policy, so they live here as pure functions over requests and
// outcomes — never in the kernel. Nothing here sends, sleeps or reads a
// clock: the engine turns each decision into Core Http effects and
// scheduling requests. OutcomeUnknown is never treated as a failure, and a
// non-idempotent request whose outcome is unknown is never retried blindly.
namespace Limen.Http

type Request =
    { Method: string
      Url: string
      /// Lower-case names.
      Headers: Map<string, string>
      Body: string option
      TimeoutMs: int64
      /// Lower-case names, in order, without duplicates.
      ResponseHeaders: string list }

[<RequireQualifiedAccess>]
type Outcome =
    | Success of status: int * body: string * headers: Map<string, string>
    | Failure of reason: string * status: int option
    | Cancelled
    /// The kernel's OutcomeUnknown: the request may have been applied.
    | Unknown

module Request =
    let private lower (name: string) = name.ToLowerInvariant()

    let create (method': string) (url: string) =
        { Method = method'; Url = url; Headers = Map.empty; Body = None; TimeoutMs = 5000L; ResponseHeaders = [] }

    let withHeader (name: string) (value: string) (request: Request) =
        { request with Headers = request.Headers |> Map.add (lower name) value }

    let expose (names: string list) (request: Request) =
        let added = names |> List.map lower
        { request with ResponseHeaders = request.ResponseHeaders @ added |> List.distinct }

    let header (name: string) (request: Request) = request.Headers |> Map.tryFind (lower name)

// ---------------------------------------------------------------------------
// Interceptors
// ---------------------------------------------------------------------------

[<RequireQualifiedAccess>]
type Interceptor =
    | Header of name: string * value: string
    | Bearer of token: string
    | Timeout of ms: int64
    | Expose of names: string list
    | Base of prefix: string

module Interceptor =
    let apply (request: Request) (interceptor: Interceptor) =
        match interceptor with
        | Interceptor.Header(name, value) -> request |> Request.withHeader name value
        | Interceptor.Bearer token -> request |> Request.withHeader "authorization" $"Bearer {token}"
        | Interceptor.Timeout ms -> { request with TimeoutMs = ms }
        | Interceptor.Expose names -> request |> Request.expose names
        | Interceptor.Base prefix when request.Url.StartsWith "/" -> { request with Url = prefix.TrimEnd('/') + request.Url }
        | Interceptor.Base _ -> request

    /// In order: a later interceptor sees, and may override, an earlier one's work.
    let intercept (interceptors: Interceptor list) (request: Request) = interceptors |> List.fold apply request

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

type RetryPolicy =
    { MaxAttempts: int
      BaseDelayMs: int64
      MaxDelayMs: int64
      RetryStatuses: int list }

[<RequireQualifiedAccess>]
type RetryDecision =
    | Done
    | Retry of delayMs: int64
    /// A non-idempotent request with an unknown outcome: ask the server.
    | Reconcile
    | GiveUp of reason: string

module Retry =
    let private idempotentMethods = set [ "GET"; "HEAD"; "OPTIONS"; "PUT"; "DELETE" ]

    let isIdempotent (request: Request) =
        idempotentMethods.Contains(request.Method.ToUpperInvariant()) || (request |> Request.header "idempotency-key").IsSome

    let private delay (policy: RetryPolicy) (attempt: int) (outcome: Outcome) =
        let retryAfter =
            match outcome with
            | Outcome.Success(_, _, headers) ->
                headers
                |> Map.tryFind "retry-after"
                |> Option.bind (fun value ->
                    match System.Int64.TryParse value with
                    | true, seconds when seconds >= 0L -> Some(seconds * 1000L)
                    | _ -> None)
            | _ -> None
        let backoff = policy.BaseDelayMs * (pown 2L (max 0 (attempt - 1)))
        min policy.MaxDelayMs (retryAfter |> Option.defaultValue backoff)

    let decide (policy: RetryPolicy) (request: Request) (attempt: int) (outcome: Outcome) =
        let idempotent = isIdempotent request
        let retry () = if attempt < policy.MaxAttempts then RetryDecision.Retry(delay policy attempt outcome) else RetryDecision.GiveUp "attempts"
        let retryable status = policy.RetryStatuses |> List.contains status
        match outcome with
        | Outcome.Cancelled -> RetryDecision.Done
        | Outcome.Unknown -> if idempotent then retry () else RetryDecision.Reconcile
        | Outcome.Failure("network", _) -> if idempotent then retry () else RetryDecision.GiveUp "not-idempotent"
        | Outcome.Failure("invalid-response", Some status) when retryable status && idempotent -> retry ()
        | Outcome.Failure _ -> RetryDecision.Done
        | Outcome.Success(status, _, _) when retryable status && idempotent -> retry ()
        | Outcome.Success _ -> RetryDecision.Done

// ---------------------------------------------------------------------------
// Conditional revalidation cache
// ---------------------------------------------------------------------------

type Cached = { ETag: string; Body: string }

/// What the engine absorbed, by URL. Nothing expires on its own.
type Cache = private { Entries: Map<string, Cached> }

module Cache =
    let empty = { Entries = Map.empty }

    let urls (cache: Cache) = cache.Entries |> Map.toList |> List.map fst

    let tryFind (url: string) (cache: Cache) = cache.Entries |> Map.tryFind url

    let prepare (cache: Cache) (request: Request) =
        if request.Method.ToUpperInvariant() <> "GET" then request
        else
            let exposed = request |> Request.expose [ "etag" ]
            match cache.Entries |> Map.tryFind request.Url with
            | Some cached -> exposed |> Request.withHeader "if-none-match" cached.ETag
            | None -> exposed

    let private writes = set [ "PUT"; "PATCH"; "POST"; "DELETE" ]

    let absorb (cache: Cache) (request: Request) (outcome: Outcome) : Cache * Outcome =
        let method' = request.Method.ToUpperInvariant()
        let cached = cache.Entries |> Map.tryFind request.Url
        match method', outcome, cached with
        | "GET", Outcome.Success(200, body, headers), _ when headers.ContainsKey "etag" ->
            { Entries = cache.Entries |> Map.add request.Url { ETag = headers["etag"]; Body = body } }, outcome
        | "GET", Outcome.Success(304, _, _), Some entry
        | "GET", Outcome.Failure("invalid-response", Some 304), Some entry ->
            cache, Outcome.Success(200, entry.Body, Map.empty)
        | written, Outcome.Success(status, _, _), _ when writes.Contains written && status >= 200 && status < 300 ->
            { Entries = cache.Entries |> Map.remove request.Url }, outcome
        | _ -> cache, outcome

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

type PollPolicy = { IntervalMs: int64; MaxIntervalMs: int64; Factor: int64 }

[<RequireQualifiedAccess>]
type PollDecision =
    | After of delayMs: int64
    | Stop

module Poll =
    /// The next wait and the new count of consecutive failures. stop is the
    /// engine's own terminal condition (the job finished, the user left).
    let next (policy: PollPolicy) (failures: int) (outcome: Outcome) (stop: bool) : PollDecision * int =
        match stop, outcome with
        | true, _
        | _, Outcome.Cancelled -> PollDecision.Stop, failures
        | _, Outcome.Success _ -> PollDecision.After policy.IntervalMs, 0
        | _, Outcome.Failure _
        | _, Outcome.Unknown ->
            let failures' = failures + 1
            PollDecision.After(min policy.MaxIntervalMs (policy.IntervalMs * pown policy.Factor failures')), failures'
