---
id: GV-START-001
title: Agent Startup Guide
status: canonical
version: 2.0.0
owners:
  - repository-governance
created: 2026-07-22
updated: 2026-09-14
review_cycle: quarterly
supersedes: []
superseded_by: []
related_documents:
  - docs/00-governance/README.md
  - docs/14-agent-guide.md
tags: [governance, agents, startup, architecture]
---

# Agent Startup Guide — Limen

This file has two parts. **Part 1** is what you need to modify code in this
repository correctly. **Part 2** is the Repository Operating System (ROS)
governance process that applies to substantial work.

If you are here to change code, read Part 1 first. Do not skip it — the
architecture in this repository is unusual, and code that looks reasonable by
mainstream front-end conventions is often wrong here.

---

# Part 1 — Limen

## Two things to know before anything else

**1. This repository is Limen.** Limen is the product name for the
architecture here: an explicit boundary keeping browser capabilities separate
from application authority. The npm package is still
`@echelon-foundry/typescript-wasm-kernel` and **no exported symbol, file path,
or protocol type was renamed** — the rename is documentation-only. See
[docs/18-naming-and-compatibility.md](docs/18-naming-and-compatibility.md).

Note the term "kernel" is still load-bearing and still correct: it means the
**browser-side bridge** (`BrowserKernel`, `src/kernel/`), not the whole
product, and not the application side.

**2. There is no WebAssembly in this repository.** No `.wasm` file, no loader,
no `WebAssembly.instantiate`. The old name described a *boundary shape*, which
is serializable and therefore WASM-ready. The component that owns application
meaning is called **the engine**, and it is TypeScript today (`src/engine/`).
See [docs/17-wasm-migration.md](docs/17-wasm-migration.md).

If you were about to report that you cannot find the WASM, that paragraph is
the answer. Nothing is missing.

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
src/engine/     application meaning ONLY — state, transitions, validation
```

Two message types cross the boundary, and nothing else does:

```ts
// Browser → Engine
{ kind: "Initialize"; protocolVersion; capabilities }
{ kind: "Event";        event:  SemanticEvent }   // { name, key?, value? }
{ kind: "EffectResult"; result: EffectResult }

