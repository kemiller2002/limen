# Working in this repository

Start here. This file is the on-ramp; it points to the detailed docs rather
than duplicating them. If something here and a linked doc disagree, the doc
is more likely current — but treat that as a bug to fix (in whichever file
is stale), not something to silently pick a side on.

## This repository is Limen

**Limen** is the product name for the architecture implemented here: an
explicit boundary keeping browser capabilities separate from application
authority. The published package is still
`@echelon-foundry/typescript-wasm-kernel`, and **no exported symbol, file path,
or protocol type was renamed** — see
[docs/18-naming-and-compatibility.md](docs/18-naming-and-compatibility.md).

"Kernel" is still correct for the **browser-side bridge** (`BrowserKernel`,
`src/kernel/`) — not for the product, and not for the application side.

## Before meaningful changes: open a ROS work item

CI's `validate` job rejects branches whose changes lack work-item attribution.
Run `./ros add "…"` → `./ros work ready WI-####` → `./ros work start WI-####`
**before** editing, and complete it with `ROS_BASE_REF=origin/main ./ros work
complete WI-#### --evidence …` afterwards. See
[AGENTS.md](AGENTS.md) Part 1 for the exact sequence.

## There is no WebAssembly in this repository

No `.wasm` file, no loader, no `WebAssembly.instantiate`. The name describes
the *boundary shape* — narrow and serializable, therefore WASM-ready. The
component that owns application meaning is called **the engine**, and it is
TypeScript today (`src/engine/`). If you went looking for the WASM and could
not find it, nothing is missing: read
[docs/17-wasm-migration.md](docs/17-wasm-migration.md).

Note the terminology collision: **kernel** here means the *browser-side
bridge* (`BrowserKernel`), the opposite side of the boundary from the engine.
See [docs/glossary.md](docs/glossary.md).

## The lifecycle CLI lives in `cli/` and is F#

The same npm package ships a lifecycle tool — `init`, `status`, `verify`,
`upgrade`, `doctor` — implemented in F# under `cli/Limen.Core/` (the domain) and
`cli/Limen.Cli/` (argument parsing and rendering only). `bin/limen.js` is a
launcher that picks a platform binary and forwards arguments; **no lifecycle
logic belongs in it**.

The layering mirrors this repository's own rule: inspect → plan → validate →
execute → verify, with planning pure and `Execute.fs` the only module that
writes. If you find yourself reading the filesystem inside the planner, that is
the boundary breaking.

It is under `cli/` rather than `src/` deliberately: `src/` is the published
TypeScript library, governed by the engine/kernel rule below, and mixing a
second language into it would muddy that rule. See
[docs/20-lifecycle-cli.md](docs/20-lifecycle-cli.md) and
[docs/21-installation-and-upgrade.md](docs/21-installation-and-upgrade.md).

