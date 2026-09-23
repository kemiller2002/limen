# Federated WebAssembly modules

**What this answers:** how to split a Limen application across multiple independently
loaded engines without creating shared mutable state, browser-side application
authority, or a distributed monolith inside one page.

---

## The rule

A federated Limen application is a set of **bounded state systems**.

Each module owns a coherent domain capability, its state, its legal transitions,
its invariants, and its interpretation of evidence. Other modules may send it
requests or consume its published events and projections, but they never mutate
its state directly.

> Split by state ownership and domain capability, not by screen, widget, or file
> size.

A separate WebAssembly binary is useful when it creates a meaningful ownership,
loading, deployment, or lifecycle boundary. It is not useful merely because a
source directory became large.

---

## Architecture

```text
HTML / CSS / browser APIs
          |
          v
     Limen kernel
  browser mechanism only
          |
          v
   application shell
          |
          v
  ModuleFederation
 registry · lifecycle
 contract validation
 envelope routing
   /      |       \
  v       v        v
WASM A   WASM B   WASM C
state    state    state
rules    rules    rules
trans.   trans.   trans.
```

The federation layer coordinates modules but owns no domain state. It is
language-neutral. An individual module can be F#/.NET WebAssembly, TypeScript,
or another runtime behind `FederatedModuleTransport`.

The browser boundary remains unchanged: browser capabilities still belong to
Limen. Federation is an application-engine composition mechanism, not a new
place to perform `fetch`, access the DOM, or keep business state.

---

## What belongs in one module

A module SHOULD contain a set of states that normally change together and are
governed by the same invariants.

Good boundaries:

- time-entry capture;
- billing/invoicing;
- identity/session policy;
- assessment execution;
- campaign authoring;
- reporting;
- organization administration.

Usually bad boundaries:

- one WASM per page;
- one WASM per modal;
- one WASM per web component;
- a "shared models" WASM containing every application's domain types;
- a utilities WASM used as an implicit service locator.

A useful test is:

> Can this module decide whether a requested state transition is legal without
> reaching into another module's private state?

If not, the boundary is probably wrong or the module needs an explicit
projection/evidence contract.

---

## The manifest

Every module supplies a `ModuleManifest`.

It declares:

- stable module identity;
- module version;
- Limen federation protocol version;
- contracts accepted, including version ranges;
- contracts emitted, including version ranges;
- required capabilities;
- module dependencies;
- routes supplied by the module.

Example:

```ts
const manifest: ModuleManifest = {
  id: "chrona.time-entry" as ModuleId,
  version: "4.2.0",
  federationProtocolVersion: FEDERATION_PROTOCOL_VERSION,
  accepts: [
    {
      contract: "chrona.project.selected" as ContractId,
      minVersion: 1,
      maxVersion: 2,
    },
  ],
  emits: [
    {
      contract: "chrona.time-entry.completed" as ContractId,
      minVersion: 3,
      maxVersion: 3,
    },
  ],
  capabilitiesRequired: ["storage.write"],
  dependencies: [],
  routes: ["/time", "/time/edit/*"],
};
```

Compatibility is checked at runtime before a target module receives a message.
A module cannot silently consume a contract version it did not declare.

The manifest is deliberately descriptive. It does not grant application
authority.

---

## Envelopes are the only cross-module state-system boundary

Modules exchange `FederationEnvelope` values.

Important fields:

| Field | Purpose |
| --- | --- |
| `source` / `target` | explicit ownership and routing |
| `correlationId` | groups one request/response conversation |
| `causationId` | records what message caused a later message |
| `idempotencyKey` | lets a domain reject/replay duplicate externally meaningful work |
| `kind` | transition request, result, event, query, projection, effect message |
| `contract` / `contractVersion` | semantic contract and wire version |
| `expectedStateVersion` | optimistic concurrency evidence supplied to the owner |
| `capabilities` | authority/capability evidence supplied with a request |
| `evidence` | evidence references needed by the receiving state system |
| `payload` | contract-owned JSON-safe data |

