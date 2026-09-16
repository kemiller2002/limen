# Evidence

**What this answers:** what has actually been measured about Limen, what has
not, and where every number comes from.

The short version: **no quantitative claim about Limen is supported by evidence
today.** What exists is evidence about *SDE*, about *language and style*, and
two qualitative observations about Limen itself. Those are different things and
are kept apart here deliberately.

---

## Classification

Every entry below carries a strength label. Only the first three may support a
public quantitative claim.

| Strength | Means |
| --- | --- |
| **Measured** | Directly counted in a recorded run, with the artifact available |
| **Derived** | Computed from measured values, with the computation stated |
| **Observed** | Seen and recorded, but not counted or controlled |
| **Experimental** | From a preregistered trial whose design limits generalization |
| **Directional** | Suggests a direction; sample or control too weak to quantify |
| **Insufficient evidence** | Not measured. Says so, and stops. |

And the attribution question, which matters more than the strength:

| Subject | What the evidence is actually about |
| --- | --- |
| **SDE** | the State-Directed Engineering method |
| **Limen** | this boundary architecture |
| **Language** | F# / C# / TypeScript / JavaScript properties |
| **Combined** | a system where the above cannot be separated |

**Do not move a row between these columns.** An SDE result is not a Limen
result, however convenient that would be.

---

## Limen

### What is measured

Nothing. There is no controlled measurement of Limen's effect on development
time, token consumption, cost, defect rate, context consumption, files
inspected, or agent comprehension.

| Claim | Status |
| --- | --- |
| Limen reduces development time | **Insufficient evidence** — not measured |
| Limen reduces agent token consumption | **Insufficient evidence** — not measured |
| Limen reduces cost | **Insufficient evidence** — not measured |
| Limen reduces defects | **Insufficient evidence** — not measured |
| Limen makes agents more accurate | **Insufficient evidence** — not measured |
| Limen reduces context/discovery surface | **Insufficient evidence** — not measured |

The benefits listed in the [README](../README.md) are stated as *architectural
consequences* — things that follow from the boundary by construction — not as
measured outcomes. "Application state exists in one place" is true because the
engine is the only writer, not because a study found it.

### What is observed

Two things, both qualitative, both from a real consumer project
(`kemiller2002/time-entry-state-machine`).

#### L-1 · An F# engine runs behind `EngineTransport` with no kernel change

**Strength: Observed (existence proof) · Subject: Limen**

That project implements `EngineTransport` over the .NET WASM runtime and drives
an F# engine through it:

```js
// web/wasm-engine-transport.js
const { dotnet } = await import(`${WASM_FRAMEWORK_BASE}/dotnet.js`);
const responseJson = this.#exports.TimeEntryWasm.Dispatch(JSON.stringify(message));
return JSON.parse(responseJson);
```

The F# side is a full engine — `Protocol.fs`, `Dispatch.fs`, `Projections.fs`,
`Session.fs`, `DocumentCodec.fs` — behind a single `[JSExport]` method. The
project consumes this package directly (`file:../typescript-wasm-kernel`), and
the transport's own header records that it required **no kernel change**.

**What this establishes:** the claim in
[17-wasm-migration.md](17-wasm-migration.md) — that `EngineTransport` is a
sufficient seam for a WASM engine, and that the protocol's
JSON-serializable-only design is what makes that possible — is demonstrated,
not merely argued. One working instance.

**What it does not establish:** anything about performance, bundle size,
startup cost, developer effort, or whether this is *better* than an
alternative. It is an existence proof and nothing more.

#### L-2 · A silent-failure mode found only by loading the page

**Strength: Observed (single incident) · Subject: Limen**

From that project's own effort log, among six recorded mistakes:

> **Live-browser-caught.** `data-if` was written directly on a `<p>` element
> instead of wrapping it in a `<template>` — the kernel only recognizes
> `data-if` on `<template>`, so the binding was silently ignored and the
> empty-state message never disappeared. Found only by actually loading the
> page and checking, not by any test.

Verified against this repository's source: `#bindElement` guarded on
`el instanceof HTMLTemplateElement`, so the attribute fell through with no
error and no warning.

**Acted on.** This is finding P-2, now fixed — a misplaced `data-if`/`data-each`
throws, is reported as `BridgeError { phase: "binding" }`, and is covered by
regression tests. See [16-troubleshooting.md](16-troubleshooting.md).

