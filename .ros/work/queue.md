# Work Queue

| ID | Work | Status | Tags | Priority |
|---|---|---|---|---|
| LIMEN-UPGRADE-2026-09-21 | Reconcile Limen self-hosting with current Echelon capabilities | complete | tooling,limen,ordo,ros | high |
| ROS-INSTALL-1-2-1 | ROS-INSTALL-1-2-1 | complete |  |  |
| WI-0001 | Release npm version 0.4.1 with ROS attribution | complete | npm, release | high |
| WI-0002 | Documentation audit and reconstruction: rewrite README/AGENTS, add docs/ set, six verified examples, docs+example CI verification | complete | docs, examples, ci | high |
| WI-0003 | Limen productization: name the kernel Limen in human-facing surfaces, rewrite README/AGENTS front door, preserve compatibility-sensitive identifiers | complete | limen, naming, docs | high |
| WI-0004 | Fix kernel silent-failure defects P-1/P-2, packaging D-9, transport clarity A-1; publish evidence findings | complete | limen, defect, evidence | high |
| WI-0005 | Limen showcase site: Echelon Foundry identity, interactive demos driven by real Limen, Pages deployment | complete | limen, site, pages | high |
| WI-0006 | Standardized Echelon lifecycle CLI: F# core + npm bootstrap for init/status/verify/upgrade/doctor | complete | tooling | high |
| WI-0007 | Document the lifecycle conversion: CLI reference, installation and ownership, conversion report | complete | documentation | medium |
| WI-0008 | Make --verbose meaningful on verify, init and upgrade | complete | tooling | low |
| WI-0009 | Record cross-platform CI results in the CLI documentation | complete | documentation | low |
| WI-0010 | Release 0.5.0: first release carrying the Limen lifecycle CLI | complete | release | high |
| WI-0011 | Record the hosted-sandbox git and toolchain limits in CLAUDE.md | complete | documentation | medium |
| WI-0012 | Fix the release workflow: npm pack --pack-destination needs the directory to exist | complete | tooling | high |
| WI-0013 | Release 0.5.1: republish after the v0.5.0 pack failure | complete | release | high |
| WI-0014 | Add Clipboard and Navigation browser capabilities to the Limen protocol and kernel | complete | capability, protocol | medium |
| WI-0015 | Add clipboard, routing and npm-minimal examples with per-example READMEs | complete | examples, documentation | medium |
| WI-0016 | Documentation: mental model, where-code-goes, quick start, traces, routing and clipboard guides | complete | documentation | medium |
| WI-0017 | npm packaging: ship documentation and a minimal example, verify tarball contents, add a clean-room consumer check | complete | packaging | medium |
| WI-0018 | Surface the new capabilities and documents on the Limen site, and record the usability report | complete | documentation, site | medium |
| WI-0019 | Sweep the documents the new capabilities made stale, add BrowserLocation.origin, and guard against the recurrence | complete | documentation, protocol | medium |
| WI-0020 | Record the decision to defer Playwright adoption rather than leave it an open question | complete | documentation | medium |
| WI-0021 | Release as 0.6.1: the v0.6.0 tag was pushed at the pre-merge commit and cannot be re-pointed | complete | release | medium |
| WI-0022 | Rework the Limen site around product value, architectural clarity, verified evidence, and honest WASM status | complete | limen, site, evidence, documentation | high |
| WI-0023 | Define and implement federated multi-WASM modules with typed transitions | complete | limen, wasm, federation, architecture | high |
| WI-0024 | Complete GitHub repository rename from typescript-wasm-kernel to Limen | complete | limen, rename, repository, documentation, pages | high |
| WI-0025 | Demonstrate federation with two independent F# WebAssembly modules | complete | limen, wasm, federation, fsharp, existence-proof | high |
| WI-0026 | Add federation failure isolation and diagnostics | complete | limen, wasm, federation, diagnostics, resilience | high |
| WI-0027 | Ignore federation WASM publish outputs so ros validate passes after a build | complete | build,mechanical | medium |
| WI-0028 | GH-16 LCP-002: versioned capability extension architecture (neutral contract source, TS generation, fingerprint handshake, generic capability envelope) | complete | limen,gh-16,lcp-002,core,contract | high |
| WI-0029 | Repair ROS validation findings from WI-0028: DF identifier format and invalid telemetry classification | complete | ros,mechanical | medium |
| WI-0030 | Bring the federation envelope protocol (src/federation.ts) under the language-neutral contract; it is a second wire protocol defined only in TypeScript (carried from GH-16 / DF-LIMEN-2026-0001) | captured | carried-obligation | medium |
| WI-0031 | Duplicate in-flight correlation id overwrites the kernel's AbortController (Http and Capability effects); add a negative conformance vector and a defined outcome (GH-32) | complete | carried-obligation | medium |
| WI-0032 | ROS 3.1.3 'work start --classification' accepts values that 'validate' rejects (e.g. boundary-change); report upstream to repository-operating-system | captured | carried-obligation | medium |
| WI-0033 | GH-52: deterministic F#/C#/Rust contract generation, cross-language fingerprint agreement, shared semantic vectors | complete | limen,gh-52,contract,guardrail | high |
| WI-0034 | GH-53: enforce dependency directions (layer map + import checker) and work-item path scope (scope manifests + commit-level check), guardrail self-modification protection | complete | limen,gh-53,guardrail,governance | high |
| WI-0035 | GH-54: restricted handwritten TypeScript boundary checker (compiler-API based) with failing fixtures; remove existing escape hatches from Core and the core WASM transport | complete | limen,gh-54,guardrail | high |
| WI-0036 | GH-55: guest compiler enforcement — added-variant compile pressure in F#/C#/Rust, Roslyn analyzer for C# closed-union handling and escape hatches, C# enum Match | complete | limen,gh-55,guardrail,guests | high |
| WI-0037 | GH-17 LCP-001: minimal F#, C# and Rust WASM engines on the generated contract — guest handshake, shared session vectors, generic .NET and raw-wasm host transports, real-browser proof of Http/Storage/Clipboard/Navigation per guest | complete | limen,gh-17,lcp-001,wasm,guests | high |
| WI-0038 | GH-17 follow-up: move the product site's F# engine off its handwritten Protocol.fs onto the generated F# binding and guest handshake | complete | limen,gh-17,site,fsharp | high |
| WI-0039 | GH-32 part 1 (LCP-029/031): fake host with deterministic clock/location/outcomes, and redacted trace + replay tooling outside Core | complete | limen,gh-32,tooling,conformance | high |
| WI-0040 | Federation WASM projects publish into their own project directory, so repeated local builds nest publish/publish/... until MSB3030; exclude publish/** from their items | complete | build,site,federation | medium |
| WI-0041 | GH-32 part 2 / GH-51 §7: opaque-handle lifecycle support for capability packs, a handle fixture capability, and a generic provider conformance suite with negative cases | complete | limen,gh-32,gh-51,conformance,handles | high |
| WI-0042 | Performance baselines: projection, lists, forms, guests, minimal-consumer size (GH-19) | complete |  | medium |
| WI-0043 | Projection: skip writes to bindings whose value is unchanged (evidence: list-10k noop = 10000 DOM mutations, 22.8ms; bench baseline 2026-09-29, GH-19) | captured |  | medium |
| WI-0044 | Keyed lists: removing a row must not move every following row (evidence: list remove = 2x mutations of insert; GH-19) | captured |  | medium |
| WI-0045 | Generated TS decoder throughput: strict decode is 10x JSON.parse for a 10k-row view (17.1ms vs 1.7ms) without weakening strictness (GH-19) | captured |  | medium |
| WI-0046 | F# guest payload: 26 MB and 188 requests vs C# 5.4 MB because FSharp.Core is published untrimmed; find a trim-clean path with no warning suppression (GH-19) | captured |  | medium |
| WI-0047 | Minimal-consumer import surface: package root loads the reference engine and federation; the kernel loads the whole core codec to decode one handshake (GH-19) | captured |  | medium |
| WI-0048 | Guardrail: strict compiler config for the benchmark page (tsconfig.bench.json) (GH-19) | complete |  | medium |
| WI-0049 | Static HTML/projection/event contract validation: adjacent view contracts, checker, engine conformance (GH-48) | complete |  | medium |
| WI-0050 | Guardrail: check:views — every bound page against its view contract, a required npm test gate (GH-48) | complete |  | medium |
| WI-0051 | Binding security: forbidden targets, URL scheme policy, Trusted Types/strict CSP smoke, diagnostics redaction (GH-18) | complete |  | medium |
| WI-0052 | Guardrail: check:views runs the built checker from dist/ (the checker now shares the kernel's binding policy module) (GH-18) | complete |  | medium |
| WI-0053 | Raise kernel payload budgets for the binding security policy (+2.1 KB gzip, GH-18) | complete |  | medium |
| WI-0054 | Guardrail: build-guests-site copies the guest host stylesheet (strict CSP, GH-18) | active |  | medium |
| WI-0055 | Guardrail: CI runs smoke:security (strict CSP + Trusted Types, kernel and guests) as a required step (GH-18) | complete |  | medium |
