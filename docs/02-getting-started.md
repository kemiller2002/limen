# Getting started

**What this answers:** how to get from an empty directory to a working
application, with every command and every import verified.

Assumed: you know JavaScript or a comparable language. Not assumed: anything
about this kernel.

Target at the end of this page: a working counter, then the same counter with a
network call. Roughly twenty minutes.

---

## Before you start

- **Node ≥ 22.** Check with `node --version`.
- **TypeScript ≥ 5.9** — installed below. You can use plain JavaScript instead,
  but you lose the exhaustiveness checking that makes this architecture pleasant.
- **A static file server.** `python3 -m http.server` is fine. Opening the HTML
  as a `file://` URL will **not** work: ES modules require `http://`.

---

## 1. Create the project

```sh
mkdir my-app && cd my-app
npm init -y
npm pkg set type=module
npm install @echelon-foundry/typescript-wasm-kernel
npm install --save-dev typescript
```

## 2. Configure TypeScript

**`tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"]
}
```

`moduleResolution: "bundler"` matters — the package uses the `exports` field,
and older resolution modes will not find the subpath entry points.

## 3. The four files you need

Every application built on this kernel has the same four parts. Nothing is
optional, and there is nothing else.

| File | Responsibility | May touch the browser? |
| --- | --- | --- |
| `my-app/index.html` | Structure, and `data-*` bindings that name events and view keys | it *is* the browser |
| `my-app/src/engine.ts` | State, transitions, validation, projection | **never** |
| `my-app/src/main.ts` | Wiring: construct the kernel, start it | yes — this is the entry point |
| `my-app/styles.css` | Presentation | it *is* the browser |

Execution order at runtime: HTML parses → `main.js` loads → kernel starts →
engine projects → DOM updates.

## 4. Write the markup

**`my-app/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>My app</title>
    <link rel="stylesheet" href="./styles.css">
  </head>
  <body>
    <main>
      <button data-event="increment">Add one</button>
      <button data-event="reset" data-bind-disabled="resetDisabled">Reset</button>
      <p>Count: <span data-text="count">0</span></p>
    </main>
    <script type="module" src="./dist/main.js"></script>
  </body>
</html>
```

Three bindings are in play:

- `data-event="increment"` — when this element is activated, send
  `SemanticEvent { name: "increment" }`. The kernel picks the DOM event type
  from the tag: `<form>` → `submit`, `<input>`/`<select>`/`<textarea>` →
  `change`, everything else → `click`. Override with `data-on`.
- `data-text="count"` — set this element's `textContent` from `view.count`.
- `data-bind-disabled="resetDisabled"` — set the `.disabled` property from
  `view.resetDisabled`.

The `0` inside the `<span>` is a placeholder for before the first projection
lands. The kernel overwrites it immediately.

## 5. Define state and transitions

**`my-app/src/engine.ts`**

```ts
import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
  ViewState,
} from "@echelon-foundry/typescript-wasm-kernel/protocol";

// 1. Authoritative state. This is the only place it exists.
export type State = { readonly count: number };
const initialState: State = { count: 0 };

// 2. A closed vocabulary of commands.
export type Command =
  | { readonly kind: "Increment" }
  | { readonly kind: "Reset" };

// 3. Event names arrive as open strings. Narrow them here, and reject
//    anything unrecognized — a typo in an HTML attribute should be loud.
export function eventToCommand(name: string): Command {
  switch (name) {
    case "increment": return { kind: "Increment" };
    case "reset":     return { kind: "Reset" };
    default: throw new Error(`Unrecognized event: ${name}`);
  }
}

// 4. The transition. Pure: same inputs, same output, no side effects.
export function transition(state: State, command: Command): State {
  switch (command.kind) {
    case "Increment": return { count: state.count + 1 };
    case "Reset":     return initialState;
  }
}

// 5. The projection. Pure. Note that it publishes a *capability*
//    (resetDisabled), not just data.
export function project(state: State): ViewState {
  return {
    count: state.count,
    resetDisabled: state.count === 0,
  };
}

// 6. The transport: the object the kernel actually talks to.
export function createTransport(): EngineTransport {
  let state = initialState;
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (message.kind === "Event") {
        state = transition(state, eventToCommand(message.event.name));
      }
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}
```