**What this establishes:** one real, externally-sourced usability defect, and a
general lesson this codebase had already recorded independently as finding D-5
— *silent* binding failures are the expensive kind, because nothing surfaces
them until a human looks at the page.

**What it does not establish:** a defect *rate*. It is one incident.

---

## SDE — not Limen

> **These runs do not use Limen.** Verified, not assumed: both trial branches
> contain zero references to `limen`, `typescript-wasm-kernel`,
> `BrowserKernel`, `EngineTransport`, or `data-event`, and both declare zero
> runtime dependencies. They are Node CLI applications built with SDE.
>
> Attributing any of the following to Limen would be the exact error §27 of the
> productization brief warns about.

**Source:** `kemiller2002/SDE-Engineering-Trial-2-Greenfield-Construction`,
branches `claude/greenfield-engineering-experiment-2-ee44qz` and
`claude/greenfield-experiment-2b-replication-n8pgtq`. Both carry a frozen
preregistration, a contemporaneous telemetry file, a journal, and a
scope-variance analysis.

### The strongest single result

**Strength: Measured · Subject: SDE (verification method)**

> In Experiment 2B, an independent fresh-agent review (Phase 7) produced **5
> findings, with 0 of 5 overlapping** the builder's own 90-test suite and
> written self-review. Four were real defects (DEF-004–007); the fifth was an
> interpretation ambiguity, deliberately left unresolved.

This is the cleanest number in the whole corpus: heterogeneous verification
found defects that homogeneous verification did not, on the same code, at a
measured zero overlap.

**Limits:** n = 1 run, one reviewer, one codebase. It shows the overlap *can* be
zero, not that it usually is.

### Recorded metrics

**Strength: Measured / Experimental · Subject: SDE**

| Metric | Experiment 2 | Experiment 2B (replication) |
| --- | --- | --- |
| Wall clock, T0→T6 | ~30 min | ~3h 12m |
| Source | 2,106 LOC / 22 files | 2,699 LOC / 22 files |
| Tests passing | 87 | 90 |
| Requirements met | 12 TR / 20 BR / 58 AC | 12 TR / 20 BR / 58 AC |
| Defects found | 4 | 7 (+1 ambiguity) |
| Repair loops | 1 | 6 |
| Human interventions | 0 | 0 |
| Runtime dependencies | 0 | 0 |
| Requirements guessed past | 0 | 0 (9/9 open questions preserved) |

**The wall-clock difference is not a finding.** The two runs did different
amounts of work: 2B added mutation testing, an independent verification phase,
a defect register, and a cross-experiment comparison. Reading "2 was 6× faster"
out of that table would be wrong.

### Token and cost data

**Strength: Measured, single data point · Subject: SDE (sub-agent only)**

Almost all token and cost telemetry is marked `unavailable — not exposed to
agent` in both runs, explicitly rather than by omission. Exactly one sub-unit
was instrumented:

> Phase 7 independent-verification sub-agent: **164,383 tokens, 35 tool uses,
> 483,872 ms (~8.1 min)**.

That is the only token figure in the corpus. It describes one verification
sub-agent, not a construction run, and cannot be scaled to one.

---

## Language and style — not Limen

