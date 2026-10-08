# EchelonFoundry.Limen.Store

A pure functional F# API for [Limen](https://github.com/kemiller2002/limen)'s
IndexedDB store capability, `limen.store` version 2.

- **Values.** Schemas, keys (including compound keys), ranges and
  transactions are immutable values. Every builder is total: an invalid
  schema, key or limit is an `Error` before any request exists.
- **Modes are types.** `Op.put` is `Op<ReadWrite>`, so it does not compile
  inside `Transaction.readOnly`.
- **Explicit codecs.** `Codec<'T>` encodes to JSON and decodes to `Result`.
  64-bit integers beyond 2^53 travel as strings, timestamps as ISO-8601 with
  an offset, and non-finite floats are refused. A stored value that does not
  decode is `Undecodable`, naming the store, the key and the field path,
  never the value.
- **Closed outcomes.** Each request kind has one closed failure union
  (`OpenFailure`, `TransactFailure` with `QuotaExceeded` as its own case, and
  so on). Nothing throws for a browser outcome.
- **The connection is a value.** After `Outdated`, `VersionChanged` or
  `ConnectionLost`, a transaction is refused locally as `NotOpen` and never
  sent. No path turns `Outdated` into a delete.
- **Migrations.** `Migration.plan` is forward-only and refuses gaps and
  repeats. `Migration.step` commits a step with its marker.
- **Errors and diagnostics.** `StoreError` and `StoreDiagnostics` are plain
  values with stable codes, and never contain a stored value.

The only effect is the `StoreExecutor` you supply (`StoreRequest ->
Async<StoreResult>`): the engine's Limen request loop in the browser, or an
in-memory fake in tests. Depends on `EchelonFoundry.Limen.Contract` of the
same version, FSharp.Core and the BCL.

The store is readable by any script on the origin and is not encrypted at
rest: never store a token or other secret in it. `FakeStore` is the
in-memory `limen.store` for tests and passes the same conformance vectors as
the browser pack.

Install through Conditor's NuGet release-asset feed, never a public feed:
declare the `limen-fsharp` component in `conditor.json` and run
`conditor upgrade --current`. See
[docs/41](https://github.com/kemiller2002/limen/blob/main/docs/41-indexeddb.md#installing-them-through-conditor-lcp-080).