The federation layer validates transport facts. It does **not** decide whether a
business transition is legal.

For example, it can prove that module B accepts
`chrona.time-entry.submit@3`. Only module B can decide whether the requested
submission is legal from its current state.

---

## Transition requests, never remote mutation

Do this:

```text
Module A
  |
  | TransitionRequest
  | contract = chrona.time-entry.submit@3
  | expectedStateVersion = 17
  | evidence = [...]
  | capabilities = [...]
  v
Module B
  |
  | evaluates its own state + rules
  |
  +--> TransitionAccepted
  +--> TransitionRejected
  +--> AdditionalInformationRequired
```

Do not do this:

```text
moduleB.state.currentEntry = ...
```

Do not export another module's mutable state object. Do not share a domain store
between WASMs. Do not put all domain DTOs in one giant shared assembly merely so
every module can reach every other module's internals.

The receiver owns the transition.

---

## Events and projections

A module may publish a `DomainEvent` without a target. Limen fans that event
out only to active modules whose manifests declare a compatible contract
version.

Other message kinds require an explicit target. Commands and queries should not
accidentally become broadcasts.

Prefer purpose-specific projections and events over exposing complete internal
state.

For example, a billing module may need:

```text
CustomerBillingProfile {
    customerId
    billingStatus
    currency
}
```

It probably does not need the customer module's complete aggregate, transient UI
state, pending obligations, or internal evidence graph.

---

## Lifecycle

The legal module lifecycle is explicit:

```text
Unloaded
   |
  load
   v
Loaded
   |
 initialize
   v
Initialized
   |
 restore(snapshot)
   v
Restored
   |
 activate
   v
Active
   |
 suspend
   v
Suspended
   |
 snapshot
   v
Snapshotted
   |
 unload
   v
Unloaded
```

This makes lazy loading and unloading deterministic. A shell can load a domain
only when a route or workflow needs it, snapshot it when inactive, and restore
it later.

Lifecycle order is checked by `ModuleFederation`; illegal calls are rejected
before module code is invoked.

A module should treat its snapshot as its own versioned persistence format.
Cross-module references should be stable identifiers, not object identity.

---

## Cross-module workflows

Do not attempt an in-browser distributed ACID transaction across WASMs.

A workflow spanning modules is a state machine of its own, commonly called a
process manager or saga:

```text
Requested
   |
   v
TimeEntryAccepted
   |
   v
BillingRequested
   |
   +--> BillingAccepted --> Complete
   |
   +--> BillingRejected --> CompensationRequired
```

That orchestration state must be explicit somewhere. It must record enough
information to resume after reload and to distinguish:

- success;
- rejection;
- known failure;
- cancellation;
- unknown outcome;
- compensation required.

Correlation IDs, causation IDs and idempotency keys are protocol support for
that model. They are not a substitute for a domain workflow.

---

## Unknown effects remain unknown

Federation does not weaken Limen's effect semantics.

If an external operation was dispatched and its outcome cannot be known, the
receiving domain must preserve that uncertainty and create the appropriate
reconciliation obligation.

Never translate an unknown effect into "failed" merely because the result
crossed a WASM boundary.

---

## Negative knowledge and evidence

An envelope may carry evidence identifiers and capability identifiers, but those
are references, not automatic truth.

The receiving module owns:

- whether the evidence is applicable;
- whether it is current;
- whether required evidence is missing;
- whether negative knowledge changes legal transitions;
- whether an expected state version is stale;
- whether the supplied capability authorizes the transition.

This preserves Ordo-style state/evidence semantics across a module boundary
without moving those decisions into the shell.

---

## Avoid cross-module chatter

A WASM boundary is not a reason to create a message for every keystroke.

Transient interaction state belongs with the module that owns the interaction.
Send a cross-module message when another bounded state system has something
meaningful to decide or record.

Bad:

```text
key "a" -> module B
key "b" -> module B
key "c" -> module B
```

Better:

```text
user commits CustomerSearch("abc")
    -> relevant query/projection boundary
```

