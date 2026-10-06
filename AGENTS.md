---
id: GV-START-001
title: Agent Startup Guide
status: canonical
version: 1.11.0
owners:
  - repository-governance
created: 2026-07-22
updated: 2026-10-01
review_cycle: quarterly
supersedes: []
superseded_by: []
related_documents:
  - docs/00-governance/README.md
  - docs/development-telemetry.md
  - docs/agent-provenance.md
  - docs/cli.md
  - docs/installation.md
  - docs/upgrading.md
  - docs/remote-agent-contract.md
  - docs/remote-protocol.md
tags: [governance, agents, startup, provenance]
provenance:
  contributions:
    EXE-20261001T120908481Z-a6b1be1d:
      operations: [modified]
      at: 2026-10-01T13:58:10.000Z
      actor:
        kind: agent
        id: openai/codex
        provider: openai
        model: unknown
        runtime: codex
      reason: "Adopt the 30-minute elapsed-time upstream synchronization rule and safe integration boundaries"
    EXE-20261002T095646730Z-345f9f99:
      operations: [modified]
      at: 2026-10-02T09:57:17.000Z
      actor:
        kind: agent
        id: openai/codex
        provider: openai
        model: unknown
        runtime: codex
      reason: "Adopt the 30-minute elapsed-time upstream synchronization rule and safe integration boundaries"
---

# Limen

This file has two parts. **Part 1** is what you need to modify code in this
repository correctly. **Part 2** is the Praxis repository operating system
governance contract (the Agent Startup Guide) that applies to substantial work.

If you are here to change code, read Part 1 first. Do not skip it — the
architecture in this repository is unusual, and code that looks reasonable by
mainstream front-end conventions is often wrong here.

---

# Part 1 — Limen

## Start with Core: four documents

This is the required reading, and all of it. `npm run check:docs` keeps this
list identical to the learning path in
[`architecture/core.json`](architecture/core.json).

<!-- core-learning-path:start -->
1. [docs/core-mental-model.md](docs/core-mental-model.md) — the seven Core concepts: the whole mandatory model
2. [docs/where-code-goes.md](docs/where-code-goes.md) — placement: the decision order, the table, the layers by name
3. [`src/protocol.ts`](src/protocol.ts) — the contract every engine speaks
4. [`examples/minimal/`](examples/minimal/README.md) — one complete application that imports Core only
<!-- core-learning-path:end -->

Then open a work item (below) before changing anything. Optional systems —
federation, capability packs, routing and forms libraries, SSR, workers,
DevTools — are not prerequisites; read their documents when a task needs
them. Growing Core itself is a [Core Admission](docs/core-admission.md).

## Two things to know before anything else

**1. This repository is Limen.** Limen is the product name for the
architecture here: an explicit boundary keeping browser capabilities separate
from application authority. From 0.7.0 the npm package is
`@echelon-foundry/limen` (releases up to 0.6.2 were published as
`@echelon-foundry/typescript-wasm-kernel`, now deprecated). **No exported
symbol, file path, or protocol type was renamed** — only the distribution
identity changed. See
[docs/18-naming-and-compatibility.md](docs/18-naming-and-compatibility.md).

Note the term "kernel" is still load-bearing and still correct: it means the
**browser-side bridge** (`BrowserKernel`, `src/kernel/`), not the whole
product, and not the application side.

**2. The repository now contains a real F# WebAssembly consumer.** The npm
package is still a TypeScript browser kernel and protocol; `src/engine/` is
the TypeScript reference engine. But Limen's own interactive product site uses
an F# application engine compiled to .NET WebAssembly under `site/fsharp/`,
loaded through the mechanical transport in
`site/app/wasm-engine-transport.ts`. The tiny C# `[JSExport]` host is
marshalling glue only and must contain no application decision. See
[docs/17-wasm-migration.md](docs/17-wasm-migration.md) and
[site/fsharp/README.md](site/fsharp/README.md).

Do not "simplify" the site by moving application state or rules back into
TypeScript. The self-hosting boundary is now part of the site's acceptance
criteria.

## Before you change anything: open a work item

This repository enforces the ROS work protocol **in CI**. The `validate` job
rejects any branch whose meaningful changes lack work-item attribution, with
`meaningful change has no active or completed work-item attribution`.

Do this **first**, before editing:

```sh
./ros add "short description of the work"   # prints a WI-#### id
./ros work ready WI-####
./ros work start WI-####
```

then, **before your first edit**, commit the work item's scope manifest —
`architecture/work-scopes/WI-####.json` (placement + allowed paths) — and name
the item in every commit subject, e.g. `feat(x): … (GH-23, WI-####)`. CI's
`Work-item scope` job rejects commits outside the declared scope, and any
change to a guardrail-owned path unless the item is declared
`"guardrail": true`. See [docs/25-guardrails.md](docs/25-guardrails.md).

