# Changelog

Notable changes to **Limen** (published as
`@echelon-foundry/typescript-wasm-kernel`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

> **`0.x` caveat.** The protocol may change in a minor release. Pin an exact
> version if that matters to you. See
> [docs/11-api-reference.md](docs/11-api-reference.md#stability-and-compatibility).

This file was introduced during the `0.6.1` work; entries for earlier versions
were reconstructed from the repository's history and are summaries rather than
exhaustive lists.

## [Unreleased]

### Architecture

- **Core has a machine-readable manifest (#60).**
  - `architecture/core.json` names the architecture version (1.0.0), the exact
    Core files, their public extension points, the approved root export
    families (each mapped to one of the seven canonical concepts), the six
    binding primitives, the four built-in capability families and the
    zero-runtime-dependency limit.
  - `npm run check:architecture` reads it and fails when:
    - a runtime file is in no layer, or in two;
    - Core gains an unlisted file;
    - Core imports any optional layer;
    - an optional layer imports a private Core file;
    - the kernel reads an undeclared `data-*` attribute;
    - the contract gains a fifth built-in family;
    - a runtime dependency appears;
    - the root exports an unapproved name.
  - Each rule has a failing fixture in `test/core-boundary.test.ts`.
  - The demo composition root (`src/main.ts`, `src/styles.css`) is now its own
    `reference-demo` layer.

- **A Core complexity budget gates every change (#62).**
  - `npm run check:core-budget` (in `npm test`) reports Core deterministically:
    - handwritten lines, bytes and normalized bytes;
    - generated code, reported separately;
    - emitted and gzip bytes;
    - root exports by family and protocol variants;
    - binding primitives, capability families, dependencies and concepts;
    - each Core entrypoint's module graph, and the optional groups.
  - It compares that report with `architecture/core-baseline.json`.
  - Hard gates fail outright:
    - a runtime dependency;
    - a seventh primitive or a fifth family;
    - an eighth concept or a new root export family;
    - optional code in the minimal graph, or Core importing an optional layer.
  - More than 10% growth in handwritten lines, normalized bytes, emitted Core
    or root exports needs a Core Admission.
  - The baseline records the #59 reference (9a835cc) as measured from Git,
    which CI re-verifies: 675 handwritten lines in 3 files.
  - The freeze point it approves is 1341 lines in 7 files (plus 1031
    generated). That growth predates the freeze and is recorded for the
    owner's decision in CA-0001.

- **Core Admission and the minimal-agent learning contract (#63).**
  - `docs/core-mental-model.md` is the one canonical Core document: the seven
    concepts, by the manifest's ids.
  - `AGENTS.md` now opens with exactly four required documents: the model,
    placement, `src/protocol.ts`, `examples/minimal`. Everything else is
    optional reading.
  - Every optional subsystem document (31 of them) opens by naming the Core
    concept it composes with.
  - `npm run check:docs` fails if any of this drifts, a quick start imports a
    non-Core entrypoint, or anything imports an optional name from the root.
  - `docs/core-admission.md` and `architecture/core-admissions/` define the
    15-field Core Admission record.
    - Records are guardrail-owned.
    - A new concept, export family, primitive or family needs two independent
      consumers.
    - A decision must name a person and link where it was made.
    - `npm run check:core-budget` validates every record.
  - CA-0001 records the growth that predates the freeze, pending the owner.

### Breaking

- **The package root exports Limen Core only (#61).**
  - Federation (`ModuleFederation`, `createLazyFederation`, `routeMatches`,
    `FederationError`, `FEDERATION_PROTOCOL_VERSION`,
    `noopFederationDiagnostics` and the federation types) is no longer exported
    from the root: import it from `…/federation`.
  - The reference engine (`ReferenceEngine`, `project`,
    `DirectTypeScriptTransport` and the demo domain types) is no longer
    exported from the root: import it from `…/reference-engine`, which now
    exports all of it (previously only `DirectTypeScriptTransport`).
  - There is no root shim, by design: a re-export would put both back into
    every minimal consumer's graph. Migration table in
    [docs/18](https://github.com/kemiller2002/limen/blob/main/docs/18-naming-and-compatibility.md#root-entrypoint-core-only).
  - `examples/minimal` — the minimal root consumer — now loads Core files only;
    `npm run check:architecture` (sources) and `npm run check:package` (the
    packed `dist/`) fail if an optional module re-enters its graph or an
    optional export returns to the root.

### Added

- **WebRTC peer connection pack (#44), `…/capabilities/peer`.**
  - Connections are opaque ids.
  - Offers, answers and ICE candidates are data the engine relays: signaling
    is the application's.
  - Local media comes from media-pack captures, and only through the
    `CaptureSource` the application passes in (`peerCapability({ captures:
    media })`).
  - Remote media plays in a named `<video data-peer-remote>`.
  - Connection state and remote tracks are facts.
  - `Rejected` (a refusal in the current state) is distinct from `Failed`.
  - `close` and `dispose()` end everything.
  - Verified in Chromium: two connections in one page connect with the
    engine relaying, and one plays the other's fake camera (8 checks).
  - The media pack gained `streamFor`.
  - See [docs/56](https://github.com/kemiller2002/limen/blob/main/docs/56-peer-connections.md).
- **Media capture and recording pack (#44), `…/capabilities/media`.**
  - Camera and microphone follow the permission pattern: availability,
    permission and each capture's outcome are kept apart.
  - Captures and recordings are opaque ids. Previews go into a
    `<video data-media-preview>` the HTML names, and recordings are read in
    1 MiB slices.
  - `Denied`, `DeviceUnavailable` (not found, in use, overconstrained),
    `TrackEnded`, `CaptureEnded`, `RecordingInterrupted` and `Cancelled` are
    explicit.
  - `stop`, `release`, a cancelled capture and `dispose()` each stop every
    track.
  - Verified in Chromium with fake devices, 11 checks. See
    [docs/55](https://github.com/kemiller2002/limen/blob/main/docs/55-media.md).
- **Optional server and static renderer (#38), `…/renderer`.**
  - `renderRoute` and `renderStatic` run the same engine and page as the
    browser, and write the settled projection, head metadata included, into
    semantic HTML, using the kernel's own binding policy.
  - Only Http is offered, and only with a fetch you supply. Storage,
    Clipboard and Navigation answer `Failure{unavailable}`; optional
    capabilities answer `Unsupported{not-negotiated}`; an engine that selects
    one is refused.
  - `data-client-only` sections are written as authored.
  - Rows and mounted sections carry the markers hydration (#39) will adopt.
  - The renderer never imports the BrowserKernel.
  - Streaming is not built: there is no measured use case yet.
  - See [docs/54](https://github.com/kemiller2002/limen/blob/main/docs/54-server-rendering.md).

### Changed

- **Strict decoding is 3.5 times faster, and exactly as strict (WI-0045, #19).**
  - Every generated TypeScript codec decodes lists and maps in one pass that
    stops at the first failure, and renders an error path only when decoding
    fails there.
  - Decoding a 10k-row view in Chromium went from 14.0 ms to 4.0 ms, and a
    1k-row view from 1.6 ms to 0.5 ms.
  - What is accepted and rejected, and every `DecodeError`, is unchanged. The
    optional `path` argument of a generated decoder also accepts a function
    that returns the path, so a caller's prefix is rendered only on failure.
- **Removing a keyed row moves no other row (WI-0044, #19).**
  - Rows whose keys left the list are removed before the reorder pass.
  - A middle removal from a 10k-row list went from 10,001 DOM mutations to
    1, and from 26.2 ms to 11.4 ms.
- **Projection skips unchanged writes (WI-0043, #19).**
  - The kernel compares each `data-text` and each plain or URL attribute with
    the live DOM before writing.
  - An unchanged 10k-row projection went from 10,000 DOM mutations to none
    (32.9 ms to 12.0 ms). A one-row update went from 10,000 mutations to 1.
  - Outside changes to a bound node are still corrected.

- **`<head>` is bound, and page metadata is a projection (#38).**
  - The kernel binds `<head>` with the same rules as `<body>`, so a route's
    `<title data-text>`, meta description and robots, and canonical link
    follow the engine on the client as the server renderer writes them.
  - The binding policy allows exactly the inert metadata forms: `content` on
    a descriptive `<meta name>` (or `property="og:*"`), and `href`/`hreflang`
    on `<link rel="canonical"|"alternate">`, with the URL checked.
  - `http-equiv`, `charset` and every other meta or link stay refused.
  - A page that already had bindings in `<head>` now has them applied.
- **Breaking for engines that retry on `Failure { network }`: a write whose
  connection drops is `OutcomeUnknown` (#40, protocol 1.4).**
  - Before: a thrown `fetch` was always `Failure { network }`, documented as
    retryable.
  - Proven in Chromium: a reset `POST` reached the server twice before `fetch`
    rejected. For `POST`, `PUT`, `PATCH` and `DELETE` while online, the outcome
    is now `OutcomeUnknown { reason: "connection-lost" }`.
  - Safe methods and requests made offline stay `Failure { network }`.
  - A 1.3 engine hears `OutcomeUnknown { timeout-after-dispatch }` instead.
  - `OutcomeUnknownReason` is a new contract enum; F#, C# and Rust consumers
    that matched `OutcomeUnknown` without a field must now name it (P-4 in
    `docs/DOCUMENTATION-AUDIT.md`).

- **HTML boolean attributes are toggled by presence (#31).** `data-bind-inert`,
  `-required`, `-readonly`, `-multiple` and every other boolean attribute are
  now present when the value is truthy and removed otherwise. Before, the
  kernel wrote `"false"`, which the browser reads as true. `check:views`
  requires a boolean kind for them.
- **`data-on="input"` no longer reports uncommitted IME composition text
  (#29).** Input events fired during composition are skipped. The committed
  value is reported once, at `compositionend`.
- **Breaking for pages that relied on it: binding targets are policed (#18).**
  A page that binds a now-forbidden target no longer starts. It reports a
  `binding` BridgeError naming the target and why. A page that projected a
  `javascript:` or `data:` URL now has that attribute removed. See
  `docs/29-binding-security.md`.
- **Repository renamed to `kemiller2002/limen`.** GitHub repository metadata,
  documentation links, Pages URL, current Praxis/ROS identity, CLI help, and
  validation checks now use the Limen repository name. The published npm
  package `@echelon-foundry/typescript-wasm-kernel` and legacy CLI alias remain
  unchanged for compatibility.

### Added

- **Accessible interaction reference patterns (#31).**
  `examples/09-accessible-patterns` covers tabs, a menu button, a listbox, a
  combobox, a tree, a right-to-left grid and a dialog. Each is a pure state
  machine, and every ARIA state is projected. Keys come from the events
  capability and focus moves through the focus capability; the kernel holds
  no widget logic. The patterns are proven with real key presses in Chromium
  and are reference proofs for the Forma project, which owns reusable
  patterns. The events capability gains a `direction` fact group and the
  `Space` key alias.
- **Virtualization evidence gate (#37): not met, and nothing is built.** The
  #19 baseline attributes the cost of large-list updates to rewriting
  unchanged bindings and to strict decoding (WI-0043, WI-0045), not to list
  size. The conclusion, and the re-measurement that would reopen it, are in
  DF-LIMEN-2026-0004.
- **State-safe hot reload (#36).** `./tooling/hot-reload` and `npm run dev`:
  - a pure reload plan: CSS swaps in place, HTML remounts, and an engine is
    restored only from a snapshot with exactly its version (otherwise it is
    reset); anything else reloads the page;
  - a dev server that streams file changes.
  Development only; nothing in Core imports it.
- **Cross-context coordination pack (#46).** `./capabilities/coordination`
  (`coordinationCapability()`, contract unit `limen.coordination`, with
  bindings for TypeScript, F#, C# and Rust) and the optional SharedWorker hub
  `./capabilities/coordination/hub`:
  - same-origin channels over BroadcastChannel or the hub, never echoed to the
    sender;
  - Web Locks with `Busy`, queueing, cancellation and a steal reported as
    `LockLost`; what a lock means stays the engine's;
  - point-to-point frame messaging with one exact origin, refusing the wrong
    origin and the wrong source;
  - every message size-bounded and checked as JSON before an engine sees it.

  The pack smoke runner gains second-tab actions and per-folder frame policies.
- **Rendering surfaces behind governed adapters (#45).**
  [Example 10](https://github.com/kemiller2002/limen/blob/main/examples/10-canvas-surface/README.md) and `docs/52`:
  - a canvas scatter plot draws at frame rate behind the existing adapters
    contract, with no new contract and no graphics primitive in Limen;
  - the engine sends a small scene as props and hears only semantic facts
    (a selection, a settled viewport);
  - measured in Chromium: 65 frames and 0 messages per idle second, and 71
    frames and 1 message for a 40-step drag;
  - focus through the focus pack, sizing kept inside the surface, and faults
    isolated with a remount.
- **Permission-sensitive capability pattern (#42).**
  `capability-support/permissions` and two packs, each with a contract unit
  and bindings for TypeScript, F#, C# and Rust:
  - `./capabilities/geolocation` (`limen.geolocation`), the device reference;
  - `./capabilities/credentials` (`limen.credentials`), for WebAuthn passkeys.

  The shared rules:
  - `Unavailable { reason }` is never a denial;
  - permission state is read without prompting, and `PermissionChanged`
    facts make a revocation visible;
  - nothing is asked at initialization;
  - gesture-bound operations are `NeedsGesture` without activation;
  - credentials are carried as base64url and never verified by the pack.

  The pack smoke runner now polls without granting user activation. Playwright's
  `page.evaluate` grants activation on every call, which could make gesture
  checks pass vacuously. The runner also gains permission, geolocation,
  virtual-authenticator and `localhost` support.
- **Worker-hosted engines (#41).** `./hosts/worker` (`WorkerTransport`) and
  `./hosts/worker-engine` (`serveEngine`):
  - any engine runs in a dedicated worker behind the same serialized contract;
    the kernel, the DOM and every effect stay on the main thread;
  - no DOM object or shared memory crosses, and the host never knows the guest
    language;
  - every worker failure is a named `WorkerFault` that terminates the worker
    and rejects what was in flight; under the fallback host it becomes an
    error id and a restart with a new worker;
  - `npm run bench:worker` measures startup, round trip, large messages and
    main-thread responsiveness. `docs/50` recommends a worker for long
    transitions, not for large views.
  `npm run smoke:guests` now runs the F#, C# and Rust engines in a worker too.
- **Offline and application-update pack (#40).** `./capabilities/offline`
  (`offlineCapability()`, contract unit `limen.offline`, with bindings for
  TypeScript, F#, C# and Rust) and the optional service worker
  `./capabilities/offline/worker`:
  - the engine registers a worker the host declared (and vouched for under
    Trusted Types), never a URL;
  - `UpdateReady`, `ControllerChanged` and `UpdateFailed` facts; a new version
    waits until the engine calls `activateUpdate`;
  - the worker caches a declared, versioned shell, serves it when the network
    fails, deletes only its own stale caches, and never touches a write;
  - push and background sync are reported, not enabled.
  The offline reference page proves a cold offline launch, a persisted outbox
  reconciled after a reconnect (conflict and unknown outcome included) and the
  update path in Chromium. The smoke runner lets a page name the Trusted Types
  policies its host creates.
- **Offline outbox engine library (#40).** `conformance/outbox/` (61 steps)
  and `libraries/fsharp/Limen.Outbox`:
  - pending domain operations in order, each with an engine-chosen
    idempotency id, sent one at a time and only while online;
  - a conflict or an unknown outcome stops the queue until the engine
    resolves or reconciles it; nothing is resent on its own, and an unknown
    outcome is never a failure;
  - a restored outbox starts offline, and what was in flight becomes unknown.
- **Page, connectivity and lifecycle evidence pack (#43).**
  `./capabilities/lifecycle` (`lifecycleCapability()`, contract unit
  `limen.lifecycle`, with bindings for TypeScript, F#, C# and Rust):
  - online/offline, visibility, pagehide/pageshow with the back/forward
    cache's `persisted`, freeze/resume, prerender activation and advisory
    connection quality, each a typed fact;
  - cancellable, topic-filtered subscriptions, each fact tagged with its own;
  - no `unload` or `beforeunload` listener, so pages stay cache-eligible;
  - the engine decides what each fact means; the pack never pauses or retries.
  The pack smoke runner gains offline, network-emulation and back/forward
  actions, and launches full Chromium for a page that needs the cache.
- **Localization engine library and semantics (#35).**
  `conformance/localization/` (34 cases) and `libraries/fsharp/Limen.Localization`:
  - BCP 47 negotiation;
  - direction from language or script;
  - message catalogues with fallback, placeholders and CLDR plural categories.
- **Environment evidence and formatting pack (#35).**
  `./capabilities/environment` (`environmentCapability()`, contract unit
  `limen.environment`, with bindings for TypeScript, F#, C# and Rust):
  - locale, language preferences, time zone and direction as explicit facts,
    with change facts;
  - presentation preferences reported only when named;
  - typed browser `Intl` formatting for a locale and time zone the engine
    states;
  - an injectable source, so a fake host can fix the environment.
- **Resource-hint and view-transition pack (#34).**
  `./capabilities/presentation` (`presentationCapability()`, contract unit
  `limen.presentation`, with bindings for TypeScript, F#, C# and Rust):
  - idempotent preconnect, dns-prefetch, preload, modulepreload and prefetch
    hints, never duplicating one already in the HTML;
  - labelled view transitions around the engine's next projection, where the
    engine asks first, the browser captures the old view, and
    `TransitionFinished` reports how it ended;
  - an `Unsupported` answer where the browser lacks the API, so the engine
    renders as usual.
  Animation and reduced motion stay in CSS.
- **Lazy federation loading (#33).** `createLazyFederation(federation)` loads
  modules when a route or workflow asks:
  - dependencies start first, and failures stay isolated;
  - a released module keeps its snapshot and is restored from it
    deterministically;
  - a faulted module is retried only through `retry()`.
  `ModuleFederation.reset()` is the explicit `Faulted` → `Unloaded` step.
- **Optional fatal-fallback host (#50).** `./hosts/fallback`
  (`startWithFallback`):
  - mechanical host health (`starting`, `available`, `unavailable`);
  - for an engine that cannot start, cannot initialize, is incompatible, or
    throws while running, the host preserves the last view as inert and
    covers it with a static, generic failure surface;
  - a stable, redacted error id (`LIMEN-<PHASE>-<ErrorName>`);
  - an explicit restart that restores the page's pre-start DOM with a fresh
    engine, bounded by `maxRestarts`, after which only reload is offered.
  Domain errors, malformed projections and federated module faults never
  take this path.
- **Kernel lifecycle for hosts (#50).** `BrowserKernel` gains a read-only
  `status` (`unstarted`, `starting`, `running`, `incompatible`, `faulted`,
  `disposed`) and `dispose()`. `dispose()` removes every listener the kernel
  registered, aborts in-flight effects without delivering their results, and
  silences the kernel, so a host can replace it. `KernelStatus` is exported.
- **Fixed: a malformed projection partially mutated the view (#50).** Values
  were written in document order, so a projection with, for example, a
  non-array `data-each` value still rewrote an earlier `data-text`. The kernel
  now validates the whole projection first, including sections and rows that
  would mount, and applies all of it or none of it. A rejected projection's
  effects still do not run.
- **HTTP engine library and semantics (#47).** `conformance/http/` defines
  interceptor composition, retry decisions, ETag revalidation and polling as
  pure, language-neutral rules (42 cases). `libraries/fsharp/Limen.Http` is
  the F# reference. An unknown outcome on a non-idempotent request is
  `reconcile`, never a blind retry. None of this is in the kernel.
- **HTTP transfer profile pack (#47).** `./capabilities/transfer`
  (`transferCapability({ files })`, contract unit `limen.transfer`, with
  bindings for TypeScript, F#, C# and Rust):
  - opt-in, throttled upload and download `Progress` facts;
  - uploads of files picked with the files pack, by opaque id, alone or as
    multipart, through the files pack's new explicit `fileFor` accessor;
  - Core Http's four outcomes, with `OutcomeUnknown` after a timeout.
  A request without progress registers no progress listener.
- **Core HTTP profile, protocol 1.3 (#47).** The `Http` effect gains optional
  fields, each absent by default, so the JSON path is unchanged:
  - `response` (`json`, `text`, `base64`, `none`), so non-JSON bodies no longer
    fail as `invalid-response`;
  - `responseHeaders`, which returns exactly the named headers;
  - explicit `credentials`;
  - `HEAD` and `OPTIONS`;
  - a same-origin-only `xsrf` cookie-to-header binding, so the engine never
    reads `document.cookie`.
  `Failure` gains `too-large`, for a `text` or `base64` body over 8 MiB.
  `OutcomeUnknown` semantics and redaction are unchanged. `PROTOCOL_MINOR` is
  now 3. **F#, C# and Rust engines that construct `HttpEffectRequest` or match
  `EffectOutcome.Success` must name the new fields**, which is the compile
  pressure the strong bindings exist for.
- **Governed adapter pack (#30).** `./capabilities/adapters`
  (`adaptersCapability({ adapters })`, contract unit `limen.adapters`, with
  bindings for TypeScript, F#, C# and Rust):
  - explicitly registered adapters with an exact id and version;
  - `mount`, `update`, `command` and `unmount` under opaque instance ids;
  - adapters speak only through JSON facts;
  - every adapter call is fault-isolated, and a faulted instance is
    quarantined;
  - a slot removed by a projection unmounts its instance.
  `./capabilities/adapters/web-component` is a separately loaded reference
  adapter whose surface is exactly its declared properties, events and
  commands.
- **IndexedDB structured-storage capability pack (#28).** `./capabilities/store`
  (`storeCapability()`, contract unit `limen.store`, with bindings for
  TypeScript, F#, C# and Rust):
  - the engine declares versioned stores and indexes; the pack creates what is
    declared and drops only what is named;
  - schema mismatches, version conflicts, blocked upgrades and unavailability
    are typed outcomes;
  - a transaction is atomic: `Committed` with every result, or `Aborted` with
    the reason and the failing operation;
  - `putIf` is a compare-and-put that rejects stale writes;
  - another tab's upgrade is reported as `VersionChanged`.
  `localStorage` support is unchanged.
- **User-mediated file capability pack (#27).** `./capabilities/files`
  (`filesCapability()`, contract unit `limen.files`, with bindings for
  TypeScript, F#, C# and Rust):
  - a native `<input type=file data-files-input>` selection arrives as a
    `Selected` fact with opaque file ids and metadata, and a dismissal as
    `PickerCancelled`; no `File` object or path crosses;
  - `pick` opens a picker only during user activation, and answers
    `NeedsGesture` otherwise;
  - reads are slices of at most 1 MiB, so large files are read in chunks;
  - `download` hands the browser a file through a revoked object URL.
- **Realtime and streaming capability pack (#26).** `./capabilities/realtime`
  (`realtimeCapability()`, contract unit `limen.realtime`, with bindings for
  TypeScript, F#, C# and Rust):
  - WebSocket and Server-Sent Events connections under opaque ids;
  - `Opened`, `Message`, `BinaryMessage` (size only) and exactly one terminal
    `Closed` as capability facts;
  - an engine's close silences the id, even for queued messages, so a
    replacement connection never hears the old one;
  - the pack never reconnects, and `EventSource`'s native retry is stopped;
  - URLs are refused by scheme, and the scheme only is reported.
- **Overlay and top-layer capability pack (#49).** `./capabilities/overlay`
  (`overlayCapability()`, contract unit `limen.overlay`, with bindings for
  TypeScript, F#, C# and Rust), native-first:
  - `showModal`, `show` and `close` on `<dialog>`, `showPopover` and
    `hidePopover` on `popover` elements, named by `data-overlay-target`;
  - the browser keeps the top layer, the inert background, focus entry and
    focus return;
  - a dismissal the engine did not ask for (Escape, light dismiss, a
    `method=dialog` form) arrives once as a `Dismissed` fact, which the engine
    adopts;
  - anchored popovers are placed on the engine's first preferred side that
    fits, and the answer says where;
  - `support` and `Unsupported` let the engine fall back to an inline
    `data-if` overlay.
- **Rich browser event facts capability pack (#29).** `./capabilities/events`
  (`eventsCapability()`, contract unit `limen.events`, with bindings for
  TypeScript, F#, C# and Rust):
  - `data-rich-*` listeners opt into keyboard, modifier, pointer (coordinates
    on request), drag, composition, selection, input and value facts;
  - preventDefault, stopPropagation, capture, passive, once, key filters and
    pointer capture are declared in HTML;
  - continuous streams can be coalesced per frame without reordering discrete
    events;
  - uncommitted IME text is never reported.
  The simple `data-event` path is unchanged.
- **Measurement and observer capability pack (#25).** `./capabilities/measure`
  (`measureCapability()`, contract unit `limen.measure`, with bindings for
  TypeScript, F#, C# and Rust):
  - bounding rectangles and viewport and scroll facts as plain JSON;
  - resize and visibility subscriptions with opaque ids, delivered as
    capability facts;
  - a removed target ends its subscription with exactly one `TargetRemoved`,
    then silence.
  `capability-support` gains a shared named-target resolver and handle
  enumeration.
- **Scheduling capability pack (#24).** `./capabilities/schedule`
  (`scheduleCapability()`, contract unit `limen.schedule`, with bindings for
  TypeScript, F#, C# and Rust) offers timeout, animation frame and idle
  wake-ups. Each answers exactly once: `Fired`, `IdleFired`, `InvalidDelay`,
  `Unsupported` or `Cancelled`. A cancellation that races the timer never
  also fires. Debounce and throttle stay engine policy. Intervals and
  prioritized tasks are deliberately absent until a reference case needs
  them.
- **Language-neutral async-resource and optimistic-mutation semantics with
  the F# reference library (#22).** `conformance/resources/` covers seven
  scenarios, 58 steps:
  - reads with explicit request identity, supersession, cancellation, stale
    rejection, refreshing over the previous value, and `uncertain` distinct
    from `failed`;
  - optimistic mutations layered over confirmed values, with explicit
    supersession and confirmations that never regress;
  - unknown outcomes that stay visible as `unresolved` until reconciled.
  `libraries/fsharp/Limen.Resources` is pure and agrees with every step.
- **Protocol 1.2: form-control state (#21).** `SemanticEvent` gains
  optional `checked` (checkbox and radio), `values` (multi-select selections
  and checkbox-group checked values) and `submitter` (the submitting
  button's name). The kernel sends them only to engines whose handshake
  answered 1.2, so 1.1 and legacy engines receive exactly the old shape.
  `Negotiation.Negotiated` now records the engine's protocol revision.
  Bindings are regenerated for TypeScript, F#, C# and Rust. The minimal
  engines stay on 1.1, as their specification says, which keeps a 1.1 engine
  on a 1.2 kernel under test in Chromium.
- **Language-neutral form semantics and the F# reference library (#21).**
  `conformance/forms/` defines engine-owned form state as data: nine
  scenarios, 87 steps. It covers typed sync validation, conditional
  requirement and visibility, correlated stale-safe async validation, keyed
  repeated rows, autofill reconciliation, server field and global errors,
  reset, and a submission lifecycle whose `unknown` outcome blocks
  resubmission until reconciled. `libraries/fsharp/Limen.Forms` is a pure
  engine library that agrees with every step. The kernel is unchanged; its
  form-control value gap is tracked separately.
- **Language-neutral routing semantics and the F# reference library (#20).**
  `conformance/routing/` defines routing as data: 40 resolutions, 12 builds
  and a deep-link, navigation and history session. It covers nested routes,
  typed path and query parameters with deterministic failures, wildcard
  fallback, redirects with loop rejection, guards as engine decisions (not
  authorization), resource preconditions and canonical links. Adopting a
  reported location never pushes. `libraries/fsharp/Limen.Routing` is a pure
  engine library that agrees with every vector (`npm run test:libraries`).
  The kernel and the protocol are unchanged.
- **Focus, selection and scroll capability pack (#23).** The first shipped
  optional pack: `./capabilities/focus` (`focusCapability()`, contract unit
  `limen.focus`, with bindings for TypeScript, F#, C# and Rust). It supports
  focus, blur, focusFirst/focusLast within a scope, text selection and
  scrollIntoView. Targets are named in HTML (`data-focus-target`, with an
  optional row key and screen generation), so no DOM node crosses the
  boundary. Outcomes are typed: `Done`, `NotFound`, `Ambiguous`,
  `NotFocusable`, `NotSelectable`, `InvalidRange`, `Stale`, `Unavailable`,
  `Cancelled`. Core is unchanged, and applications that do not register the
  pack do not load it. `npm run smoke:packs` proves every pack in Chromium
  under a strict CSP with Trusted Types.
- **Binding security (#18).** `data-bind-on*`, `style`, `srcdoc`, `srcset`,
  `ping` and `is`, and any `data-text`/`data-bind-*` on elements that load or
  run code (`<script>`, `<style>`, `<iframe>`, `<object>`, `<base>`, `<meta>`,
  `<link>`, SVG animation), are refused when the page starts (including
  inside templates). URL attributes are written only for `http`, `https`,
  `mailto`, `tel` or relative URLs, resolved as the browser resolves them;
  anything else is removed and reported without the value. The same rules are
  reported by `check:views`. `npm run smoke:security` proves in Chromium that
  the kernel and the F#, C# and Rust guests run under a strict CSP with
  Trusted Types enforced and no policy, with zero violations.

- **View contracts (#48).** A page may carry a language-neutral
  `*.view.json` beside it, stating what the engine projects and which events
  it accepts. `npm run check:views` (in `npm test`) checks every page's
  bindings against it with no browser: missing keys, list item fields and
  `data-key`, undeclared events, and value kinds a binding cannot use. The
  diagnostics name the file, line, element and expectation. The same
  contracts are held against real engines: the TypeScript examples, the
  reference engine, the F#, C# and Rust minimal engines through the shared
  session, and the F# site engine in its own tests. Exported as
  `./testing/views`. Runtime Core is unchanged.
- **Performance baseline and payload budgets (#19).** `npm run bench` drives
  the real kernel in Chromium (event, forms-100, list-1k/10k, routes,
  serialization, federation, directly and through the WebAssembly JSON
  boundary) and the F#, C# and Rust guests through one host, recording the
  environment with every result. The baseline is in
  `bench/results/baseline-2026-09-29.json` and
  `docs/27-performance-baseline.md`. Per-profile payload budgets
  (`bench/budgets.json`) are enforced by `npm test`, including that the
  minimal consumer loads no optional capability, tooling or host code.
- **Opaque handles and provider conformance (#32).** `./capability-support/handles`
  exports `createHandleTable`: browser resources stay browser-side, only ids
  cross, a disposed, unknown or other-session id is answered `Stale` with its
  reason, and host teardown runs every cleanup exactly once.
  `./testing/providers` exports `runProviderConformance`, one suite every
  capability pack runs against its own fixtures (malformed requests rejected,
  results within the pack's contract and plain JSON, cancellation settles).
- **One language-neutral contract (#16).** The wire protocol is now defined once,
  as data, in `contract/core.contract.json`, and the TypeScript types in
  `src/protocol.ts` are generated from it by `tools/contract-gen`
  (`npm run contract:generate`; `npm run contract:check` fails on stale,
  hand-edited, missing or orphaned bindings). Public names and shapes are
  unchanged. A strict generated decoder for every type is exported as
  `./contract`.
- **Contract fingerprint handshake (protocol 1.1, additive).** `Initialize`
  carries the host's protocol revision, core contract fingerprint and optional
  capability offers; the engine's `Initialize` response may accept or reject.
  The kernel applies nothing from an engine until the answer is verified, and
  an incompatible engine never receives normal traffic. Engines that send no
  handshake run exactly as before (legacy mode) unless the host sets
  `requireHandshake`. `answerHandshake` is the engine-side half.
- **Generic optional-capability envelope.** `EffectRequest.Capability`,
  `EffectResult.CapabilityResult` and `BrowserToEngineMessage.CapabilityFact`
  let a capability pack, registered via `new BrowserKernel(…, { capabilities })`
  and built with `defineCapability`, be added without changing Core. Requests
  to a capability that was not negotiated are answered `Unsupported`; payloads
  the pack's generated decoder rejects are answered `Rejected`.

- **F#, C# and Rust guest bindings (#52).** The same contract now generates
  `guests/fsharp/Limen.Contract`, `guests/csharp/Limen.Contract` and
  `guests/rust/limen-contract`, each in its language's strongest closed form
  (discriminated unions; closed record hierarchies with a generated exhaustive
  `Match`; enums), with strict decoders and encoders. All four languages run
  the shared vectors in `conformance/vectors/` and agree on every accepted value
  and on the exact path of every rejection; each independently recomputes the
  contract fingerprint. `npm run test:guests`; CI job "Guest bindings".

- **Dependency-direction and work-item-scope guardrails (#53).**
  `architecture/layers.json` + `npm run check:layers` (in `npm test`) reject
  Core → capability-pack/application imports, pack → pack imports, external
  runtime dependencies, computed dynamic imports, engine-library host
  authority, and browser runtime types in protocol code; the contract
  generator refuses browser-object type names. Each work item declares its
  placement and paths in `architecture/work-scopes/WI-####.json`;
  `npm run check:scope` (CI job "Work-item scope") checks every commit
  against it and requires `"guardrail": true` for guardrail-owned paths
  (`architecture/guardrails.json`, mirrored in `.github/CODEOWNERS`).
  `test/guardrails.test.ts` fails if a required gate leaves `npm test` or CI
  or a strictness setting is weakened. See `docs/25-guardrails.md`.

- **Restricted handwritten TypeScript (#54).** `npm run check:typescript`
  (in `npm test`) uses the TypeScript compiler API to reject `any`,
  suppression directives, `eval`/`Function`/string timers, HTML injection
  sinks, double assertions, `JSON.parse(…) as T`, handwritten copies of
  contract types, browser objects in capability messages, string-operation /
  untyped-payload / computed-member dispatch, and non-exhaustive switches over
  closed unions — each with a failing fixture. The kernel's two
  `as unknown as` casts are gone (IDL properties go through `Reflect`), and the
  site's F# WASM transport now decodes every engine response with the
  generated decoder instead of asserting it. Pre-existing debt in the
  federated transport is a count-exact ratchet tied to WI-0030.

- **Guest compiler enforcement (#55).** A Roslyn analyzer for C# guests
  (`LIMEN001` no `switch` over contract unions/enums — use the generated
  `Match`; `LIMEN002` no `dynamic`/object dictionaries; `LIMEN003` no direct
  wire plumbing), generated enum `Match`, typed Rust `parse_*`/`serialize_*`,
  and `npm run test:guests:pressure`: adding a contract variant makes the
  F#, C# and Rust reference consumers fail to compile, each with its own
  compiler error.

- **Multi-language WebAssembly parity proof (#17, LCP-001).** A minimal
  engine, specified language-neutrally with 65 normative session steps
  (`conformance/sessions/`), is implemented in F#, C# and Rust on the
  generated bindings, each with a guest handshake library; all three
  reproduce every step. Two optional host adapters — `DotnetWasmTransport`
  (`./hosts/dotnet-wasm`) and `RawWasmTransport` (`./hosts/raw-wasm`) — run
  them behind the unmodified kernel, decoding every response with the
  generated decoder. `npm run smoke:guests` (CI job) proves each engine's
  negotiated handshake and Http, Storage, Clipboard and Navigation
  success/failure paths in Chromium. Generated .NET runtimes are now
  trim-safe.

- **The product site's F# engine uses the generated contract.** Its
  handwritten `Protocol.fs` is gone; the engine speaks the generated F#
  binding, answers the fingerprint handshake with the shared guest library,
  and the site's kernel now requires it (`requireHandshake: true`).

- **Duplicate in-flight correlation ids are refused.** The kernel no longer
  executes an effect whose correlation id is still in flight (which used to
  overwrite the first effect's abort controller); it reports a protocol
  diagnostic instead. Ids may be reused after completion.

- **Fake host, trace and replay (#32, LCP-029/031).** `./testing` exports
  `createFakeHost` (a DOM-free kernel stand-in with a fake clock, location,
  history and storage, scripted or held outcomes, and timeout → OutcomeUnknown);
  `./trace` exports `tracingTransport` (a no-op when disabled), a redacting
  `exportTrace`, and `replay`, which reproduces a deterministic engine's final
  projection from a trace and reports divergences. Tooling layer; Core
  unchanged.

### Changed — compile-time pressure, by design

- `EffectRequest`, `EffectResult` and `BrowserToEngineMessage` each gained a
  member, so an exhaustive `switch` over them must now handle `Capability`,
  `CapabilityResult` and `CapabilityFact`.
- `DiagnosticEvent` gained `{ kind: "Handshake" }` and `BridgeError.phase`
  gained `"protocol"`. A diagnostics sink that assumed only `BridgeError` and
  `EffectTiming` must switch on `kind` (the kitchen-sink example did not, and
  threw in a real browser).
- `BrowserKernel.start()` called a second time is now refused with a
  diagnostic instead of re-binding the DOM.
- Events that arrive before the handshake completes are not dispatched (they
  are reported as `BridgeError { phase: "protocol" }`).

### Added (earlier in this release)

- **Federated engine runtime for multi-WASM applications.** `ModuleFederation`,
  `ModuleManifest`, versioned `FederationEnvelope` contracts, explicit module
  lifecycle, dependency/capability preflight, contract compatibility checks,
  domain-event fan-out, source identity enforcement, and bounded message
  delivery are now exported from the package root and `./federation`.
- **WASM federation guide.** `docs/23-wasm-federation.md` defines state
  ownership, cross-module transition requests, lifecycle, event/projection
  exchange, saga-style orchestration, deterministic testing, and anti-patterns.
  The main product application remains a single F# WASM consumer.
- **Real multi-F#-WASM federation existence proof.** Two independently
  published F#/.NET WebAssembly modules now load behind
  `ModuleFederation`, expose and validate their own manifests, decode wire
  payloads into local typed F# contracts, exchange a versioned transition
  request/result, and snapshot independent state. The real-Chrome gate requires
  distinct .NET runtime IDs and the completed exchange.
- **Federation failure isolation and diagnostics.** Transport exceptions now
  move only the affected module to an explicit `Faulted` state and surface
  `TransportFailure`. `FederationDiagnosticsSink` reports mechanical fault
  and startup-block metadata without payloads or raw exception messages, while
  `startAvailable()` can continue independent modules and keep dependents of
  unavailable modules blocked. Existing `startAll()` remains fail-fast.

## [0.6.2] — 2026-09-21

### Fixed

- **Language-aware browser capability detection.** JavaScript and TypeScript
  engine code still rejects direct browser globals such as `document` and
  `window`. F# and C# engine code now requires qualified browser bindings such
  as `Browser.Dom.document` or managed interop types before reporting a
  boundary violation, so ordinary domain identifiers named `document` or
  `window` no longer produce false positives.

## [0.6.1] — unreleased at the time of writing

> **Availability.** Everything in this entry is on `main` and is **not in
> `0.5.1`**, the newest published version. If you installed from npm before
> `0.6.1` is tagged, the `Clipboard` and `Navigation` capabilities do not exist
> in your copy, and requesting one produces a `BridgeError` with
> `phase: "effect"` and no result. The documents shipped inside the tarball
> describe the version you installed; the copies on GitHub describe `main`.

### Added

- **The Limen product site is now an F#/.NET WebAssembly consumer of the
  Limen boundary.** Application state, transitions, capabilities, obligations,
  stale-evidence handling, reconciliation and projection live in F#. The
  TypeScript site code is limited to `BrowserKernel`, runtime loading,
  diagnostics and JSON transport. A tiny C# `[JSExport]` method is marshalling
  glue only.
- **Nontrivial self-hosting demonstrations** replace the counter-oriented site:
  release/evidence gating, stale-result races, ambiguous external effects with
  reconciliation, and a twelve-case boundary-placement challenge.
- **A real-browser F# WebAssembly startup gate.** CI and Pages serve the built
  artifact in headless Chrome and require an initialization value produced by
  the F# engine to appear in the DOM.
- **F# site authority enforcement.** The architecture checker rejects
  JS/browser/I/O interop in the F# application engine and representative
  application logic in the C# export shim.

- **`Clipboard` capability.** `Clipboard { operation: "writeText", text }`, with
  `ClipboardOutcome` distinguishing `denied` (retry often works — browsers grant
  the write while a user gesture is fresh), `unavailable` (no Clipboard API in
  this browser or context; a retry can never work) and `unknown`. Read is
  deliberately absent. The copied text is never surfaced to diagnostics, under
  the same rule that keeps HTTP headers out of them.
  ([docs/clipboard.md](https://github.com/kemiller2002/limen/blob/main/docs/clipboard.md), `examples/07-clipboard/`)
- **`Navigation` capability.** `push`, `replace`, `back` and `forward`;
  `NavigationOutcome` reports `Success { location }` for the first two and
  `Dispatched` for the last two, because those only *ask* the browser to move.
  Cross-origin URLs are refused with `not-same-origin` rather than followed. No
  history state object is stored: the engine already owns the state a URL stands
  for. ([docs/routing.md](https://github.com/kemiller2002/limen/blob/main/docs/routing.md), `examples/08-routing/`)
- **`LocationChanged` message.** Sent when the browser moves through history on
  its own (Back, Forward, a gesture). It is not an `EffectResult`, because no
  effect was requested and nothing correlates it. An engine that ignores it
  still compiles and still works.
- **`Initialize` now carries `location`** — the URL the page was loaded at — so a
  routing engine can pick its first state from the address bar instead of
  rendering a default and then correcting itself.
- **`BrowserLocation` and `Capability` types**, exported from the package root
  and from `./protocol`. `BrowserLocation` carries `origin` as well as `path`,
  `query` and `hash`, which is what lets an engine compose an absolute,
  shareable link to the current screen — Navigation and Clipboard used together,
  and the main reason either capability exists. (The origin was omitted in the
  first draft of this protocol on the reasoning that an engine could be tempted
  to branch on it. That reasoning did not survive the use case: without it an
  engine can only build a relative path, and the alternative — reading
  `window.location` in the composition root and handing it in — smuggles a
  browser value across the boundary through a side channel nothing checks.)
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
- **`npm run smoke:browser`** — drives the counter, clipboard and routing
  examples in real Chromium, including reading the clipboard back and pressing
  the browser's own Back and Forward buttons. Playwright is not a dependency;
  the script skips and exits 0 without it.
- **A source-versus-documentation check.** `check-docs.ts` now extracts the
  string literals of eight protocol types from `src/` and fails when a
  documented declaration of the same type disagrees. A deliberately abbreviated
  declaration marks itself with an ellipsis. This exists because the capability
  work above made roughly eight documents stale and nothing noticed.

### Changed

- `Initialize.capabilities` is now `readonly Capability[]` rather than the
  literal tuple `readonly ["Http", "Storage"]`, and lists all four capabilities.
  It states what the **kernel implements**, never what the browser will permit:
  availability and permission are reported per effect, in that effect's own
  outcome.
- The README's documentation links are absolute. Relative links break when npm
  renders the README on npmjs.com, which was the previous behavior.
- The README now distinguishes the TypeScript browser kernel/reference engine
  from two real F# surfaces: the lifecycle CLI and the product site's
  application engine compiled to .NET WebAssembly.

### Fixed

- **Eight documents that denied a capability Limen had just gained.** The agent
  guide said no clipboard capability existed, the glossary said the router was
  "not implemented. No URL or history integration", the recipes carried both a
  "URL and history are not supported" warning and a `ClipboardOutcome` with two
  reasons instead of three, and the integration guide told prospective adopters
  that deep URL routing was unsupported. Found by giving two clean-context
  agents documentation-only access and asking them to build something.
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

## [0.6.0] — never published

Skipped. The `v0.6.0` tag was pushed at `5fcaf7e`, the tip of `main` at the
time, whose `package.json` still read `0.5.1` — the work above had not merged
yet. The publish workflow's version guard rejected the mismatch and stopped
before packing, so **nothing was published under this version** and npm went
straight from `0.5.1` to `0.6.1`.

A repository ruleset prevents deleting or re-pointing a tag, so `v0.6.0` cannot
be moved to the right commit; the same thing happened to `v0.5.0`. The version
number is burned rather than reused, because a tag that exists and points at
the wrong tree is worse than a gap in the sequence.

## [0.5.1] — 2026-09-14

### Fixed

- The release workflow creates its pack destination before packing.

## [0.5.0] — 2026-09-14

### Added

- **The Limen name** across human-facing surfaces. No exported symbol, file path
  or protocol type was renamed, and nothing was deprecated
  ([docs/18-naming-and-compatibility.md](https://github.com/kemiller2002/limen/blob/main/docs/18-naming-and-compatibility.md)).
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

[Unreleased]: https://github.com/kemiller2002/limen/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/kemiller2002/limen/compare/v0.5.1...HEAD
[0.5.1]: https://github.com/kemiller2002/limen/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/kemiller2002/limen/releases/tag/v0.5.0
