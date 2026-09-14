# Integration guide

**What this answers:** how an existing application or team adopts this kernel —
including whether it should.

---

## Is this a good fit?

Be honest about it before adopting. The architecture is a strong constraint, and
it pays off in some situations and not others.

**Good fit**

- Behavior is complex and correctness matters more than visual richness —
  workflows, approvals, forms with real rules, anything with distinct states.
- Illegal intermediate states have caused real bugs.
- The logic should outlive the front end, or be portable to another language.
- AI agents do a meaningful share of the work and need one correct place per
  change.
- You want application logic testable without a browser.

**Poor fit**

- Highly dynamic or generative UI — dashboards that build layout from data,
  canvas/WebGL, rich-text editors.
- Deep URL routing and history are core requirements. **Not supported today.**
- You need browser capabilities beyond Http and `localStorage` and cannot afford
  to extend the protocol.
- Large virtualized lists — every projected item becomes a DOM node.
- The team wants a mainstream ecosystem of components and hiring familiarity.

**Neutral**

- Application size. The model scales down to a counter and up to a real feature;
  see [08-multi-screen-applications.md](08-multi-screen-applications.md) for
  structuring the latter.

---

## Adoption paths

### A. New application

The straightforward case. Follow
[02-getting-started.md](02-getting-started.md).

### B. A new feature inside an existing app

Workable, and the usual way in. The kernel binds `document.body` and claims
every `data-*` binding in the document — so give it a page of its own, or be
sure no other framework owns those elements.

```ts
// Mount on a dedicated page; the rest of the app is untouched.
await new BrowserKernel(createTransport(), document).start();
```

> **Constraint:** `start()` binds `document.body`, not a subtree. There is no
> root-element parameter. Running the kernel inside a component owned by another
> framework means both will fight over the same DOM, and the other framework
> will win by re-rendering nodes the kernel has bound. Scoping to a subtree is
> not supported today.

### C. Migrating an existing feature

Do it in this order. It front-loads the value and keeps each step reversible.

1. **Write down the state machine.** What states exist, what transitions are
   legal. Usually this alone finds bugs.
2. **Port the logic first, with no UI change.** Pure `transition` and `project`
   functions, unit-tested. The old UI keeps running.
3. **Then swap the view layer** to `data-*` bindings and the kernel.
4. **Delete the old state store.** If you skip this, you have two owners — the
   exact problem you were solving.

### D. Don't wrap it

Resist building a component library, a hook, or a store adapter around the
kernel. That layer becomes the second application framework the architecture
exists to prevent, and it will accumulate logic. If ceremony is bothering you,
the ceremony is about eight lines
([02-getting-started.md](02-getting-started.md)).

---

## Project layout

Small application:

```text
index.html
styles.css
src/
  engine.ts      state, transitions, projection, transport
  main.ts        wiring
test/
  engine.test.ts pure transition tests — no DOM needed
```

Larger — split by feature, not by technical layer:

```text
src/engine/
  state.ts             the top-level State type
  navigation.ts        screens and navigation transitions
  screens/
    customers/{state,transition,project}.ts
    settings/{state,transition,project}.ts
  project.ts           composes per-screen projections
  transport.ts         the single dispatch entry point
```

---

## Enforce the boundary in your own repository

The guarantee is only as good as its enforcement. Copy the mechanical check —
it is about 25 lines
([`scripts/check-architecture.ts`](../scripts/check-architecture.ts)) and it is
the difference between a rule and a wish.

```ts
for (const file of await files("src/engine")) {
  const source = await readFile(file, "utf8");
  for (const forbidden of ["document", "window", "fetch(", "localStorage", "sessionStorage"]) {
    if (source.includes(forbidden)) violations.push(`${file}: forbidden browser dependency ${forbidden}`);
  }
  if (/\b(any|dynamic)\b/.test(source)) violations.push(`${file}: dynamic type escape`);
}
```

Wire it into `npm test` so it runs on every CI run, not on request.

Also adopt from this repository's setup:

- `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- Exhaustive switches ending in `assertNever(state)` so a new state breaks the
  build where it must be handled
- Tests that assert the **illegal** transition, not only the legal one

---

## Backend expectations

The kernel makes no demands on your API. It parses the response as JSON and
hands you `unknown`.

Things worth deciding up front, because they change your state model:

- **Status codes.** A response whose body parses as JSON is reported as
  `Success` whatever its status; one that does not parse is
  `Failure { invalid-response, status }`. Either way the kernel never decides
  what a status *means* — check `outcome.status` yourself, **on both branches**.
- **Idempotency.** Which endpoints are safe to repeat after an
  `OutcomeUnknown`? For non-idempotent writes, consider server-side idempotency
  keys — it turns an unrecoverable "we don't know" into a safe retry.
- **Timeouts.** `timeoutMs` is required per request. Pick values matched to the
  endpoint, not one global constant.
- **Errors.** A non-JSON error page yields `Failure { invalid-response, status }`, which
  is not retryable. Returning JSON error bodies consistently gives your engine
  something to act on.

---

## Team conventions worth setting

| Decision | Suggested default |
| --- | --- |
| Event naming | user intent (`markProcessed`), never element (`buttonClick`) |
| View key naming | `xxxDisabled`/`xxxVisible` for capabilities; screen-prefixed for multi-screen |
| Correlation IDs | `"<operation>-<sequence>"`; keep them inside the state that awaits them |
| Illegal transitions | always rejected explicitly, always tested |
| Validation | in the engine, always — HTML validation is a UX courtesy, not a guarantee |
| Effect timeouts | per-endpoint, never a single global value |

---

## Review checklist

For any change built on this kernel:

- [ ] Application state changed in exactly one place
- [ ] No browser API in the engine (`npm run check:architecture` passes)
- [ ] No branching on domain meaning in kernel/bridge code
- [ ] Illegal transitions rejected — and tested
- [ ] Stale effect results rejected by `correlationId` — and tested
- [ ] All four Http outcomes handled; `OutcomeUnknown` not folded into `Failure`
- [ ] Capabilities projected explicitly, not re-derived in DOM or CSS
- [ ] Projection is total for every bound key in every branch
- [ ] `data-each` keys are stable and unique
- [ ] No new runtime dependency (or justified and recorded)
- [ ] Diagnostics carry no credentials
- [ ] `npm run check` passes

---

## Related

- [02-getting-started.md](02-getting-started.md) — from nothing to working
- [12-design-rules.md](12-design-rules.md) — the rules as MUST/SHOULD/MAY
- [13-anti-patterns.md](13-anti-patterns.md) — what going wrong looks like
- [17-wasm-migration.md](17-wasm-migration.md) — what "WASM-ready" buys you
