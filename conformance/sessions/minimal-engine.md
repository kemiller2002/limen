# The minimal engine — a language-neutral specification

One small application, implemented identically in F#, C# and Rust
(`guests/minimal/`), to prove that a WebAssembly engine in any guest language
can use every built-in Limen capability through the same contract, with no
application logic in TypeScript. It is a *capability probe*, not a product:
each button requests one effect and the engine records what came back.

The behavior below is normative. [`minimal.session.json`](minimal.session.json)
turns it into message-by-message vectors every implementation must reproduce
exactly (compared as JSON values).

## Handshake

The engine requires protocol `{ major: 1, minor: 1 }`, the generated core
contract identity, and **no** optional capabilities. It answers every
`Initialize` with the rule shared by all engines (`answerHandshake`):

| Host offer | Answer |
| --- | --- |
| absent (a pre-1.1 kernel) | `Rejected(HandshakeMissing)` |
| other protocol major, or a minor below 1 | `Rejected(ProtocolUnsupported(offered))` |
| other core contract (unit, version or fingerprint) | `Rejected(ContractMismatch(expected, offered))` |
| otherwise | `Accepted(protocol 1.1, the engine's contract, capabilities [])` |

After a rejection the engine is **incompatible** forever: it answers every
later message with the incompatible view, no effects, no cancellations, and
changes nothing.

## State

- `status`: `ready` or `incompatible` (initially `ready`, but see Initialize).
- `log`: entries `{ id, text }`, ids `"1"`, `"2"`, … assigned in order and never
  reused; only the **last 20** are kept.
- `next`: the next correlation number, starting at 1.
- `pending`: correlation id → label, for effects requested and not yet answered.

## Messages

| Message | Transition | Effects |
| --- | --- | --- |
| `Initialize`, accepted | log `ready` | none; response carries `handshake: Accepted` |
| `Initialize`, rejected | status `incompatible`; log unchanged | none; response carries `handshake: Rejected` |
| `Event http-ok` | log `requested http-ok`; pending `c<n>` → `http-ok` | `Http GET /ok.json`, timeout 5000 |
| `Event http-missing` | as above, label `http-missing` | `Http GET /missing.json`, timeout 5000 |
| `Event storage-set` | label `storage-set` | `Storage set` key `limen-minimal`, value `saved` |
| `Event storage-get` | label `storage-get` | `Storage get` key `limen-minimal` |
| `Event clipboard` | label `clipboard` | `Clipboard writeText` text `limen` |
| `Event nav-push` | label `nav-push` | `Navigation push` url `?screen=two` |
| `Event nav-away` | label `nav-away` | `Navigation push` url `https://example.org/elsewhere` |
| `Event` any other name | log `ignored <name>` | none |
| `EffectResult` whose correlation id is pending | remove it; log `<label>: <outcome>` | none |
| `EffectResult` whose correlation id is not pending | log `stale <correlationId>` | none |
| `LocationChanged` | log `location <path><query>` | **none — never navigate in response** |
| `CapabilityFact` | log `unexpected fact <capability>` | none |

Correlation ids are `c1`, `c2`, … in request order.

`<outcome>`:

| Result | Text |
| --- | --- |
| Http `Success` | `success <status>` |
| Http `Failure` | `failure <reason>` or `failure <reason> <status>` when a status is present |
| Http `Cancelled` / `OutcomeUnknown` | `cancelled` / `unknown` |
| Storage `Success` | `success <value>` or `success null` |
| Storage `Failure` | `failure <reason>` |
| Clipboard `Success` / `Failure` | `success` / `failure <reason>` |
| Navigation `Success` | `success <path><query>` |
| Navigation `Dispatched` / `Failure` | `dispatched` / `failure <reason>` |
| `CapabilityResult` | `unexpected capability result` |

## Projection

```text
{ status: "ready" | "incompatible", count: <number of retained log entries>, log: [ { id, text }, … ] }
```

When incompatible the projection is `{ status: "incompatible", count: 0, log: [] }`.
Every response has `cancellations: []`.