and when the work is done and committed:

```sh
# ROS_BASE_REF is load-bearing: it folds the committed base...HEAD diff into
# the attributed paths, which is how CI sees an already-committed branch.
ROS_BASE_REF=origin/main ./ros work complete WI-#### \
  --evidence implementation=<path> --evidence tests=<path>
./ros registry build
ROS_BASE_REF=origin/main ./ros validate    # must print "validation passed"
```

Skipping this does not fail locally. It fails the pull request. Part 2 has the
full protocol.

## Architecture in one screen

```text
src/kernel/     the Limen kernel: browser mechanism ONLY
                — DOM, fetch, localStorage, timers
src/protocol.ts the threshold itself: plain, JSON-serializable data only
src/engine/     TypeScript reference-engine meaning ONLY — state, transitions, validation
```

These message types cross the boundary, and nothing else does. They are
**generated** from the language-neutral contract `contract/core.contract.json`
— never edit `src/generated/**` by hand; change the contract and run
`npm run contract:generate` (see [docs/24](docs/24-contract-and-capabilities.md)):

```ts
// Browser → Engine
{ kind: "Initialize";      protocolVersion; capabilities; location; handshake? }
{ kind: "Event";           event:    SemanticEvent }   // { name, key?, value? }
{ kind: "EffectResult";    result:   EffectResult }
{ kind: "LocationChanged"; location: BrowserLocation } // the browser moved on its own
{ kind: "CapabilityFact";  capability; version; fact } // from a negotiated optional capability

// Engine → Browser
{ view: ViewState; effects: EffectRequest[]; cancellations: CorrelationId[]; handshake? }
```

The kernel verifies the engine's `handshake` (contract fingerprint, protocol
revision, selected optional capabilities) before applying anything from it.
Optional capabilities are packs registered with the kernel and reached through
one generic `Capability` effect; Core never learns what a pack means.