That `let state` is the only mutable cell in the application. Everything else is
a pure function of it.

### Why write your own transport?

The package exports a `DirectTypeScriptTransport`, and you will see it in older
snippets. **Do not use it for your own application.** It is hard-wired to this
repository's demo domain (email-availability checking) and understands only the
event names `emailChanged` and `checkAvailability`. It exists as a reference,
not as a base class. Your transport is the eight lines above.

## 6. Wire it up

**`my-app/src/main.ts`**

```ts
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
import { createTransport } from "./engine.js";

await new BrowserKernel(createTransport(), document).start();
```

Note `./engine.js`, not `./engine.ts` — TypeScript's ES-module output keeps the
specifier you write, and the browser needs the emitted filename.

`start()` does three things in order: starts the transport, scans
`document.body` for `data-*` bindings, then dispatches `Initialize` so the
engine can project its first view. Nothing renders before that, which is why
the HTML carries a placeholder.

## 7. Build and run

```sh
npx tsc
python3 -m http.server 4173
```

Open <http://localhost:4173/>. Clicking **Add one** increments; **Reset** starts
disabled and becomes available once the count is above zero.

## 8. Add a network call

Two changes. First, state gains the shape of an operation that can be in flight
or have failed:

```ts
export type State =
  | { readonly kind: "Idle";    readonly count: number }
  | { readonly kind: "Saving";  readonly count: number; readonly correlationId: CorrelationId }
  | { readonly kind: "Failed";  readonly count: number; readonly reason: string };
```

Second, the transition *requests* an effect rather than performing one:

```ts
case "Save":
  if (state.kind !== "Idle") return { state, effects: [] };   // already in flight
  return {
    state: { kind: "Saving", count: state.count, correlationId },
    effects: [{
      kind: "Http",
      correlationId,
      method: "POST",
      url: "/api/count",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ count: state.count }),   // you serialize; the kernel doesn't look
      timeoutMs: 5000,
    }],
  };
```

The kernel performs the `fetch`, then sends the result back as an ordinary
input message:

```ts
if (message.kind === "EffectResult" && message.result.kind === "HttpResult") {
  // Reject a result that isn't for the request we're actually waiting on.
  if (state.kind !== "Saving" || state.correlationId !== message.result.correlationId) {
    return { view: project(state), effects: [], cancellations: [] };
  }
  switch (message.result.outcome.kind) {
    case "Success":        /* → Idle */        break;
    case "Failure":        /* → Failed */      break;
    case "Cancelled":      /* → Idle */        break;
    case "OutcomeUnknown": /* → needs reconciliation, NOT a blind retry */ break;
  }
}
```

You must handle all four. TypeScript will tell you if you don't.

A complete, running version of this is
[`examples/03-fetch-data/`](../examples/03-fetch-data/) — read
[`engine.ts`](../examples/03-fetch-data/engine.ts) alongside
[`index.html`](../examples/03-fetch-data/index.html).

## 9. Test it

Transitions are pure functions, so testing needs no browser, no DOM, and no
mocks:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { transition, project } from "../src/engine.ts";

test("increment advances the count", () => {
  const next = transition({ count: 0 }, { kind: "Increment" });
  assert.equal(next.count, 1);
});

test("reset is unavailable at zero", () => {
  assert.equal(project({ count: 0 }).resetDisabled, true);
});
```

```sh
node --experimental-strip-types --test test/*.test.ts
```

Testing DOM behavior needs jsdom and has timing rules worth knowing before you
write the first one — see [09-testing-and-debugging.md](09-testing-and-debugging.md).

---

## What you now have

- One place that owns application state
- Transitions that are pure functions and testable without a browser
- A UI that cannot show an impossible combination, because state is a union
- External calls that are explicit and whose failure modes are all handled

## Next

| Question | Document |
| --- | --- |
| How should I shape my `State` type? | [04-state-model.md](04-state-model.md) |
| What can `data-*` do? | [06-rendering.md](06-rendering.md) |
| What other effects exist? | [07-effects-and-browser-interop.md](07-effects-and-browser-interop.md) |
| I have more than one screen | [08-multi-screen-applications.md](08-multi-screen-applications.md) |
| How do I do *X*? | [15-recipes.md](15-recipes.md) |
| It's not working | [16-troubleshooting.md](16-troubleshooting.md) |
