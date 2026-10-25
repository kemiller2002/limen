# LIM-HTTP-001: Explicit cache mode on the Http effect

Status: proposed source input for Praxis.
Priority: P2
Owner system: Limen (protocol and browser kernel)
Intake: Praxis document ingestion. Source material, not a canonical requirement.
Consolidation: kemiller2002/cohort-based-engineering `research/consolidation/2026-10-24/engineering-improvement-priorities.md` item 4.

## Evidence (observed in two applications)

- **One class, fixed twice in applications.** The Causa rehearsals fixed the stale-mutable-read class (R2 DC-005)
  in the application each time, and it recurred in R3:
  - **D-07:** the page stayed "connected" with a rejected token on real GitHub;
  - **review M2:** the first nonce repeated across page loads.
  - Source: kemiller2002/indy-init-rehearsal-003 `research/rehearsal-003-defect-analysis.md`.
- **Both fixes are URL nonces,** because "the Limen Http effect has no cache mode, and GitHub's CORS policy refuses a
  `Cache-Control` request header" (same source, D-07).
- **The code agrees.** `src/kernel/browser-kernel.ts` `#runHttp` (`1cf75cb`) calls `fetch` with method, signal,
  headers, credentials and body only.
- **The mechanism is unconfirmed.** R3 inferred that the browser HTTP cache served it but did not observe this
  directly; GitHub also sends `Vary: Authorization`.

## Requirement (proposed)

- **LIM-HTTP-001-R1.** `HttpEffectRequest` gains an optional `cache` field with the `RequestInit.cache` values
  (`default`, `no-store`, `reload`, `no-cache`, `force-cache`, `only-if-cached`). The kernel passes it to `fetch`
  unchanged. When it is absent, the request is exactly today's request.
- **LIM-HTTP-001-R2.** The change is an additive protocol change: the contract is updated in
  `contract/core.contract.json`, and the bindings (TypeScript, F#, C#, Rust) are regenerated.
- **LIM-HTTP-001-R3.** Documentation states that `RequestInit.cache` adds no request header. It is therefore not
  subject to CORS preflight on `Cache-Control`, unlike the header the rehearsals could not send.

## Acceptance criteria

- `npm run contract:check` passes, and every guest binding round-trips the new field through the shared vectors.
- A kernel test asserts that `fetch` receives `cache: "no-store"` when requested, and no `cache` key when absent.
- A real-browser test against a server that answers `Cache-Control: private, max-age=60` serves the second
  `no-store` request from the network.
- **Before any application relies on it,** a live test against real GitHub reproduces R3 Test F (connect anonymously,
  then reconnect with an invalid token) without a URL nonce, and reports authentication failure. If that test fails,
  the application keeps the nonce, and the finding is recorded here.

## Not claimed

That this alone closes DC-005. Applications still decide which reads are mutable. Pinning file reads to an immutable
SHA remains correct.