**Core is a fixed list of files.** [`architecture/core.json`](architecture/core.json)
is the machine-readable Core manifest: the layers `core-contract` and
`core-kernel`, the exact files in them, the six binding primitives, the four
built-in capability families, zero runtime dependencies, the approved root
export families and the seven canonical concepts. `npm run check:architecture`
enforces it; every other layer ([where code goes](docs/where-code-goes.md#the-layers-by-name))
is optional and may import only Core's public files. Growing Core is a Core
Admission decision, never a side effect of feature work.

The kernel implements four capabilities — frozen at v1; a new browser
capability is an optional pack — announced in `Initialize`:

| Capability | Operations | Outcomes |
| --- | --- | --- |
| `Http` | any method, caller headers and body | `Success` / `Failure` / `Cancelled` / `OutcomeUnknown` |
| `Storage` | `get` / `set` / `remove` (`localStorage`) | `Success` / `Failure` |
| `Clipboard` | `writeText` (**no read**) | `Success` / `Failure{denied,unavailable,unknown}` |
| `Navigation` | `push` / `replace` / `back` / `forward` | `Success{location}` / `Dispatched` / `Failure` |

`capabilities` says what the **kernel implements**, never what the browser will
permit. Availability and permission are reported per effect, in that effect's
own outcome.

The kernel understands exactly six HTML attributes and interprets none of them:

| Attribute | Effect |
| --- | --- |
| `data-event="name"` | dispatch `SemanticEvent { name }` |
| `data-on="type"` | override the default DOM event type |
| `data-text="key"` | `textContent = view[key]` |
| `data-bind-<attr>="key"` | set attribute/property from `view[key]` |
| `data-if="key"` | mount/unmount a `<template>` on truthiness |
| `data-each="key" data-key="field"` | repeat a `<template>` per item |

## Non-negotiable rules

These are MUST-level. Violating one is a defect regardless of whether tests pass.

1. **Authoritative application state lives in the engine.** Exactly one place.
   Never add a second store in `src/kernel/**` or in page JavaScript.
2. **`src/engine/**` MUST NOT reference** `document`, `window`, `fetch`,
   `localStorage`, or `sessionStorage`, and MUST NOT use the words `any` or
   `dynamic`. This is mechanically enforced by
   [`scripts/check-architecture.ts`](scripts/check-architecture.ts).
3. **`src/kernel/**` MUST NOT branch on application meaning.** If you are
   writing `switch` on an event name or a view key inside the kernel, the
   boundary is breaking. Event names and view keys are opaque strings there.
4. **The DOM is output, never input.** Never read application truth back out of
   the DOM. If the UI needs to know whether something is allowed, the engine
   projects that as an explicit key.
5. **External effects MUST be requested, never performed, by the engine.** The
   engine returns an `EffectRequest`; the kernel performs it and returns an
   `EffectResult`.
6. **Every outcome variant MUST be represented.** Http has four —
   `Success`, `Failure`, `Cancelled`, `OutcomeUnknown`. Storage has two.
   Clipboard has two, with three distinct failure reasons. Navigation has
   three. Do not collapse `OutcomeUnknown` into `Failure`, and do not collapse
   a clipboard `denied` (retry works) into `unavailable` (retry can never
   work) — each split exists because the recovery differs.
6a. **A browser-originated move is not an effect result.** Never request a
   navigation in response to `LocationChanged`: the browser has already moved,
   and pushing again traps the user on the page.
7. **Do not add a dependency.** The package has zero runtime dependencies. If
   one is genuinely required, justify it against
   `prompts/dependency-minimal-browser-kernel-architecture-policy.md` §8 and
   record it.
8. **Preserve the public contract.** `src/protocol.ts` and the exports in
   `src/index.ts` are consumed externally.

## Where do I put this change?

```text
Is it a visual style?                          → CSS. Stop.
Is it document structure?                      → HTML. Stop.
Does it decide, validate, or remember anything
about the application?                         → src/engine/. Stop.
Does it need a browser API the kernel already
has (Http, localStorage, clipboard write,
history push/replace/back/forward)?            → engine requests an EffectRequest.
Is it what a URL MEANS?                        → src/engine/ (parseRoute). Stop.
Is it how a URL is pushed or popped?           → already in the kernel. Stop.
Does it need a browser API the kernel does NOT
have (files, timers, focus, clipboard read)?   → extend the protocol + kernel
                                                 (see docs/15-recipes.md), then
                                                 the engine requests it.
Is it a new generic DOM binding primitive?     → src/kernel/ — rare, needs review.
Am I about to keep application state in
JavaScript outside the engine?                 → STOP. That is rule 1.
```

## Repository landmarks

| To understand… | Read |
| --- | --- |
| The whole contract (start here, ~80 lines) | [`src/protocol.ts`](src/protocol.ts) |
| The bridge: binding, dispatch, effects, errors | [`src/kernel/browser-kernel.ts`](src/kernel/browser-kernel.ts) |
| Initialization and the round-trip chokepoint | `BrowserKernel.start()` and `#send()` in the same file |
| DOM binding and projection | `#bindElement`, `#applyScope`, `#applyIf`, `#applyEach` |
| Http and Storage execution | `#runHttp`, `#classifyAbort`, `runStorage` |
| Clipboard execution and failure classification | `writeClipboardText`, `classifyClipboardError` |
| Navigation, same-origin refusal, `popstate` | `runNavigation`, `resolveSameOrigin`, `readLocation` |
| Effect routing (exhaustive — a missing branch will not compile) | `#runEffect` |
| A real state machine + transitions | [`src/engine/domain.ts`](src/engine/domain.ts) |
| State → view projection | `project()` in [`src/engine/engine.ts`](src/engine/engine.ts) |
| Today's in-process reference transport | [`src/engine/transport.ts`](src/engine/transport.ts) |
| Multi-engine federation, manifests, envelope routing, failure isolation and diagnostics | [`src/federation.ts`](src/federation.ts) + [federation guide](docs/23-wasm-federation.md) |
| Real two-F#-WASM federation proof | [`site/fsharp/federation/`](site/fsharp/federation/) + [`site/app/federation-proof.ts`](site/app/federation-proof.ts) |
| Generic .NET WASM federation adapter | [`site/app/federated-wasm-module-transport.ts`](site/app/federated-wasm-module-transport.ts) |
| The product site's F# application authority | [`site/fsharp/Limen.Site.Engine/`](site/fsharp/Limen.Site.Engine/) |
| The product site's WASM loading/serialization mechanics | [`site/app/wasm-engine-transport.ts`](site/app/wasm-engine-transport.ts) |
| Diagnostics | [`src/kernel/diagnostics.ts`](src/kernel/diagnostics.ts) |
| The smallest complete app | [`examples/01-counter/`](examples/01-counter/) |
| The copy shipped to npm consumers (no build step) | [`examples/minimal/`](examples/minimal/) |
| Clipboard, end to end | [`examples/07-clipboard/`](examples/07-clipboard/) |
| Routing, Back/Forward, deep links | [`examples/08-routing/`](examples/08-routing/) |
| A production-shaped app | [`examples/06-time-entries/`](examples/06-time-entries/) |
| One interaction traced through every file it touches | [`docs/traces.md`](docs/traces.md) |
| Who owns state, the DOM, routing, decisions | [`docs/mental-model.md`](docs/mental-model.md) |
| Which layer a given change belongs in | [`docs/where-code-goes.md`](docs/where-code-goes.md) |
| Every primitive, interactively | [`examples/kitchen-sink.html`](examples/kitchen-sink.html) |
| Engine-level test style | [`test/domain.test.ts`](test/domain.test.ts) |
| Bridge-level test style (jsdom, timing rules) | [`test/kernel.test.ts`](test/kernel.test.ts) |
| Example verification | [`test/examples.test.ts`](test/examples.test.ts) |
| What is built vs. deferred, and why | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| Enforced vs. merely stated invariants | [`architecture.yaml`](architecture.yaml) header comment |
| What "Limen" renamed, and what it did not | [`docs/18-naming-and-compatibility.md`](docs/18-naming-and-compatibility.md) |
| The SDE method this repo follows | [`.sde/README.md`](.sde/README.md) |

## Going further — optional, when the task needs it

None of this is required to change a Limen application correctly; the four
documents above are. Read these when your task touches them.

- [docs/mental-model.md](docs/mental-model.md) — the longer explanation of who owns what
- [`examples/01-counter/`](examples/01-counter/) and [docs/traces.md](docs/traces.md) — three interactions, file by file
- [docs/04-state-model.md](docs/04-state-model.md), [docs/05-events-and-dispatch.md](docs/05-events-and-dispatch.md), [docs/07-effects-and-browser-interop.md](docs/07-effects-and-browser-interop.md)
- [`examples/03-fetch-data/`](examples/03-fetch-data/) — the first effect; [`examples/06-time-entries/`](examples/06-time-entries/) — realistic
- [docs/routing.md](docs/routing.md) + [`examples/08-routing/`](examples/08-routing/), [docs/clipboard.md](docs/clipboard.md) + [`examples/07-clipboard/`](examples/07-clipboard/)
- [docs/11-api-reference.md](docs/11-api-reference.md)
- Optional subsystems — federation, capability packs, engine libraries,
  adapters, hosts, tooling — are documented where they live
  ([docs/README.md](docs/README.md)); each opens by naming the Core concept it
  composes with. Adding one never adds to the required reading above
  (`npm run check:docs` enforces it).

Deeper agent-specific guidance, including worked task-placement examples:
[docs/14-agent-guide.md](docs/14-agent-guide.md). What *not* to do, with
wrong/right pairs: [docs/13-anti-patterns.md](docs/13-anti-patterns.md).

## Common agent mistakes

Observed, not hypothetical. Each one is cheap to avoid and expensive to debug.

| Mistake | Why it happens | What to do instead |
| --- | --- | --- |
| Keeping application state in a JS variable or on the DOM element | it works for one screen | put it in `State`; the DOM is output |
| Calling a browser API from engine code | it is one line | request an effect; the architecture check fails the build anyway |
| Assuming Limen is a virtual-DOM framework | the `data-*` attributes look like a template language | there is no expression language and no diffing of HTML you did not write |
| Binding a top-level view key inside a `data-each` row | the key exists in the projection | bindings in a row resolve against the **item**; project it per item |
| Pushing a URL in response to `LocationChanged` | the two directions look symmetrical | a browser-initiated move requests nothing |
| Using `Initialize.capabilities` as a permission check | it reads like feature detection | try the effect; the outcome tells the truth |
| Collapsing `OutcomeUnknown` into `Failure` | "it didn't work" feels simpler | a timed-out POST may already have been applied |
| Retrying a clipboard `unavailable` | all failures look alike | only `denied` is retryable |
| Building on `DirectTypeScriptTransport` | it is exported and looks like a base class | it is this repo's demo; write your own — two methods |
| Calling `kernel.start()` twice to re-render | it seems idempotent | it re-binds and double-registers; trigger a real event |
| Editing an emitted `examples/**/*.js` | it is the file the browser loads | it is build output; edit the `.ts` |
| Adding a helper shared between examples | the repetition looks wrong | the repetition is the lesson; a shared helper is the second framework |

## Commands

```sh
npm install
npm run check            # build + build:examples + architecture + docs + all tests
npm run build            # tsc → dist/
npm run build:examples   # tsc → examples/**/*.js (in place)
npm run check:architecture
npm run check:docs
```

`npm run check` is the gate. Run it before considering any change done — not
just `tsc`. The architecture check, the docs check, and the kernel tests all
require a fresh `dist/`; `pretest` handles that.

## Modification checklist

Answer all of these before you write code, and confirm them before you finish:

0. Have I opened a ROS work item? (`./ros work start WI-####`) CI rejects the
   branch without one.
1. What state changes? Which union member in which `State` type?
2. What event causes it? Where does that event originate in the DOM?
3. Is the transition legal from every state it can be requested in? What
   happens when it is not?
4. Is an external effect required? Which kind?
5. Who performs it? (Answer must be: the kernel.)
6. How does the result return, and how is a *stale* result rejected?
7. Which `ViewState` keys change? Are capabilities projected explicitly?
8. What HTML/CSS changes are needed? Any new `data-*` wiring, or do existing
   primitives cover it? (Usually: they cover it.)
9. Am I creating duplicate state anywhere? (Rule 1.)
10. Am I putting application logic in JavaScript/TypeScript outside the chosen engine? (Rule 1.)
11. Am I bypassing a boundary for convenience?
12. What tests prove this — including the illegal case?
13. Does `npm run check` pass?
14. If this crosses a module boundary, who owns the state and transition?
15. Is the cross-module contract versioned and declared by both manifests?
16. Am I accidentally creating shared mutable state or a universal shared domain model?

---

# Part 2 — Praxis governance

<!-- praxis:contract:start -->
<!-- Praxis 3.7.1 agent contract (1.11.0), verbatim. Owned by Praxis: links and paths below are the contract's own; scripts/check-docs.ts does not check them. -->

# Agent Startup Guide

## Mission

Praxis, Echelon Foundry's repository operating system, makes research, engineering, decisions, and handoffs durable without relying on conversation history or tribal knowledge.

## Start Here

Older installations may have `./ros`, a compatibility alias of `./praxis`; new instructions use Praxis (`DF-ROS-2026-A050`).

1. Read [the governance index](docs/00-governance/README.md).
2. Identify the task's scope and operating mode.
3. Locate the applicable canonical domain records; inspect the repository and user changes before editing.
4. State or record material unknowns, constraints, assumptions, and risks.
5. Use the smallest process that preserves correctness, traceability, and continuity.
6. Execute, validate, update affected records, and leave a handoff.

Detailed rules are in the [Agent Operating Manual](docs/00-governance/Agent-Operating-Manual.md). Research packages follow the [REP Specification](docs/00-governance/Research-Execution-Package-Specification.md); engineering follows the [Engineering Standards](docs/00-governance/Engineering-Standards.md).

## Authority

Apply, in descending order: explicit user instruction; applicable safety, legal, and platform constraints; canonical governance; accepted domain REPs and theory; accepted architecture and decision records; current implementation; local convention; agent preference. A higher authority cannot authorize a violation of an applicable safety or legal constraint. When same-level sources conflict, prefer the narrower and newer accepted record and document the resolution; escalate if the outcome materially changes the authorized goal.

## Core Rules

- Never fabricate evidence, file reads, approvals, commands, test results, or certainty.
- Preserve user work. Inspect before modifying; do not destroy or irreversibly migrate without authorization.
- Make reasonable, reversible, in-scope decisions. Escalate high-impact irreversible, security/privacy-sensitive, legally ambiguous, or materially out-of-scope decisions.
- Research by testing hypotheses against confirming and falsifying evidence. Engineering by establishing a baseline, defining acceptance criteria, making the smallest robust change, and testing in proportion to risk.
- Important claims cite `EV-`, `HY-`, and `TH-` records when those records exist. Material decisions use `DF-`, which canonically means **Decision Record**.
- Do not silently change canonical policy. Propose or record the change, its evidence, consequences, version, and migration path.
- Do not claim a test passed unless it ran and passed. Name skipped or unavailable checks and their implications.
- Treat execution telemetry as evidence: discover capabilities, distinguish zero from unavailable, preserve normalized and sanitized raw provider data, prefer deterministic collection, and never invent a metric.
- Keep upstream drift bounded: start with `./praxis sync check --start`, repeat the fetch-only check whenever 30 minutes have elapsed since the last successful check, and integrate upstream changes at a safe work boundary before final validation.
- Not every edit needs a REP. Use the artifact threshold in the Agent Operating Manual.

## Handoff

For substantial work, record: objective; work completed; files changed; decisions and assumptions; tests run and results; evidence added; unresolved questions; risks; and next recommended action. A capable successor must be able to continue without the originating conversation.

## Work Protocol

Before meaningful mutation, identify the external work item and run `./praxis work begin --id ID --occurred-at TIMESTAMP` (see the F# CLI note below for the timestamp — it must be the real current time, not an arbitrary one). That transition starts an execution-telemetry record; inspect `./praxis work context ID`, classify the work, and ingest runtime telemetry that the current environment can expose. For substantial execution, use `./praxis step begin --name "..." --occurred-at TIMESTAMP` and `./praxis step complete --occurred-at TIMESTAMP` around meaningful plan units; do not create command-level noise or retroactive steps. Preserve unknown provider fields through the sanitized raw layer and record unsupported/unavailable capability explicitly. Perform the bounded work, gather configured evidence, commit and push it, record a durable checkpoint (see "Durable checkpoints and continuity" below), request a legal transition with `./praxis work complete --id ID --occurred-at TIMESTAMP --evidence TYPE=PATH` (repeatable; finalizes active telemetry), then run `./praxis registry build` and `./praxis validate`, and commit and push the resulting Praxis state. Attribute canonical records you create or change with `./praxis provenance record` (see Agent Identity and Provenance below). Use `./praxis work block --id ID --occurred-at TIMESTAMP --reason TEXT` and `./praxis work resume --id ID --occurred-at TIMESTAMP` rather than hand-editing context. Use `./praxis status` when resuming unfamiliar work. Meaningful committed changes require machine-readable attribution; see `docs/work-protocol.md` and `docs/development-telemetry.md`. If meaningful changes were committed while no work item was active, reconcile them after the fact with `./praxis work reconcile --id ID --reason TEXT --commit REV --occurred-at TIMESTAMP` (Git-evidenced, recorded as post-hoc, never a substitute for beginning work). Never touch, rewrite, or recommit files to manufacture attribution, and never create a work item only to absorb changes.

No externally-assigned ID yet? Check `./praxis work ready` for capturable, unblocked repository work before assuming none exists, and use `./praxis add "..."` to record a newly discovered obligation instead of leaving it as an unfiled comment or dropped observation (`add` does not require `--occurred-at`; it defaults to the real current time). `./praxis work start --id ID --occurred-at TIMESTAMP` (`begin` is also accepted) promotes a ready backlog item into the protocol above. This local backlog is repository-scoped triage, not a project-management system; see the "Local backlog" section of `docs/work-protocol.md`.

## Upstream synchronization and bounded drift

Long-running or stalled agents must not assume their starting view of `main`
is still current. After selecting the worktree and before meaningful mutation,
run `./praxis sync check --start`. Repeat `./praxis sync check` at coherent work
boundaries whenever 30 minutes of wall-clock time have elapsed since the last
successful check. Waiting on tools, external systems, or the user counts toward
that elapsed time. Also run it immediately before final validation and handoff.

The check performs a bounded `git fetch` of the configured upstream and writes
only per-worktree Git metadata. It never pulls, merges, rebases, switches,
stashes, resets, discards, commits, or edits working files. `./praxis sync
status` and the additive `upstreamSync` block in `./praxis status` report the
starting and current upstream commits, elapsed freshness, ahead/behind counts,
incoming and local paths, exact overlap, and whether final validation can be
claimed against the fetched upstream snapshot. A failed check does not reset
the 30-minute clock.

When upstream advanced, stop at the next safe boundary, inspect overlap, and
integrate according to the repository's branch policy while preserving user
work. Re-run affected tests after integration. Do not begin final validation
while the report is stale, unavailable, or behind. If integration is unsafe or
blocked, record the exact condition and hand off instead of forcing it. A fresh
report proves only the latest successfully fetched snapshot; no local tool can
prove that a remote did not move immediately afterward. Configure the policy at
`workProtocol.upstreamSync` in `ros.json`; repositories with no usable upstream
must disable it explicitly and record that limitation.

## Durable checkpoints and continuity

**An executor session is disposable. Repository state and Praxis state are
the continuity boundary.** No meaningful completed work may exist only in an
executor's local environment: a successor on another machine, with no access
to your filesystem, process, or conversation, must be able to continue. See
`docs/work-protocol.md` ("Durable checkpoints and continuity") and
`DF-ROS-2026-A042`.

- A **commit** is local. A **pushed commit** is on a remote. A **verified
  durable checkpoint** is Praxis's own record that your HEAD, the checkpoint
  commit, and the head of your upstream remote branch were the same commit,
  with no meaningful uncommitted work: `./praxis work checkpoint --id ID
  --occurred-at NOW --summary "what is done" --next-action "what is next"
  [--step STEP-ID]`. Praxis never commits, pushes, or stashes for you.
- A **historical checkpoint** is that record; it is never rewritten. A
  **currently recoverable checkpoint** is one the remote still carries now;
  `./praxis work context ID --text` and `./praxis status` report both, separately.
- Checkpoint at coherent recovery boundaries, not on a timer and not per
  edit: after a meaningful implementation slice or material telemetry step;
  before a risky change; before switching work items or repositories; before
  an intentional handoff; when context exhaustion or termination looks
  possible; before blocking after new work; before completing Git-backed
  work. Never create a meaningless commit to satisfy Praxis.
- For Git-backed work the order is: commit, push, `work checkpoint`,
  `work complete`, then commit and push the Praxis state (`.ros/`). Where
  `workProtocol.continuity.requireDurableCheckpoint` is set, completion
  refuses anything else, and blocking after un-checkpointed work needs a
  checkpoint or `--unrecoverable-reason TEXT` stated truthfully. Work that
  changed nothing completes as before.
- **New observability is effective-current.** Praxis preserves truthful
  historical gaps rather than restarting work or fabricating telemetry.
  Adopt step telemetry (`./praxis telemetry step start|complete|fail`) at the
  next material slice; never restart an execution or work item to gain it,
  never invent earlier steps, and never split earlier usage among steps.
  Missing historical step data is unavailable, not zero and not invalid.
- **Taking over** active work whose executor disappeared: fetch, switch to
  the checkpoint's branch in a clean checkout, then `./praxis work continue
  --id ID --occurred-at NOW` under your own identity. You get a new
  execution whose parent is the predecessor's; the predecessor is recorded
  as interrupted, never as you and never as successful. `blocked -> resume`
  remains for intentionally blocked work.

If the native Praxis executable is genuinely unavailable, use the single approved runtime-free envelope in `docs/fallback-reconciliation.md`; never hand-edit `.ros` state. Preserve only identity and telemetry the runtime actually exposes. Reconciliation is retryable: leave a pending journal/input in place and rerun rather than recreating a transaction under a new ID.

## Agent Identity and Provenance

Every agent working under this repository has an explicit, machine-readable
identity, and records it on the work it creates or changes. This applies to
every provider and runtime, and equally to humans and automation. See
[`docs/agent-provenance.md`](docs/agent-provenance.md).

1. **Establish identity once, at the start of the execution.**
   `./praxis work begin` records who you are in the execution record, and every
   later command inherits that identity.
   - A known runtime (Codex, Claude Code, Gemini CLI, Copilot, GitHub
     Actions) is detected automatically.
   - Otherwise declare yourself with `PRAXIS_ACTOR_KIND`
     (`agent|human|automation`), `PRAXIS_ACTOR` (your stable agent ID),
     `PRAXIS_TELEMETRY_PROVIDER`, `PRAXIS_TELEMETRY_MODEL`, and
     `PRAXIS_TELEMETRY_RUNTIME`, or pass the matching flags on `work begin`
     (the legacy `ROS_*` names still work).
   - Check the result with `./praxis provenance identity`.
2. **Never impersonate** another agent, human, or execution. Never record work
   under an execution you did not run. Praxis refuses a contribution whose
   actor contradicts its execution.
3. **Never fabricate** a provider, model, version, session, or agent name.
   Leave an unknown value unset: Praxis records it as `unknown`, which is correct.
4. **Preserve existing provenance.** Never edit, reorder, or delete another
   contributor's `provenance` entry.
5. **Add your contribution; do not replace anyone else's.**
6. **Attribute every requirement you create**:
   `./praxis provenance record --id RQ-... --operation created`.
7. **Attribute every meaningful modification you make** to a canonical record
   (requirement, decision, evidence, hypothesis, experiment, theory,
   journal, mission, research package): `--operation modified`. Use
   `reviewed` or `approved` only for review or approval you actually
   performed.
8. **Propagate lineage** when you derive one artifact from another:
   `--derived-from SOURCE-ID`. Lineage names the source. It does not make
   the source's author an author of your artifact.
9. **Make generated evidence, findings, and results traceable** to your
   execution. Record them inside the work execution, and name supporting
   records with `--evidence`.
10. **Run `./praxis validate` before finishing.** Missing or contradictory
    provenance on new work is an error.

Identity recorded this way is provenance, not authentication. It is
self-reported and cross-checked, not cryptographically proven.

## No local runtime? Use remote execution

If you can reach this repository on GitHub but cannot run Praxis locally,
for example because there is no .NET, you are governed the same way through
typed remote requests. Follow
[`docs/remote-agent-contract.md`](docs/remote-agent-contract.md): discover
with a `praxis.describe` request, send typed operations with a stable
`requestId` and the `expectedSha` you read, and read results from the
repository.

- Remote execution is available only when
  `.github/workflows/praxis-remote.yml` exists. Remote mutation is available
  only where `ros.json` lists it under `remote.capabilities`.
- The rules above still apply: never impersonate, never fabricate identity,
  and never touch files to manufacture attribution.
- Do not work around a missing runtime by hand-editing `.ros/` state.
- Checkpoint and take over remotely with `work.checkpoint` (naming your own
  `execution.id`) and `work.continue` (protocol 1.3).
- Can commit but cannot dispatch Actions? Commit the request as
  `.praxis-inbox/<requestId>.json` on a `praxis-inbox/...` branch. The inbox
  relays it unchanged (`DF-ROS-2026-A045`).

## Lifecycle commands

Installation, verification, diagnosis and upgrade go through the standard
lifecycle interface, implemented in F#. Install the `praxis` command (with
`ros` as its compatibility alias) one of two ways (`DF-ROS-2026-A044`; npm is
no longer a distribution channel):

- **No runtime needed:** the self-contained native bundle from GitHub
  Releases (`scripts/install-native.sh`, `install-native.ps1` on Windows, or
  `echelon install praxis`); see
  [`docs/native-installation.md`](docs/native-installation.md).
- **With .NET 10:** `dotnet tool install -g EchelonFoundry.Praxis`.

```
praxis init
praxis status
praxis verify
praxis upgrade
praxis doctor
```

In this source checkout the same commands are available as `./praxis init`,
`./praxis verify` and so on. `init` is idempotent, every command is
non-interactive, `--dry-run` and `--check` change nothing, and `--json` puts a
single document on stdout. Exit codes are a documented contract: `0` success,
`2` invalid arguments, `3` verification failed, `4` incompatible installation,
`5` migration blocked, `6` prerequisite failure. See
[`docs/cli.md`](docs/cli.md), [`docs/installation.md`](docs/installation.md)
and [`docs/upgrading.md`](docs/upgrading.md).

Installation state lives in `.echelon/ros.json`; it is tool bookkeeping, not
repository work, and is never treated as a meaningful change for attribution.
Before editing a file the tool installed, check its ownership there: a
`tool-owned` file is replaced on upgrade, so a local edit belongs in a
`user-owned` or `shared` file instead.

## F# CLI

`./praxis` in this source checkout, and in every project scaffolded by
`praxis init` (both profiles), runs the F# CLI (`DF-ROS-2026-A030`,
`DF-ROS-2026-A049`).
Praxis's own repository is F#/.NET only (`RQ-ROS-2026-A024`): it owns no
JavaScript, TypeScript, npm or Node tooling, and `./praxis architecture check`
(also part of `./praxis validate` here) fails on any such file. Do not add one;
implement the behaviour in F#. In this checkout `./praxis` is a shell launcher
for the built CLI; if it reports it needs building, run
`dotnet build Praxis.slnx --configuration Release` first (CI always builds before
`./praxis` runs). In an installed project `./praxis` runs the Praxis version the
project pins, installing that native release on first use.

The command syntax is worth knowing rather than guessing from memory:

- Every mutating command shown above except `add` requires an explicit
  `--id ID` (repeatable) and `--occurred-at TIMESTAMP`, rather than a
  positional ID with an implicit clock read. **Pass the real current
  time** (e.g. `` `date -u +%Y-%m-%dT%H:%M:%S.000Z` ``), not an arbitrary
  or backdated one: a telemetry execution's own `startedAt` always reads
  the real wall clock (matching production), and a later transition whose
  supplied `--occurred-at` predates it fails `./praxis validate` with a
  spurious "capability state recording order must be chronological"
  finding — a real trap this decision's own preparation hit and diagnosed,
  not a defect to work around.
- `work start` and `work begin` are both accepted, as are `work complete`
  and `work done`.
- `work context ID` and `work show ID` take a positional ID.
- `docs/migrations/fsharp/STATUS.md` is the authoritative ledger of any
  remaining command-surface gaps (e.g. `telemetry finalize --input`, a
  deliberately unported adapter-ingestion-at-finalize path).

This section's command-syntax notes apply equally to `./praxis` in this
source checkout and to any project's own bootstrapped `./praxis`, since both
run the same F# CLI.

<!-- praxis:contract:end -->

<!-- BEGIN echelon:visual-engineering -->
## Visual Engineering UI research

Managed by `npx @echelon-foundry/visual-engineering`. Do not edit inside this block.

Before designing, implementing, or reviewing UI:

1. Run `npx @echelon-foundry/visual-engineering verify` and stop if it reports a failure.
2. Read `.visual-engineering/AGENT-INSTRUCTIONS.md`.
3. Read `.visual-engineering/UI-FOUNDATIONS.md`.
4. Read `.visual-engineering/UI-DECISION-CHECKLIST.md`.
5. Read `.visual-engineering/UI-ANTI-PATTERNS.md`.
6. Consult `.visual-engineering/RESEARCH-INDEX.md` for provenance and deeper evidence.
7. Inspect the product and its existing design system.
8. Apply the research as decision criteria, not as a visual style.
9. Report the context version, source commit, principles applied, verification
   performed, and justified deviations.

Do not copy Visual Engineering research into this repository by hand.
<!-- END echelon:visual-engineering -->

<!-- echelon:communication-engineering:start -->
## Communication Engineering

Communication Engineering is installed as evidence-bounded operational guidance.
Before producing consequential communication, read:

- `.communication-engineering/COMMUNICATION-FOUNDATIONS.md`
- `.communication-engineering/COMMUNICATION-DECISION-CHECKLIST.md`
- `.communication-engineering/PURPOSE-OUTCOME-MATRIX.md`
- `.communication-engineering/COMMUNICATION-ANTI-PATTERNS.md`
- `.communication-engineering/RESEARCH-STATUS.md`

Treat research maturity as a constraint. Do not turn provisional findings into universal rules, optimize persuasion at the expense of user autonomy, or substitute style for proof obligations.
<!-- echelon:communication-engineering:end -->
