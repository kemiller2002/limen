# Limen documentation

Everything here describes Limen as it is actually implemented. Where something
is unbuilt, deferred, or ambiguous, it says so rather than implying otherwise.

> **Limen** is the product name for this architecture. The npm package is still
> `@echelon-foundry/typescript-wasm-kernel` and nothing was renamed —
> see [naming and compatibility](18-naming-and-compatibility.md).
> Throughout these documents, **"the kernel"** means the browser-side bridge
> and **"the engine"** means the application side.

## Start here

| # | Document | Answers |
| --- | --- | --- |
| — | [Root README](../README.md) | What is this, and why does it exist? |
| 01 | [Architecture](01-architecture.md) | What runs where, and who owns what? |
| 02 | [Getting started](02-getting-started.md) | How do I build an app from nothing? |
| 03 | [Kernel lifecycle](03-kernel-lifecycle.md) | What happens from page load to first paint? |

## Core concepts

| # | Document | Answers |
| --- | --- | --- |
| 04 | [State model](04-state-model.md) | Where does state live, and how is it shaped? |
| 05 | [Events and dispatch](05-events-and-dispatch.md) | How does a click become an application action? |
| 06 | [Rendering](06-rendering.md) | How does state reach the screen? Is this a UI framework? |
| 07 | [Effects and browser interop](07-effects-and-browser-interop.md) | How does anything leave the application? Includes HTTP and storage in full. |
| 08 | [Multi-screen applications](08-multi-screen-applications.md) | How do I structure more than one screen? |

## Working with it

| # | Document | Answers |
| --- | --- | --- |
| 09 | [Testing and debugging](09-testing-and-debugging.md) | How do I prove it works, and diagnose it when it doesn't? |
| 10 | [Integration guide](10-integration-guide.md) | How does another application adopt this? |
| 11 | [API reference](11-api-reference.md) | What exactly does this function do? |
| 15 | [Recipes](15-recipes.md) | How do I do one specific task? |
| 16 | [Troubleshooting](16-troubleshooting.md) | Why isn't it working? |
| 20 | [Lifecycle CLI](20-lifecycle-cli.md) | `init`, `status`, `verify`, `upgrade`, `doctor` — commands, flags, exit codes, JSON |
| 21 | [Installation and upgrade](21-installation-and-upgrade.md) | What `init` does, who owns which file, what an upgrade may change |

## Rules and reasoning

| # | Document | Answers |
| --- | --- | --- |
| 12 | [Design rules](12-design-rules.md) | What MUST/SHOULD/MAY I do? |
| 13 | [Anti-patterns](13-anti-patterns.md) | What must I not do, and why? |
| 14 | [Agent guide](14-agent-guide.md) | Where does a change belong? (written for AI coding agents) |
| 17 | [WASM migration](17-wasm-migration.md) | Where is the WebAssembly, and what would adding it take? |
| 18 | [Naming and compatibility](18-naming-and-compatibility.md) | What is Limen, what was renamed, and did anything break? |
| — | [Glossary](glossary.md) | What does this word mean here? |

## Project status

| Document | Contents |
| --- | --- |
| [Evidence](19-evidence.md) | What has actually been measured, what has not, and where every number comes from |
| [Roadmap](ROADMAP.md) | Every bridge responsibility vs. what is implemented and tested |
| [Documentation audit](DOCUMENTATION-AUDIT.md) | Findings from the documentation audit, including unresolved ambiguities |
| [Lifecycle conversion report](22-lifecycle-conversion-report.md) | What adding the CLI changed, and what was proven about it |
| [Usage (legacy)](USAGE.md) | The original consumer walkthrough, kept for continuity |

## The website

Limen's own site lives in [`site/`](../site/) and is itself a Limen
application — the interactive sections run on the real kernel, the prose is
static HTML. It is verified by [`test/site.test.ts`](../test/site.test.ts)
(behavior, against the built pages) and
[`scripts/check-site.ts`](../scripts/check-site.ts) (the publishable artifact).
Build and serve it with `npm run serve:site`.

## Examples

All examples are executed by the test suite ([`test/examples.test.ts`](../test/examples.test.ts)),
so they cannot silently stop working.

| Example | Demonstrates |
| --- | --- |
| [01-counter](../examples/01-counter/) | The minimum: event → transition → projection → DOM |
| [02-form](../examples/02-form/) | Validation, capability projection, rejected illegal transitions |
| [03-fetch-data](../examples/03-fetch-data/) | Http effect, list rendering, all four outcomes, stale-result rejection |
| [04-save-data](../examples/04-save-data/) | Full save lifecycle, Storage effect, non-idempotent write safety |
| [05-multi-screen](../examples/05-multi-screen/) | Screens as state, shared vs. screen-local state, engine-side filtering |
| [06-time-entries](../examples/06-time-entries/) | A realistic feature: load, validate, add, mutate, refresh |
| [kitchen-sink](../examples/kitchen-sink.html) | Every bridge primitive and every effect outcome, interactively |

## Governance and process

These are installed and owned by the Repository Operating System package, not by
the kernel. They describe process, not architecture.

- [Governance index](00-governance/README.md)
- [Work protocol](work-protocol.md)
- [Work adapter contract](work-adapter-contract.md)
- [Pilot measurement plan](PILOT-MEASUREMENT-PLAN.md)
- [Architecture records](architecture/README.md)
- [Decision navigation](decisions/README.md)

## Upstream specifications

The prompt specifications this implementation is derived from live in
[`prompts/`](../prompts/README.md). They are historical inputs, not a
description of the current code — where they disagree with the implementation,
the implementation wins, and the disagreements are recorded in
[ROADMAP.md](ROADMAP.md) and [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md).
