# EchelonFoundry.Limen.Guest

The engine's half of the [Limen](https://github.com/kemiller2002/limen)
handshake, for F# engines. `Limen.Guest.Handshake.answer offer requirements`
accepts the host's offer and selects the capabilities the engine requires, or
rejects it with a typed reason: a missing handshake, an unsupported protocol,
a different core contract, or a required capability that is not offered with
the same id, version and fingerprint.

```fsharp
open Limen.Guest.Handshake
open Limen.Contract.Core

let store : CapabilityOffer =
    { Id = CapabilityId Limen.Contract.Store.Contract.Unit
      Version = Limen.Contract.Store.Contract.Version
      Fingerprint = Limen.Contract.Store.Contract.Fingerprint }

let requirements = { coreOnly with Required = [ store ] }
```

Pure; `net8.0`; depends only on `EchelonFoundry.Limen.Contract` of the same
version.
