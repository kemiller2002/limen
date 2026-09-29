# Work Queue

| ID | Work | Status | Tags | Priority |
|---|---|---|---|---|
| GH-57 | GH-57 | complete |  |  |
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
| WI-0054 | Guardrail: build-guests-site copies the guest host stylesheet (strict CSP, GH-18) | complete |  | medium |
| WI-0055 | Guardrail: CI runs smoke:security (strict CSP + Trusted Types, kernel and guests) as a required step (GH-18) | complete |  | medium |
| WI-0056 | Focus, selection and scroll capability pack: contract, provider, conformance, real-browser proof (GH-23) | complete |  | medium |
| WI-0057 | Guardrail: register the limen.focus contract unit and its generated TS/F#/C#/Rust bindings (GH-23) | complete |  | medium |
| WI-0058 | Guardrail: CI runs smoke:packs (every capability pack in Chromium under strict CSP) as a required step (GH-23) | complete |  | medium |
| WI-0059 | Language-neutral routing semantics (shared vectors) with the F# reference engine library (GH-20) | complete |  | medium |
| WI-0060 | Language-neutral form-state semantics (scenario vectors) with the F# reference engine library (GH-21) | complete |  | medium |
| WI-0061 | Kernel form-control values: checkbox checked state, radio groups, select-multiple values and submitter identity reach the engine (GH-21, found while defining form semantics) | complete |  | medium |
| WI-0062 | Language-neutral async-resource and optimistic-mutation semantics with the F# reference engine library (GH-22) | complete |  | medium |
| WI-0063 | Scheduling capability pack: timeout, animation frame, idle; typed, cancellable, exactly-once (GH-24) | complete |  | medium |
| WI-0064 | Guardrail: register the limen.schedule contract unit and its generated bindings (GH-24) | complete |  | medium |
| WI-0065 | Measurement and observer capability pack: rects, viewport, resize and visibility subscriptions, removed targets (GH-25) | complete |  | medium |
| WI-0066 | Guardrail: register the limen.measure contract unit and its generated bindings (GH-25) | complete |  | medium |
| WI-0067 | Kernel: data-on=input does not report uncommitted IME composition text; the committed value is reported at compositionend (GH-29) | complete |  | medium |
| WI-0068 | Rich browser event facts capability pack: opt-in keyboard, pointer, drag, composition, selection and input facts with declarative listener mechanics (GH-29) | complete |  | medium |
| WI-0069 | Guardrail: register the limen.events contract unit and its generated bindings (GH-29) | complete |  | medium |
| WI-0070 | Accessible interaction reference patterns (Forma proofs): tabs, menu, listbox, combobox, tree, grid, dialog over generic focus and event mechanics (GH-31) | complete |  | medium |
| WI-0071 | Kernel: HTML boolean attributes (inert, required, readonly, multiple, ...) are toggled by presence, never set to the string "false" (GH-31, found building the dialog pattern) | complete |  | medium |
| WI-0072 | Overlay and top-layer capability pack, native-first: dialog showModal/close, popover show/hide, dismissal facts, anchored placement fallback (GH-49) | complete |  | medium |
| WI-0073 | Guardrail: register the limen.overlay contract unit and its generated bindings (GH-49) | complete |  | medium |
| WI-0074 | Fix: smoke:packs must build the examples it serves (patterns page never reported in CI) (GH-31) | complete |  | medium |
| WI-0075 | Realtime capability pack: WebSocket and Server-Sent Events lifecycle facts, connection identity, explicit close, engine-directed reconnect only (GH-26) | complete |  | medium |
| WI-0076 | Guardrail: register the limen.realtime contract unit and its generated bindings (GH-26) | complete |  | medium |
| WI-0077 | User-mediated file capability pack: native input selection as facts, opaque file ids, bounded chunked reads, gesture-gated picker, download (GH-27) | complete |  | medium |
| WI-0078 | Guardrail: register the limen.files contract unit and its generated bindings (GH-27) | complete |  | medium |
| WI-0079 | IndexedDB structured-storage capability pack: engine-declared versioned schema, atomic transactions with typed outcomes, compare-and-put, version/schema/quota/unavailable outcomes (GH-28) | complete |  | medium |
| WI-0080 | Guardrail: register the limen.store contract unit and its generated bindings (GH-28) | complete |  | medium |
| WI-0081 | Governed third-party widget and custom-element adapter pack: identity and version, mount/update/command/unmount lifecycle, JSON-only facts, fault isolation, reference Web Component adapter and widget stub (GH-30) | complete |  | medium |
| WI-0082 | Guardrail: register the limen.adapters contract unit and its generated bindings (GH-30) | complete |  | medium |
| WI-0083 | Core HTTP profile, protocol 1.3 additive: text/base64/none response representations, response-header allowlist, explicit credentials, HEAD/OPTIONS, same-origin XSRF cookie-to-header binding; JSON default and OutcomeUnknown unchanged (GH-47) | complete |  | medium |
| WI-0084 | Guardrail: compile-pressure consumers name HttpFailureReason too-large (protocol 1.3, GH-47) | complete |  | medium |
| WI-0085 | Re-baseline payload budgets after the Core HTTP profile (protocol 1.3): about 1.7 KB gzip on every profile that loads the kernel (GH-47, GH-19) | complete |  | medium |
| WI-0086 | HTTP transfer profile pack: opt-in upload/download progress facts, uploads of picked files by opaque id and multipart, four-outcome semantics with OutcomeUnknown intact (GH-47) | complete |  | medium |
| WI-0087 | Guardrail: register the limen.transfer contract unit and its generated bindings (GH-47) | complete |  | medium |
| WI-0088 | HTTP engine library: pure interceptor composition, retry decisions that never blind-retry non-idempotent unknown outcomes, ETag revalidation cache, polling decisions; language-neutral vectors and F# reference (GH-47) | complete |  | medium |
| WI-0089 | Fix: a malformed projection partially mutated the view (texts applied before a later data-each/data-if/value error threw); validate the whole projection, including templates not yet mounted, before applying any of it (GH-50) | complete |  | medium |
| WI-0090 | Kernel lifecycle: read-only status and dispose() (removes every kernel listener, aborts in-flight effects, silences the kernel) so a host can restart safely (GH-50) | complete |  | medium |
| WI-0091 | Optional fatal-fallback host: mechanical host health, a static generic failure surface with a stable redacted error id, explicit restart and reload, bounded repeated restarts, federation unchanged (GH-50) | complete |  | medium |
| WI-0092 | Route/workflow-driven lazy federation loading: ensure with dependencies, explicit loading/ready/faulted/blocked, release with snapshot and deterministic restore, retry only on request (GH-33) | complete |  | medium |
| WI-0093 | Resource-hint and View Transition capability pack: idempotent preconnect/preload/modulepreload/prefetch, engine-labelled view transitions around the next projection, unsupported fallback (GH-34) | complete |  | medium |
| WI-0094 | Guardrail: register the limen.presentation contract unit and its generated bindings (GH-34) | complete |  | medium |
| WI-0095 | Environment evidence and native formatting pack: locale, languages, time zone, direction, opt-in preferences, change facts, typed Intl formatting for a supplied locale and time zone (GH-35) | complete |  | medium |
| WI-0096 | Guardrail: register the limen.environment contract unit and its generated bindings (GH-35) | complete |  | medium |
| WI-0097 | Localization engine library: BCP 47 negotiation, direction from language or script, message catalogues with fallback, placeholders and plural categories; language-neutral vectors and F# reference (GH-35) | complete |  | medium |
| WI-0098 | State-safe hot reload and fast edit loop: CSS swap in place, HTML remount, engine replacement restored only from an exactly compatible versioned snapshot, otherwise reset or full reload; dev server change stream (GH-36) | complete |  | medium |
| WI-0099 | Virtualization evidence gate: record that the #19 baseline does not justify virtualization (update cost is dominated by rewriting unchanged bindings and strict decoding), with the re-measurement that would reopen it; no runtime change (GH-37) | complete |  | medium |
| WI-0100 | Page, connectivity and browser lifecycle evidence pack: online/offline, visibility, pagehide/pageshow with persisted (bfcache), freeze/resume, advisory connection facts, prerendering; cancellable subscriptions (GH-43) | complete |  | medium |
| WI-0101 | Guardrail: register the limen.lifecycle contract unit and its generated bindings (GH-43) | complete |  | medium |
| WI-0102 | Offline outbox engine library: persisted pending operations, connectivity-gated ordered dispatch, conflict and OutcomeUnknown requiring engine reconciliation, reload makes in-flight unknown; language-neutral vectors and F# reference (GH-40) | complete |  | medium |
| WI-0103 | Core Http: a thrown fetch for a non-safe method is OutcomeUnknown(connection-lost), not a retryable Failure(network); protocol 1.4 (GH-40, found while proving the offline outbox) | complete |  | medium |
| WI-0104 | Guardrail: compile-pressure consumers name OutcomeUnknownReason (protocol 1.4) (GH-40) | complete |  | medium |
| WI-0105 | Re-baseline the minimal-consumer payload budget after protocol 1.4 (GH-40) | complete |  | medium |
| WI-0106 | Offline and application-update pack with an optional service worker: host-declared workers, explicit update-ready/activate lifecycle, cached shell; offline reference page proving cold offline launch, persisted outbox reconciliation, conflict, unknown outcome and the update path (GH-40) | complete |  | medium |
| WI-0107 | Guardrail: register the limen.offline contract unit and its generated bindings (GH-40) | complete |  | medium |
| WI-0108 | Worker-hosted WASM engines: a language-neutral dedicated-worker transport and worker host, F#, C# and Rust engines in a worker through the unchanged kernel, explicit worker faults and termination, and startup, latency, large-message and responsiveness measurements deciding the recommendation (GH-41) | complete |  | medium |
| WI-0109 | Guardrail: type-check the minimal-engine worker composition root (tsconfig.guests.json) (GH-41) | complete |  | medium |
| WI-0110 | Permission-sensitive capability pattern and geolocation pack: shared permission/availability/gesture conventions, denied vs unavailable, revocation facts (GH-42) | complete |  | medium |
| WI-0111 | Browser credentials (WebAuthn passkeys) pack under the permission pattern: create/get, gesture-required, verification left to the engine and server (GH-42) | complete |  | medium |
| WI-0112 | Guardrail: register the limen.geolocation and limen.credentials contract units and bindings (GH-42) | complete |  | medium |
| WI-0113 | Opaque high-performance rendering adapter pattern: a Canvas scatter-plot adapter behind the governed adapter contract, pointer/focus/resize integration, fault isolation, and a trace proving bounded cross-boundary chatter (GH-45) | complete |  | medium |
| WI-0114 | Cross-context coordination pack: same-origin channels (BroadcastChannel, SharedWorker hub), Web Locks with steal and loss facts, exact-origin frame messaging, validated JSON, context closure (GH-46) | complete |  | medium |
| WI-0115 | Guardrail: register the limen.coordination contract unit and bindings (GH-46) | complete |  | medium |
| WI-0116 | Core: the kernel binds <head> as well as <body>, so route-specific document metadata (title, description, robots, canonical) is a projection on the client as on the server (GH-38) | complete |  | medium |
| WI-0117 | Re-baseline the kernel-with-handles payload budget after head binding and the metadata policy (GH-38) | complete |  | medium |
| WI-0118 | Guardrail: a renderer layer (src/renderer) that may import the contract and the kernel's pure binding policy, never the BrowserKernel (GH-38) | ready |  | medium |
| WI-0119 | Optional server and static renderer: the same engine and projection render semantic HTML (head metadata included) for SSR and SSG, with browser-only capabilities explicitly absent on the server (GH-38) | ready |  | medium |
