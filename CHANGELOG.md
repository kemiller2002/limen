# Changelog

Notable changes to **Limen** (published as
`@echelon-foundry/typescript-wasm-kernel`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

> **`0.x` caveat.** The protocol may change in a minor release. Pin an exact
> version if that matters to you. See
> [docs/11-api-reference.md](docs/11-api-reference.md#stability-and-compatibility).

This file was introduced during the `0.6.0` work; entries for earlier versions
were reconstructed from the repository's history and are summaries rather than
exhaustive lists.

## [Unreleased]

### Added

- **`Clipboard` capability.** `Clipboard { operation: "writeText", text }`, with
  `ClipboardOutcome` distinguishing `denied` (retry often works — browsers grant
  the write while a user gesture is fresh), `unavailable` (no Clipboard API in
  this browser or context; a retry can never work) and `unknown`. Read is
  deliberately absent. The copied text is never surfaced to diagnostics, under
  the same rule that keeps HTTP headers out of them.
  ([docs/clipboard.md](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/clipboard.md), `examples/07-clipboard/`)
- **`Navigation` capability.** `push`, `replace`, `back` and `forward`;
  `NavigationOutcome` reports `Success { location }` for the first two and
  `Dispatched` for the last two, because those only *ask* the browser to move.
  Cross-origin URLs are refused with `not-same-origin` rather than followed. No
  history state object is stored: the engine already owns the state a URL stands
  for. ([docs/routing.md](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/routing.md), `examples/08-routing/`)
- **`LocationChanged` message.** Sent when the browser moves through history on
  its own (Back, Forward, a gesture). It is not an `EffectResult`, because no
  effect was requested and nothing correlates it. An engine that ignores it
  still compiles and still works.
- **`Initialize` now carries `location`** — the URL the page was loaded at — so a
  routing engine can pick its first state from the address bar instead of
  rendering a default and then correcting itself.
- **`BrowserLocation` and `Capability` types**, exported from the package root
  and from `./protocol`.
- **Documentation**: `docs/quick-start.md`, `docs/mental-model.md`,
  `docs/where-code-goes.md`, `docs/traces.md`, `docs/routing.md`,
  `docs/clipboard.md`. Three new anti-patterns, four new recipes, and a README
  restructured as an orientation document.
- **A README for every example**, covering state model, event and effect flow,
  exercises, and the mistakes people actually make with it.
- **`examples/minimal/`** — a complete four-file application in plain JavaScript,
  shipped **inside the npm package**, importing the kernel by its published
  package name.
- **Documentation in the npm package**: quick start, mental model,
  where-code-goes, API reference, troubleshooting and glossary now ship in the
  tarball, alongside `CHANGELOG.md` and the minimal example.
- **`npm run check:package`** — verifies the tarball's contents against an
  expected manifest, and that every link in packaged documentation resolves
  either to another packaged file or to a path that exists in the repository.
- **`npm run check:clean-room`** — packs the tarball, installs it into an empty
  project, and builds and smoke-tests the minimal example against the
  *installed* package rather than the repository.

### Changed

- `Initialize.capabilities` is now `readonly Capability[]` rather than the
  literal tuple `readonly ["Http", "Storage"]`, and lists all four capabilities.
  It states what the **kernel implements**, never what the browser will permit:
  availability and permission are reported per effect, in that effect's own
  outcome.
- The README's documentation links are absolute. Relative links break when npm
  renders the README on npmjs.com, which was the previous behavior.
- The README now states plainly what F# is and is not here: the lifecycle CLI,
  not the application engine. The engine is TypeScript, and no WASM engine
  exists yet.

### Fixed

- **An effect kind the kernel cannot run is reported** as
  `BridgeError { phase: "effect" }` instead of raising an unhandled rejection
  and silently sending no result. The `"effect"` phase had been declared in
  `DiagnosticEvent` since the beginning and never emitted. An engine waiting on
  a correlation id that will never be answered is the hardest Limen failure to
  diagnose, so it is now the loudest thing the bridge says.
- **`@echelon-foundry/repository-operating-system` moved to `devDependencies`.**
  It is governance tooling, not runtime code — nothing under `src/` imports it.
  Every consumer of Limen was installing it transitively, which also contradicted
  the README's "no runtime dependencies" claim.

## [0.5.1] — 2026-09-14

### Fixed

- The release workflow creates its pack destination before packing.

## [0.5.0] — 2026-09-14

### Added

- **The Limen name** across human-facing surfaces. No exported symbol, file path
  or protocol type was renamed, and nothing was deprecated
  ([docs/18-naming-and-compatibility.md](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/18-naming-and-compatibility.md)).
- **The lifecycle CLI** — `init`, `status`, `verify`, `upgrade`, `doctor` —
  implemented in F# and shipped as self-contained binaries for Linux x64/arm64,
  Windows x64 and macOS x64/arm64. No .NET runtime required to use it.
- **The Limen website**, built as a Limen application and verified by its own
  test suite.
- Cross-platform CLI verification in CI.

### Fixed

- Two silent-failure defects: a `data-if`/`data-each` written on a non-`<template>`
  element now fails loudly instead of being ignored, and a conditionally-shown
  form field now registers its pending-value flush correctly.
- The demo entry point is no longer shipped in the package.

## [0.4.1] and earlier

Pre-release development, beginning at `0.2.1`: the protocol, the browser kernel,
the reference engine, the six original examples, the documentation set, and the
architecture and documentation checks. See the repository history.

[Unreleased]: https://github.com/kemiller2002/typescript-wasm-kernel/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/kemiller2002/typescript-wasm-kernel/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/kemiller2002/typescript-wasm-kernel/releases/tag/v0.5.0
