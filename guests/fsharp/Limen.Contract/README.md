# EchelonFoundry.Limen.Contract

Generated F# bindings for the [Limen](https://github.com/kemiller2002/limen)
browser/engine contract: Core (`Limen.Contract.Core`) and every capability
pack, including the IndexedDB store (`Limen.Contract.Store`).

- Each unit's `Contract` module carries its identity and **contract
  fingerprint**. An engine selects a capability in the handshake with exactly
  that identity, and the kernel refuses a mismatched one at the handshake,
  never at the first request.
- Types are records and unions. Codecs decode to `Result`, never throw for a
  malformed value.
- Pure, trimmable and reflection-free (`--reflectionfree`); targets `net8.0`;
  no dependency beyond FSharp.Core and the BCL.
- The package version equals the `@echelon-foundry/limen` npm version that
  ships the matching browser packs.

Install through Conditor's NuGet release-asset feed, never a public feed:
see [docs/41](https://github.com/kemiller2002/limen/blob/main/docs/41-indexeddb.md).