The same rule that keeps microservices from becoming chatty distributed
monoliths applies inside a browser.

---

## Serialization

The federation contract permits only `JsonValue` payloads today.

That is intentional:

- it is language-neutral;
- it survives independent heaps and WASM runtimes;
- it can be logged and replayed in tests;
- it prevents object identity from becoming a hidden coupling mechanism.

Start with JSON serialization at the runtime adapter. Optimize only after
measurement demonstrates a real bottleneck.

Possible later optimizations include binary codecs, `ArrayBuffer` transfer,
or shared memory for deliberately chosen high-volume paths. Those should be
contract-preserving transport optimizations, not an excuse to introduce shared
mutable domain state.

---

## Deterministic testing

A module should be independently testable without a browser or another module.

Given:

1. a snapshot;
2. a module manifest;
3. a sequence of federation envelopes;

a test should be able to observe:

- accepted/rejected transitions;
- emitted envelopes;
- requested effects;
- obligations;
- final snapshot/projection.

`ModuleFederation` itself is tested separately for:

- lifecycle order;
- dependency/capability checks;
- contract-version compatibility;
- explicit targeting;
- event fan-out;
- source identity enforcement;
- message-cycle/delivery limits.

This separation lets application tests prove domain behavior while federation
tests prove boundary behavior.

---

## Failure isolation

A module boundary should also be a diagnosable failure boundary.

The shell should know which module failed to load or dispatch, but it should not
invent a business recovery state. The owning workflow decides whether the
application can continue, retry, fall back, or require user intervention.

A future production host may add diagnostics, telemetry and module-level circuit
breaking around `FederatedModuleTransport`. Those mechanisms must remain
semantically blind.

---

## Current implementation status

Implemented in the npm package:

- language-neutral `FederatedModuleTransport`;
- `ModuleManifest`;
- versioned `FederationEnvelope`;
- explicit lifecycle;
- dependency-ordered startup, dependency-cycle/in-use protection, and capability preflight;
- emitted/accepted contract validation;
- source identity enforcement;
- targeted messages;
- compatible `DomainEvent` fan-out;
- bounded exchange delivery to detect message cycles;
- deterministic tests.

Not yet claimed:

- the Limen product site has **not** been converted into multiple independent
  F# WASM binaries;
- no performance or startup improvement has been measured;
- no binary codec has been demonstrated;
- no shared-memory transport is implemented;
- no generic durable saga store is provided.

The first two points matter. Federation support is now an implemented package
capability, while multi-F#-WASM self-hosting remains the next existence proof.

---

## Anti-patterns

Reject these during review:

1. **Shared mutable cross-module state.**
2. **A giant shared domain assembly** that gives every module every internal
   type.
3. **Browser logic in a domain module** merely because WASM can call JavaScript.
4. **Application decisions in `ModuleFederation`**.
5. **Commands without targets.**
6. **Blind version acceptance.**
7. **One message per UI micro-interaction** when no other bounded state system
   needs to decide anything.
8. **Distributed ACID assumptions** across modules.
9. **Automatic retry after an unknown external outcome.**
10. **Loading every module at startup** without evidence that it is necessary.
11. **Splitting by screen or component** rather than state ownership.
12. **Treating projections as writable remote state.**

---

## Public API

Import directly:

```ts
import {
  FEDERATION_PROTOCOL_VERSION,
  ModuleFederation,
  type FederatedModuleTransport,
  type FederationEnvelope,
  type ModuleManifest,
} from "@echelon-foundry/typescript-wasm-kernel/federation";
```

or from the package root.

The federation protocol version is independent of an individual module's
semantic version and independent of the existing browser/engine
`PROTOCOL_VERSION`. A future federation wire-format break therefore does not
force a browser-kernel protocol break, and vice versa.

---

## Related

- [Architecture](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/01-architecture.md)
- [State model](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/04-state-model.md)
- [Effects and browser interop](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/07-effects-and-browser-interop.md)
- [WebAssembly status](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/17-wasm-migration.md)
- [Design rules](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/12-design-rules.md)