Note: `.NET SDK 8` is installable here via `apt-get install dotnet-sdk-8.0`
(the Ubuntu archive works even though Microsoft's own CDN is proxy-blocked).

## Documentation map

- [AGENTS.md](AGENTS.md) — agent entry point: rules, landmarks, reading order
- [docs/README.md](docs/README.md) — the full documentation index
- [docs/01-architecture.md](docs/01-architecture.md) — what runs where, and why
- [docs/12-design-rules.md](docs/12-design-rules.md) — MUST/SHOULD/MAY, with
  how each is enforced
- [docs/13-anti-patterns.md](docs/13-anti-patterns.md) — wrong/right pairs
- [docs/DOCUMENTATION-AUDIT.md](docs/DOCUMENTATION-AUDIT.md) — known findings,
  ambiguities, and open questions
- [docs/18-naming-and-compatibility.md](docs/18-naming-and-compatibility.md) —
  what Limen renamed and what it deliberately did not
- [examples/README.md](examples/README.md) — six verified example applications

## What this is

A dependency-minimal reference implementation of a browser architecture
where **the browser renders and interacts; the application engine owns
meaning**. The engine is TypeScript today (`src/engine/`) and is designed to
be replaceable by a real WASM engine (F#/C#/Rust/Kotlin/Java) without
changing the bridge. See `prompts/*.md` for the full specifications this
repo implements — read `prompts/README.md` first for how the three files
relate, including a documented disagreement between two of them (see
"Known contradictions" below).

## The one rule that matters most

```text
src/kernel/   →  browser mechanism only (DOM, fetch, events, timers)
src/protocol.ts → the wire contract: plain, JSON-serializable data only
src/engine/   →  application meaning only (state, transitions, validation)
```

`src/engine/**` must never reference `document`, `window`, `fetch`,
`localStorage`, `sessionStorage`, or use `any`/`dynamic` typing —
`scripts/check-architecture.ts` mechanically enforces this substring/word
ban and runs as part of `npm test`. `src/kernel/**` is the only place
allowed to touch the browser. If you find yourself writing a `switch` on
business meaning in `src/kernel/`, or a DOM call in `src/engine/`, stop —
that's the boundary breaking, not a shortcut.

`architecture.yaml` states the intended contract; its header comment says
plainly which parts of it are actually mechanically checked vs. enforced
only by TypeScript's compiler or code review. Don't assume a claim there is
automated just because it's written down.

## Before writing any feature

For every meaningful change, work out — briefly, in your own reasoning, not
necessarily as a committed artifact — the same shape the architecture specs
require:

```text
Feature:
Authoritative state:        (what part of src/engine/domain.ts owns this?)
Relevant states:            (what union members already exist / are needed?)
Legal transitions:          (what commands cause what state changes?)
Invariants:                 (what must always remain true?)
Capabilities:                (what can the UI do in each state — projected, not reconstructed by the DOM)
Inputs:                     (SemanticEvent shape — name/key/value)
Outputs/projections:        (ViewState keys the engine will produce)
External effects:           (EffectRequest — Http: all four EffectOutcome variants, Success/Failure/Cancelled/OutcomeUnknown; Storage: StorageOutcome's two, Success/Failure — no OutcomeUnknown, a single localStorage call is atomic)
Browser responsibilities:   (what's genuinely new data-* wiring vs. reuse of existing primitives)
Kernel responsibilities:    (should almost always be "none — existing primitives cover it")
Engine responsibilities:    (state, transition, projection)
Uncertainties:              (mark explicitly rather than silently guessing)
```

If a change can't be described this way — if it needs a second place to
hold state, or the kernel needs to know what a value *means* rather than
just where to put it — that's a sign the design needs rethinking before
code, not after.

## Where things are

- `src/protocol.ts` — the stable engine↔kernel contract: `SemanticEvent`,
  `ViewState`, `EffectRequest`/`EffectResult`/`EffectOutcome`/`StorageOutcome`,
  `EngineTransport`. Read this file first; everything else is built on it.
- `src/kernel/browser-kernel.ts` — the generic declarative bridge. Binds
  `data-event`/`data-text`/`data-bind-<attr>`/`data-if`/`data-each`, executes
  Http effects (any method, caller headers/body) and Storage effects
  (`localStorage` get/set/remove), funnels every engine round-trip through
  one error-boundary chokepoint (`#send`). It does not know what any event
  name or view key means.
- `src/kernel/diagnostics.ts` — injectable `DiagnosticsSink`, bridge-only
  concern (never engine/view state).
- `src/engine/domain.ts` — the one reference feature's authoritative state,
  transitions, and event→command mapping.
- `src/engine/engine.ts` — `ReferenceEngine` (routes messages to
  `transition()`) and `project()` (state → `ViewState`).
- `src/engine/transport.ts` — `DirectTypeScriptTransport`, today's
  in-process stand-in for a real WASM transport.
- `index.html` — the one shipped reference feature (email availability).
- `examples/kitchen-sink.html` + `examples/kitchen-sink.js` — a living,
  interactive reference for every bridge primitive and every
  `EffectOutcome`, driven by a throwaway demo engine (not part of the
  published package).
- `examples/01-counter/` … `examples/06-time-entries/` — six progressive
  example applications, each driven by `test/examples.test.ts` against its own
  real `index.html`, so none can silently rot. Start at `01-counter`.
- `docs/ROADMAP.md` — status of every bridge responsibility against what's
  actually implemented and tested. Read this before assuming something is
  missing or done.
- `docs/USAGE.md` — the original consumer walkthrough. Still accurate, but
  `docs/02-getting-started.md` is the better starting point, and
  `docs/11-api-reference.md` is the reference.
- `test/domain.test.ts` — pure engine-logic tests, run directly against
  `src/*.ts` (their only import from `protocol.ts` is type-only, so no build
  is required first).
- `test/kernel.test.ts` — bridge tests against a real DOM (`jsdom`, a
  devDependency only, justified in the roadmap and this file's own header
  comment: `BrowserKernel`'s constructor has a real runtime import from
  `protocol.ts`, so it — unlike `domain.ts` — must be imported from `dist/`,
  not `src/`, when tests run directly via
  `node --experimental-strip-types`. That's why `pretest` builds first.

## Commands

```bash
npm run build              # tsc → dist/
npm run build:examples     # tsc → examples/**/*.js, emitted in place
npm run check:architecture # scripts/check-architecture.ts
npm run check:docs         # scripts/check-docs.ts — links, paths, orphans
npm test                   # pretest (build + build:examples) → architecture
                           #   → docs → node --test
npm run check              # alias for npm test (pretest already builds)

npm run test:cli           # dotnet test — the F# lifecycle core (needs .NET SDK 8)
npm run build:cli          # publish the CLI binary for this platform
npm run build:cli:all      # publish all five platform binaries
```

Always run `npm run check` (or `npm test`) before considering a change
done — not just `tsc`. The architecture check, the docs check, and the kernel
and example tests all require a fresh `dist/`; `pretest` handles that
automatically.

## Testing conventions

- Test state and transitions, not implementation details (per
  `prompts/zero-authoritative-javascript-web-architecture-spec-v0.1.md`'s
  Testing section): given state X and evidence Y, command Z legally
  transitions to state A and produces projection/effect B. Also test the
  illegal case.
- `kernel.test.ts` uses a `ScriptedTransport` test double and asserts both
  on what was dispatched (`transport.calls`) and on resulting DOM state.
  Note the two different timing regimes documented at the top of that file:
  an assertion on `transport.calls` right after a synchronous DOM event is
  safe immediately (the push happens synchronously inside the click's own
  call chain); an assertion on *applied* DOM state after a click-triggered
  re-projection needs `await flush()` first, since applying the response
  happens after a microtask boundary. Getting this wrong produces tests
  that pass for the wrong reason or fail flakily — read the existing tests
  before adding new ones in this style.
- Never call `kernel.start()` more than once in a test to simulate a new
  projection — it re-binds the DOM and double-registers listeners. Trigger
  a later projection through a real event round-trip instead (see the
  `tick()` helper in `kernel.test.ts`).

## Known contradictions (documented, not silently resolved)

- `prompts/minimal-typescript-browser-kernel-responsibility-spec.md` §36
  specifies an imperative `ViewChange[]`/element-id protocol. The other
  prompt spec, and this implementation, use a declarative `ViewState` +
  `data-*` binding model instead. See `docs/ROADMAP.md` for the full note.
- `architecture.yaml` documents its own enforcement gap in its header
  comment as of this writing — check it hasn't drifted from
  `scripts/check-architecture.ts` again before trusting it at face value.
- The package is named for WebAssembly but contains none; "kernel" names the
  browser bridge here while the package name implies the engine. Both are
  recorded as findings A-2 and N-1 in `docs/DOCUMENTATION-AUDIT.md`, along with
  a confirmed defect (P-1) and the open questions this audit could not answer.

## Definition of done

A change is not done because the UI appears to work. It's done when:
authoritative state and legal transitions are explicit; illegal transitions
are rejected (and tested); required capabilities are explicit in the
projection, not reconstructed by the DOM; effect outcomes are represented
for all four cases; kernel and engine responsibilities stayed separated (no
new business logic leaked into `src/kernel/`); no unnecessary dependency was
introduced (or, if one was, it's justified against
`prompts/dependency-minimal-browser-kernel-architecture-policy.md` §8 and
noted in the relevant doc); `npm run check` passes; and — for anything
touching the DOM — it's been exercised in a real browser, not just asserted
in jsdom.