// Engine → Browser
{ view: ViewState; effects: EffectRequest[]; cancellations: CorrelationId[] }
```

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
6. **All four `EffectOutcome` cases MUST be represented** for Http:
   `Success`, `Failure`, `Cancelled`, `OutcomeUnknown`. Storage has two:
   `Success`, `Failure`. Do not collapse `OutcomeUnknown` into `Failure` — they
   mean different things and often demand different recovery.
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
has (Http, localStorage)?                      → engine requests an EffectRequest.
Does it need a browser API the kernel does NOT
have (clipboard, history, files, timers)?      → extend the protocol + kernel
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
| A real state machine + transitions | [`src/engine/domain.ts`](src/engine/domain.ts) |
| State → view projection | `project()` in [`src/engine/engine.ts`](src/engine/engine.ts) |
| Today's in-process transport | [`src/engine/transport.ts`](src/engine/transport.ts) |
| Diagnostics | [`src/kernel/diagnostics.ts`](src/kernel/diagnostics.ts) |
| The smallest complete app | [`examples/01-counter/`](examples/01-counter/) |
| A production-shaped app | [`examples/06-time-entries/`](examples/06-time-entries/) |
| Every primitive, interactively | [`examples/kitchen-sink.html`](examples/kitchen-sink.html) |
| Engine-level test style | [`test/domain.test.ts`](test/domain.test.ts) |
| Bridge-level test style (jsdom, timing rules) | [`test/kernel.test.ts`](test/kernel.test.ts) |
| Example verification | [`test/examples.test.ts`](test/examples.test.ts) |
| What is built vs. deferred, and why | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| Enforced vs. merely stated invariants | [`architecture.yaml`](architecture.yaml) header comment |
| What "Limen" renamed, and what it did not | [`docs/18-naming-and-compatibility.md`](docs/18-naming-and-compatibility.md) |
| The SDE method this repo follows | [`.sde/README.md`](.sde/README.md) |

## Required reading order

1. This file, Part 1 — **including the work-item step above**
2. [README.md](README.md)
3. [docs/01-architecture.md](docs/01-architecture.md)
4. [`src/protocol.ts`](src/protocol.ts) — the actual contract
5. [`examples/01-counter/`](examples/01-counter/) — the smallest whole app
6. [docs/04-state-model.md](docs/04-state-model.md)
7. [docs/05-events-and-dispatch.md](docs/05-events-and-dispatch.md)
8. [docs/07-effects-and-browser-interop.md](docs/07-effects-and-browser-interop.md)
9. [`examples/06-time-entries/`](examples/06-time-entries/) — realistic
10. [docs/11-api-reference.md](docs/11-api-reference.md)

Deeper agent-specific guidance, including worked task-placement examples:
[docs/14-agent-guide.md](docs/14-agent-guide.md). What *not* to do, with
wrong/right pairs: [docs/13-anti-patterns.md](docs/13-anti-patterns.md).

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
10. Am I putting application logic in JavaScript outside the engine? (Rule 1.)
11. Am I bypassing a boundary for convenience?
12. What tests prove this — including the illegal case?
13. Does `npm run check` pass?

---

# Part 2 — Repository Operating System

## Mission

The Repository Operating System (ROS) makes research, engineering, decisions,
and handoffs durable without relying on conversation history or tribal
knowledge.

## Start here

1. Read [the governance index](docs/00-governance/README.md).
2. Identify the task's scope and operating mode.
3. Locate the applicable canonical domain records; inspect the repository and
   user changes before editing.
4. State or record material unknowns, constraints, assumptions, and risks.
5. Use the smallest process that preserves correctness, traceability, and
   continuity.
6. Execute, validate, update affected records, and leave a handoff.

Detailed rules are in the [Agent Operating Manual](docs/00-governance/Agent-Operating-Manual.md).
Research packages follow the [REP Specification](docs/00-governance/Research-Execution-Package-Specification.md);
engineering follows the [Engineering Standards](docs/00-governance/Engineering-Standards.md).

## Authority

Apply, in descending order: explicit user instruction; applicable safety, legal,
and platform constraints; canonical governance; accepted domain REPs and theory;
accepted architecture and decision records; current implementation; local
convention; agent preference. A higher authority cannot authorize a violation of
an applicable safety or legal constraint. When same-level sources conflict,
prefer the narrower and newer accepted record and document the resolution;
escalate if the outcome materially changes the authorized goal.

## Core rules

- Never fabricate evidence, file reads, approvals, commands, test results, or
  certainty.
- Preserve user work. Inspect before modifying; do not destroy or irreversibly
  migrate without authorization.
- Make reasonable, reversible, in-scope decisions. Escalate high-impact
  irreversible, security/privacy-sensitive, legally ambiguous, or materially
  out-of-scope decisions.
- Research by testing hypotheses against confirming and falsifying evidence.
  Engineering by establishing a baseline, defining acceptance criteria, making
  the smallest robust change, and testing in proportion to risk.
- Important claims cite `EV-`, `HY-`, and `TH-` records when those records
  exist. Material decisions use `DF-`, which canonically means **Decision
  Record**.
- Do not silently change canonical policy. Propose or record the change, its
  evidence, consequences, version, and migration path.
- Do not claim a test passed unless it ran and passed. Name skipped or
  unavailable checks and their implications.
- Not every edit needs a REP. Use the artifact threshold in the Agent Operating
  Manual.

## Handoff

For substantial work, record: objective; work completed; files changed;
decisions and assumptions; tests run and results; evidence added; unresolved
questions; risks; and next recommended action. A capable successor must be able
to continue without the originating conversation.

## Work protocol

Before meaningful mutation, identify the external work item and run
`./ros work begin ID`. Inspect `./ros work context ID` for allowed actions and
required evidence, perform the bounded work, gather configured evidence, request
a legal transition with `work complete`, then run `./ros registry build` and
`./ros validate`. Use `work block --reason` and `work resume` rather than
hand-editing context. Use `./ros status` when resuming unfamiliar work.
Meaningful committed changes require machine-readable attribution; see
[docs/work-protocol.md](docs/work-protocol.md).

No externally-assigned ID yet? Check `./ros work ready` for capturable,
unblocked repository work before assuming none exists, and use `./ros add "..."`
to record a newly discovered obligation instead of leaving it as an unfiled
comment or dropped observation. `./ros work start ID` promotes a ready backlog
item into the protocol above. This local backlog is repository-scoped triage,
not a project-management system; see the "Local backlog" section of
[docs/work-protocol.md](docs/work-protocol.md).
