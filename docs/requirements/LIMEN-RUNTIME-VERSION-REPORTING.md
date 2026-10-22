---
id: RQ-LIMEN-2026-A007
title: Browser runtime version reporting
status: accepted
version: 1.0.0
created: 2026-10-21
updated: 2026-10-21
owners:
  - limen
related_documents:
  - docs/core-mental-model.md
  - docs/where-code-goes.md
  - architecture/work-scopes/WI-0173.json
  - scripts/stamp-runtime.ts
  - test/runtime-version.test.ts
tags: [requirements, runtime-metadata, versioning, browser, playwright, wi-0173]
work_items: [WI-0173]
provenance:
  contributions:
    EXE-20261021T081649648Z-7f41973f:
      operations: [created]
      at: 2026-10-21T08:41:07.775Z
      actor:
        kind: agent
        id: openai/codex
        provider: openai
        model: unknown
        runtime: codex
      reason: "Define and implement build-stamped browser-kernel version reporting for Limen"
---

# Browser runtime version reporting

Limen implements the shared `ECHELON-RUNTIME-1` browser contract at its
emitted browser-kernel boundary. This is diagnostic metadata, not application
state, an effect, a capability, or a protocol message.

## Functional behavior

1. Executing the supported Limen browser kernel MUST create or reuse
   `window.__ECHELON_RUNTIME__` with `schemaVersion: 1` and register
   `libraries.limen`.
2. The `version` MUST equal the distributed npm artifact version that is
   actually executing. `commit` and `buildTime` MAY be omitted.
3. Registration MUST be independent, idempotent, asynchronous-safe, and order-
   insensitive. A compatible duplicate MUST be silent. A conflicting version
   MUST warn and MUST preserve the first registration.
4. A new registration MUST emit one concise production console diagnostic.
   The structured registry is authoritative.
5. Only `version`, `commit`, and `buildTime` may be retained. Environment
   variables, credentials, and arbitrary caller fields MUST NOT be exposed.

## Compatibility expectations

- Importing the package root or `@echelon-foundry/limen/kernel` in a browser
  MUST report Limen because both execute the browser-kernel artifact.
- Loading pure optional subpaths without the browser kernel MUST NOT falsely
  register Limen.
- The protocol, Core source, Core contract fingerprint, engine/application
  ownership, WASM transports, and browser initialization API MUST remain
  unchanged.
- The implementation MUST add no runtime dependency and MUST coexist with
  Forma, Folio, and future lowercase library identifiers.

## Build and release integration

After TypeScript compilation, the normal build MUST deterministically stamp
the version read from `package.json` into `dist/kernel/browser-kernel.js`.
Repeated builds MUST produce one stamp. The package side-effect declaration
MUST preserve the diagnostic through supported bundlers. Clock-derived build
metadata is omitted so rebuilding unchanged sources does not vary by time.

## Acceptance criteria and verification

- A Node test compares the stamped production artifact with `package.json` and
  executes the exact stamp to cover repeated registration, both orderings, all
  three shared-contract library names, conflict preservation, and metadata
  allow-listing.
- Existing Playwright Chromium and WebKit capability-pack runners read
  `window.__ECHELON_RUNTIME__` from production-built applications and compare
  `libraries.limen.version` with package metadata.
- The browser smoke suite verifies the same registry before exercising normal
  application behavior.
- Architecture, Core budget, layer, TypeScript, package, clean-room, site,
  browser, and Praxis checks pass with evidence attached to `WI-0173`.

## Machine-operability

Automation MUST read the registry object directly. It MUST NOT scrape console
text, inspect source filenames, or infer the version from a WASM payload.
