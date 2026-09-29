---
identifier: DF-LIMEN-2026-0003
title: F#, C# and Rust WebAssembly engines share one contract, one session spec and one kernel
type: decision-record
status: accepted
version: 1.0.0
author_agent: claude-code
created: 2026-09-29
updated: 2026-09-29
related_projects: [limen]
related_documents:
  - conformance/sessions/minimal-engine.md
  - conformance/sessions/minimal.session.json
  - src/hosts/dotnet-wasm-transport.ts
  - src/hosts/raw-wasm-transport.ts
supersedes: []
superseded_by: []
tags: [wasm, fsharp, csharp, rust, conformance, lcp-001]
work_items: [WI-0037]
external_references: ["kemiller2002/limen#17", "kemiller2002/limen#15"]
---

# DF-LIMEN-2026-0003 — F#, C# and Rust WebAssembly engines share one contract, one session spec and one kernel

## Decision

1. **The engine's behavior is specified language-neutrally.**
   [`minimal-engine.md`](../../conformance/sessions/minimal-engine.md) is the
   spec, and [`minimal.session.json`](../../conformance/sessions/minimal.session.json)
   is its normative form: 65 message-by-message steps across 7 sessions. The
   sessions cover every built-in capability, the uncertain, cancelled and
   failed outcomes, stale results, browser moves, and three kinds of refused
   handshake.
2. **There are three independent implementations:** F#, C# and Rust, under
   `guests/minimal/`. Each is written against its generated binding and runs
   the sessions natively through its real JSON edge. Each also has its own
   guest handshake library (`Limen.Guest` / `limen-guest`) implementing the
   same rule as `src/guest/handshake.ts`.
3. **There are two generic host adapters,** both optional (layer
   `host-adapter`):
   - `DotnetWasmTransport` works for any .NET language and calls one
     `[JSExport]` method.
   - `RawWasmTransport` works for any language that can export
     `limen_alloc`/`limen_dispatch`/`limen_free` over linear memory.

   The composition root supplies the loaders, so neither adapter contains a
   computed import. Both decode every engine response with the generated
   decoder before the kernel sees it.
4. **The real-browser proof uses one unmodified kernel.**
   `scripts/smoke-guests.ts` loads each engine behind `requireHandshake: true`
   and requires a negotiated handshake. For every capability it checks a
   success and a failure path where Chromium can produce one, and it checks
   that the browser's own Back is adopted without a push. It is a CI job.

## Negative knowledge

- **FSharp.Core 8.0.102 is not trim-clean.** Its own ILLink descriptors raise
  IL2104, IL2008 and IL2040. Guest projects may not suppress warnings, so the
  F# WebAssembly host publishes untrimmed. The size cost is recorded for #19
  rather than hidden. The C# host trims cleanly.
- **The generated .NET runtimes originally quoted strings with
  `JsonSerializer.Serialize`,** which is reflection-based and fails trim
  analysis. Warnings-as-errors caught this; the quoting is now
  reflection-free.
- **A Rust `#[no_mangle]` export trips `unsafe_code`,** and passing strings
  across linear memory needs raw pointers. These are isolated in
  `limen-minimal-wasm`. That crate has no decision, state or decoding. It
  is the only Rust guest crate allowed to be unsafe, and it is named in
  `architecture/guardrails.json` with a written justification that
  `test/guardrails.test.ts` requires.
- **A Storage failure cannot be produced deterministically in stock
  Chromium.** The Storage failure paths are therefore proven by the session
  vectors (`quota-exceeded`) and the kernel's jsdom tests, not in the
  browser.

## Consequences

- LCP-001 is covered, with a real-browser test, for Http, Storage, Clipboard
  write and Navigation, in F#, C# and Rust.
- The site's F# engine still carries a handwritten protocol module. Moving
  it onto the generated binding is its own work item, rather than part of
  this one.