**Strength: Measured (single case) · Subject: Language (C#)**

**Source:** `kemiller2002/time-entry-state-machine`,
`effort-experiment/EFFORT-LOG.md`.

> Changing 4 method signatures (`out string?` → `out List<Diagnostic>`) produced
> exactly **1** compile error across roughly **10** affected call sites. About 9
> declared the out-parameter as `out var` and either never used it or used it
> only in string interpolation — which still compiles, printing
> `System.Collections.Generic.List\`1[…]` instead of a useful message. The one
> site the compiler caught had called a `string`-specific method.

A concrete, observed cost of `var`-heavy style during a meaning-changing
refactor. It is about C# and `var`. It says nothing about Limen.

### Why the related hypotheses are not published as findings

That project's own registry rates all three of its hypotheses **low
confidence**, each with recorded *contradicting* evidence:

| Hypothesis | Confidence | Its own contradicting evidence |
| --- | --- | --- |
| HY-TE-2026-0001 — explicit domain types reduce ripple cost | **low** | "arithmetic/numeric-literal sites unprotected in both languages" |
| HY-TE-2026-0002 — hodgepodge C# incurs more undetected mistakes | **low** | "raw mistake counts came out roughly even between the two builds" |
| HY-TE-2026-0003 — the mechanism worsens without a type checker | **low** | "raw rework-mistake count was actually *lower* in the JavaScript trial — 2 versus 6" |

Publishing "explicit state modeling reduces mistakes" would contradict the
source project's own assessment. The defensible statement is narrower and is
what HY-0002 actually says: the effect appears to be in *which mechanism
catches a mistake*, not in *how many mistakes occur*.

---

## Data-quality issues found

Recorded rather than quietly worked around. Both should be resolved before
either figure is published anywhere.

| # | Issue |
| --- | --- |
| Q-1 | Test LOC is reported as **identical (1,421)** in both Experiment 2 and Experiment 2B, despite different file counts (12 vs 6). Either a genuine coincidence or a transcription error; not currently distinguishable from the artifacts. |
| Q-2 | `EFFORT-LOG.md`'s F# section states **6 mistakes total**, but its by-catcher breakdown sums to 7 (`test suite (2)` appears to be 1 — the per-increment lists give 5 + 1 + 0 = 6, caught by compiler 2 / self 1 / test 1 / live 2). |
| Q-3 | `registries/evidence.json` in `time-entry-state-machine` contains **0 records**, though three experiments and three hypotheses are registered. No formal `EV-` records exist, so provenance chains are incomplete. |
| Q-4 | This repository's own research registries (`registries/*.json`) are **all empty**. No evidence has ever been recorded here. |

Credit where due: both source projects flag their own threats to validity
unprompted. The effort log explicitly warns that its 5 → 1 → 0 mistake curve
"is at least partly a learning-curve effect … not necessarily evidence the
*architecture* got safer."

---

## What would actually measure Limen

None of the above isolates Limen, because no controlled comparison has been run
where Limen is the only variable. Such a trial would need:

1. One requirement set, implemented twice.
2. Same agent, same model, same reasoning effort, same verification standard.
3. One arm on Limen; one on a conventional browser architecture.
4. Both arms instrumented for: wall clock, tokens, cost, files inspected, files
   modified, build/test cycles, defects by discovery stage, rework, and
   escaped defects.
5. Preregistered predictions, frozen before either arm starts.
6. An independent verification pass on both arms — given the 0/5 overlap
   result above, self-review alone will not find the defects that matter.

**The blocker is instrumentation, not willingness.** Token, cost, and
context-window figures are not exposed to a running agent in machine-readable
form; both existing trials record this and refuse to estimate. Until that
changes, a Limen trial can measure time, files, defects, and rework — but not
tokens or cost, which are the numbers most often asked for.

Per this repository's own deferral policy, that trial should be run when there
is a decision it would inform — not to produce a number for a web page.

---

## Provenance

| Evidence | Source |
| --- | --- |
| L-1 WASM existence proof | `kemiller2002/time-entry-state-machine` — `web/wasm-engine-transport.js`, `f-sharp/src/TimeEntry.Engine/`, `package.json` dependency on this package |
| L-2 silent `data-if` failure | same repo — `effort-experiment/EFFORT-LOG.md`, F#-increment-1, mistake 5; verified against [`src/kernel/browser-kernel.ts`](../src/kernel/browser-kernel.ts) |
| SDE trial metrics | `kemiller2002/SDE-Engineering-Trial-2-Greenfield-Construction` — `experiment/TELEMETRY.md`, `experiment-2b/TELEMETRY.md` |
| 0/5 verification overlap | same repo — `experiment-2b/INDEPENDENT-VERIFICATION.md`, `experiment-2b/DEFECT-REGISTER.md` |
| Sub-agent token figure | same repo — `experiment-2b/TELEMETRY.md`, "Agent / model" section |
| `var` refactor finding | `kemiller2002/time-entry-state-machine` — `effort-experiment/EFFORT-LOG.md`, section C8 |
| Hypothesis confidence ratings | same repo — `registries/hypotheses.json` |

All source repositories are private except where noted; figures above are
transcribed from their recorded artifacts, not re-derived.

---

## Related

- [DOCUMENTATION-AUDIT.md](DOCUMENTATION-AUDIT.md) — findings about this repository
- [17-wasm-migration.md](17-wasm-migration.md) — what L-1 demonstrates
- [ROADMAP.md](ROADMAP.md) — what is built vs. deferred
