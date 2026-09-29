# Limen documentation

> **Reading this inside `node_modules`?** Six documents ship in the npm package
> and are right beside this one: [quick start](quick-start.md),
> [mental model](mental-model.md),
> [where does code go?](where-code-goes.md),
> [API reference](11-api-reference.md),
> [troubleshooting](16-troubleshooting.md) and [glossary](glossary.md).
> They describe **the version you installed**. Everything else in this index
> lives online and is linked there; the online copies describe `main`, which
> may be ahead.

Everything here describes Limen as it is actually implemented. Where something
is unbuilt, deferred, or ambiguous, it says so rather than implying otherwise.

> **Limen** is the product name for this architecture. The npm package is still
> The GitHub repository is now `kemiller2002/limen`; the published npm package
> remains `@echelon-foundry/typescript-wasm-kernel` for compatibility —
> see [naming and compatibility](https://github.com/kemiller2002/limen/blob/main/docs/18-naming-and-compatibility.md).
> Throughout these documents, **"the kernel"** means the browser-side bridge
> and **"the engine"** means the application side.

## Start here

Read these four in order and you will not need to read the source to use Limen.

| Document | Answers |
| --- | --- |
| [Quick start](quick-start.md) | How do I get something working in five minutes? |
| [Mental model](mental-model.md) | Who owns state, the DOM, routing, decisions? |
| [Where does code go?](where-code-goes.md) | I have a change — which layer does it belong in? |
| [Three complete traces](https://github.com/kemiller2002/limen/blob/main/docs/traces.md) | What actually happens, file by file, in one interaction? |

Then, for depth:

| # | Document | Answers |
| --- | --- | --- |
| — | [Root README](../README.md) | What is this, and why does it exist? |
| 01 | [Architecture](https://github.com/kemiller2002/limen/blob/main/docs/01-architecture.md) | What runs where, and who owns what? |
| 02 | [Getting started](https://github.com/kemiller2002/limen/blob/main/docs/02-getting-started.md) | How do I build an app from nothing? |
| 03 | [Kernel lifecycle](https://github.com/kemiller2002/limen/blob/main/docs/03-kernel-lifecycle.md) | What happens from page load to first paint? |

## Core concepts

| # | Document | Answers |
| --- | --- | --- |
| 04 | [State model](https://github.com/kemiller2002/limen/blob/main/docs/04-state-model.md) | Where does state live, and how is it shaped? |
| 05 | [Events and dispatch](https://github.com/kemiller2002/limen/blob/main/docs/05-events-and-dispatch.md) | How does a click become an application action? |
| 06 | [Rendering](https://github.com/kemiller2002/limen/blob/main/docs/06-rendering.md) | How does state reach the screen? Is this a UI framework? |
| 07 | [Effects and browser interop](https://github.com/kemiller2002/limen/blob/main/docs/07-effects-and-browser-interop.md) | How does anything leave the application? Every capability, in full. |
| 08 | [Multi-screen applications](https://github.com/kemiller2002/limen/blob/main/docs/08-multi-screen-applications.md) | How do I structure more than one screen? |
| — | [Routing](https://github.com/kemiller2002/limen/blob/main/docs/routing.md) | URLs, Back/Forward, deep links, static hosting |
| — | [Clipboard](https://github.com/kemiller2002/limen/blob/main/docs/clipboard.md) | Copying text, and the browser rules you cannot engineer around |

## Working with it

| # | Document | Answers |
| --- | --- | --- |
| 09 | [Testing and debugging](https://github.com/kemiller2002/limen/blob/main/docs/09-testing-and-debugging.md) | How do I prove it works, and diagnose it when it doesn't? |
| 10 | [Integration guide](https://github.com/kemiller2002/limen/blob/main/docs/10-integration-guide.md) | How does another application adopt this? |
| 11 | [API reference](11-api-reference.md) | What exactly does this function do? |
| 15 | [Recipes](https://github.com/kemiller2002/limen/blob/main/docs/15-recipes.md) | How do I do one specific task? |
| 16 | [Troubleshooting](16-troubleshooting.md) | Why isn't it working? |
| 20 | [Lifecycle CLI](https://github.com/kemiller2002/limen/blob/main/docs/20-lifecycle-cli.md) | `init`, `status`, `verify`, `upgrade`, `doctor` — commands, flags, exit codes, JSON |
| 21 | [Installation and upgrade](https://github.com/kemiller2002/limen/blob/main/docs/21-installation-and-upgrade.md) | What `init` does, who owns which file, what an upgrade may change |
| 23 | [WASM federation](23-wasm-federation.md) | How do multiple independently loaded engines exchange typed transitions without sharing state? |
| 26 | [Fake host, traces and replay](https://github.com/kemiller2002/limen/blob/main/docs/26-fake-host-trace-replay.md) | How do I test an engine deterministically without a browser, and see or replay what crossed the boundary? |
| 27 | [Performance baseline](https://github.com/kemiller2002/limen/blob/main/docs/27-performance-baseline.md) | What does Limen cost today — round trips, lists, forms, guest engines, payload — and where is the evidence for any optimization? |
| 28 | [View contracts](https://github.com/kemiller2002/limen/blob/main/docs/28-view-contracts.md) | How do I check a page's bindings and events against what the engine projects and accepts, before anything runs? |
| 29 | [Binding security](https://github.com/kemiller2002/limen/blob/main/docs/29-binding-security.md) | What may a projection write, and where? How are unsafe URLs, event-handler attributes and strict CSP / Trusted Types handled? |
| 30 | [Focus, selection and scroll](https://github.com/kemiller2002/limen/blob/main/docs/30-focus-selection-scroll.md) | How does an engine move focus, select text or scroll — and learn exactly what happened — without the kernel holding focus state? |
| 31 | [Routing](https://github.com/kemiller2002/limen/blob/main/docs/31-routing.md) | Where do routes live, what exactly do they mean in any language, and how do deep links and Back/Forward avoid redundant pushes? |
| 32 | [Forms](https://github.com/kemiller2002/limen/blob/main/docs/32-forms.md) | Who owns form state, what exactly do touched, dirty, async validation and submission mean, and how are they tested in any language? |
| 33 | [Async resources and optimistic state](https://github.com/kemiller2002/limen/blob/main/docs/33-resources-and-optimistic-state.md) | How does an engine model loading, refreshing, stale answers and optimistic updates — including unknown outcomes — with no hidden cache? |
| 34 | [Scheduling](https://github.com/kemiller2002/limen/blob/main/docs/34-scheduling.md) | How does an engine wait — a timeout, the next frame, an idle moment — and cancel it, without timers hidden in application JavaScript? |
| 35 | [Measurement and observers](https://github.com/kemiller2002/limen/blob/main/docs/35-measurement.md) | How does an engine learn sizes, scroll position and visibility — and when a target disappears — without DOM nodes? |
| 36 | [Rich event facts](https://github.com/kemiller2002/limen/blob/main/docs/36-rich-events.md) | How does an engine get keyboard, pointer, drag, IME and selection facts — opt-in, JSON, with no synchronous DOM decision? |
| 37 | [Accessible interaction patterns](https://github.com/kemiller2002/limen/blob/main/docs/37-accessible-patterns.md) | Can tabs, menus, listboxes, comboboxes, trees, grids and dialogs be built accessibly with no widget logic in the kernel — and who owns such patterns? |
| 38 | [Overlays and the top layer](https://github.com/kemiller2002/limen/blob/main/docs/38-overlays.md) | How does an engine open modal dialogs, popovers and anchored popups — top layer, inert background, focus return — and learn when the user dismissed one? |
| 39 | [Realtime and streaming](https://github.com/kemiller2002/limen/blob/main/docs/39-realtime.md) | How does an engine hold WebSocket and Server-Sent Events connections — lifecycle, identity, stale messages — with every reconnect its own decision? |
| 40 | [User-mediated files](https://github.com/kemiller2002/limen/blob/main/docs/40-files.md) | How does an engine learn what files the user chose and read them in bounded chunks — with no File object, no path, and no picker without a gesture? |
| 25 | [Guardrails](https://github.com/kemiller2002/limen/blob/main/docs/25-guardrails.md) | What does the repository enforce — layers, work-item scope, guardrail ownership — and how do I work inside it? |
| 24 | [Contract, handshake and capabilities](https://github.com/kemiller2002/limen/blob/main/docs/24-contract-and-capabilities.md) | Where is the wire contract defined, how are bindings generated, and how is an optional capability added without changing Core? |

## Rules and reasoning

| # | Document | Answers |
| --- | --- | --- |
| 12 | [Design rules](https://github.com/kemiller2002/limen/blob/main/docs/12-design-rules.md) | What MUST/SHOULD/MAY I do? |
| 13 | [Anti-patterns](https://github.com/kemiller2002/limen/blob/main/docs/13-anti-patterns.md) | What must I not do, and why? |
| 14 | [Agent guide](https://github.com/kemiller2002/limen/blob/main/docs/14-agent-guide.md) | Where does a change belong? (written for AI coding agents) |
| 17 | [WebAssembly status](https://github.com/kemiller2002/limen/blob/main/docs/17-wasm-migration.md) | What WebAssembly exists now, how the F# site crosses the boundary, and what remains open? |
| 18 | [Naming and compatibility](https://github.com/kemiller2002/limen/blob/main/docs/18-naming-and-compatibility.md) | What is Limen, what was renamed, and did anything break? |
| — | [Glossary](glossary.md) | What does this word mean here? |

## Project status

| Document | Contents |
| --- | --- |
| [Evidence](https://github.com/kemiller2002/limen/blob/main/docs/19-evidence.md) | What has actually been measured, what has not, and where every number comes from |
| [Roadmap](https://github.com/kemiller2002/limen/blob/main/docs/ROADMAP.md) | Every bridge responsibility vs. what is implemented and tested |
| [Documentation audit](https://github.com/kemiller2002/limen/blob/main/docs/DOCUMENTATION-AUDIT.md) | Findings from the documentation audit, including unresolved ambiguities |
| [Lifecycle conversion report](https://github.com/kemiller2002/limen/blob/main/docs/22-lifecycle-conversion-report.md) | What adding the CLI changed, and what was proven about it |
| [Usage (legacy)](https://github.com/kemiller2002/limen/blob/main/docs/USAGE.md) | The original consumer walkthrough, kept for continuity |

## The website

Limen's own site lives in [`site/`](https://github.com/kemiller2002/limen/tree/main/site) and is itself a Limen
application — the interactive sections run on the real kernel, the prose is
static HTML. It is verified by [`test/site.test.ts`](https://github.com/kemiller2002/limen/blob/main/test/site.test.ts)
(behavior, against the built pages) and
[`scripts/check-site.ts`](https://github.com/kemiller2002/limen/blob/main/scripts/check-site.ts) (the publishable artifact).
Build and serve it with `npm run serve:site`.

## Examples

All examples are executed by the test suite ([`test/examples.test.ts`](https://github.com/kemiller2002/limen/blob/main/test/examples.test.ts)),
so they cannot silently stop working.

| Example | Demonstrates |
| --- | --- |
| [01-counter](https://github.com/kemiller2002/limen/tree/main/examples/01-counter) | The minimum: event → transition → projection → DOM |
| [02-form](https://github.com/kemiller2002/limen/tree/main/examples/02-form) | Validation, capability projection, rejected illegal transitions |
| [03-fetch-data](https://github.com/kemiller2002/limen/tree/main/examples/03-fetch-data) | Http effect, list rendering, all four outcomes, stale-result rejection |
| [04-save-data](https://github.com/kemiller2002/limen/tree/main/examples/04-save-data) | Full save lifecycle, Storage effect, non-idempotent write safety |
| [05-multi-screen](https://github.com/kemiller2002/limen/tree/main/examples/05-multi-screen) | Screens as state, shared vs. screen-local state, engine-side filtering |
| [06-time-entries](https://github.com/kemiller2002/limen/tree/main/examples/06-time-entries) | A realistic feature: load, validate, add, mutate, refresh |
| [07-clipboard](https://github.com/kemiller2002/limen/tree/main/examples/07-clipboard) | The Clipboard capability: three failure reasons, only one worth retrying |
| [08-routing](https://github.com/kemiller2002/limen/tree/main/examples/08-routing) | The Navigation capability: typed routes, deep links, Back and Forward |
| [minimal](../examples/minimal/) | The copy shipped inside the npm package: four files, no build step, plus an optional view contract |
| [kitchen-sink](https://github.com/kemiller2002/limen/blob/main/examples/kitchen-sink.html) | Every bridge primitive and every effect outcome, interactively |

Every example has its own README covering its state model, event and effect
flow, exercises, and the mistakes people actually make with it.

## Governance and process

These are installed and owned by the Repository Operating System package, not by
the kernel. They describe process, not architecture.

- [Governance index](https://github.com/kemiller2002/limen/blob/main/docs/00-governance/README.md)
- [Work protocol](https://github.com/kemiller2002/limen/blob/main/docs/work-protocol.md)
- [Work adapter contract](https://github.com/kemiller2002/limen/blob/main/docs/work-adapter-contract.md)
- [Pilot measurement plan](https://github.com/kemiller2002/limen/blob/main/docs/PILOT-MEASUREMENT-PLAN.md)
- [Architecture records](https://github.com/kemiller2002/limen/blob/main/docs/architecture/README.md)
- [Decision navigation](https://github.com/kemiller2002/limen/blob/main/docs/decisions/README.md)

## Upstream specifications

The prompt specifications this implementation is derived from live in
[`prompts/`](https://github.com/kemiller2002/limen/blob/main/prompts/README.md). They are historical inputs, not a
description of the current code — where they disagree with the implementation,
the implementation wins, and the disagreements are recorded in
[ROADMAP.md](https://github.com/kemiller2002/limen/blob/main/docs/ROADMAP.md) and [DOCUMENTATION-AUDIT.md](https://github.com/kemiller2002/limen/blob/main/docs/DOCUMENTATION-AUDIT.md).
