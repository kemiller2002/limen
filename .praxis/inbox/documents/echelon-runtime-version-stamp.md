# Echelon Runtime Version Stamp — Limen input

Status: proposed source input for Praxis.
Stable requirement: `RQ-LIMEN-2026-A007`.
Shared contract: `ECHELON-RUNTIME-1`.

## Objective

When Limen's browser kernel artifact executes, expose its actual distributed
version through `window.__ECHELON_RUNTIME__` and a concise production console
diagnostic without changing Core source, the engine boundary, or WASM hosts.

## Functional and compatibility requirements

- Register `libraries.limen.version` under schema version 1 independently of
  Forma, Folio, load order, and load timing.
- Repeated compatible registration is silent. Conflicting versions warn and
  preserve the first registration.
- Do not register merely because a pure optional library or an unrelated source
  file exists; registration occurs at the emitted browser-kernel boundary.
- Retain only allow-listed metadata and never environment values or secrets.
- Keep the protocol, Core contract fingerprint, WASM transport, and application
  initialization behavior unchanged.

## Build, acceptance, and machine verification

The normal TypeScript build must deterministically stamp the npm version from
`package.json` into the emitted browser kernel. No clock-derived field is
required. Unit tests must compare the emitted artifact with package metadata
and verify duplicate, ordering, combined-library, conflict, and allow-list
behavior. Existing Playwright Chromium and WebKit smoke runners must read the
registry from production-built pages and compare it to the package version.
