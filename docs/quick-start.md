# Quick start

A working Limen application in about five minutes, with nothing elided and no
API invented for the sake of a tidy example. Every line below is executed by
this repository's test suite.

> **Which version is this?** This file ships **inside the npm package**, so it
> describes exactly the version you installed. The copy on GitHub describes
> `main`, which may be ahead of the latest release.

---

## 1. Install

```sh
npm install @echelon-foundry/typescript-wasm-kernel
```

That is the whole install. The package has **no runtime dependencies**.

Requirements: Node ≥ 22 to build or test; any browser with ES2022 modules,
`fetch` and `AbortController` to run.

## 2. The HTML

Limen does not generate HTML. You write it, and mark the parts the engine
drives.

```html
<!doctype html>
<html lang="en">
  <body>
    <main>
      <h1>Counter</h1>

      <!-- Sends SemanticEvent { name: "increment" }. The kernel has no idea
           what "increment" means — that is the point. -->
      <button data-event="increment">Add one</button>

      <!-- Sets the .disabled property from view.resetDisabled. The engine
           decides availability; the DOM never re-derives it. -->
      <button data-event="reset" data-bind-disabled="resetDisabled">Reset</button>

      <!-- Sets textContent from view.count. -->
      <p>Count: <span data-text="count">0</span></p>
    </main>

    <script type="module" src="./main.js"></script>
  </body>
</html>
```

## 3. The engine

All of your application's meaning lives here. This file imports **nothing** at
runtime — it cannot reach `document`, `fetch` or `localStorage`, and a build
check enforces that.

```ts
// engine.ts
import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
  ViewState,
} from "@echelon-foundry/typescript-wasm-kernel/protocol";

type State = { readonly count: number };

// Pure: same inputs, same output. Testable with no browser at all.
const transition = (state: State, name: string): State => {
  switch (name) {
    case "increment": return { count: state.count + 1 };
    case "reset":     return { count: 0 };
    // An unrecognised event is a wiring bug — a data-event nothing answers.
    default: throw new Error(`Unrecognized event: ${name}`);
  }
};

// Pure: state in, view out. Note `resetDisabled`: the engine decides whether
// Reset is allowed. Projecting capabilities instead of letting the DOM
// reconstruct them is most of what using Limen well consists of.
const project = (state: State): ViewState => ({
  count: state.count,
  resetDisabled: state.count === 0,
});

export function createCounterTransport(): EngineTransport {
  let state: State = { count: 0 };
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (message.kind === "Event") state = transition(state, message.event.name);
      // Every response carries a full projection, any effects to run, and any
      // in-flight effects to cancel. This engine requests no effects.
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}
```

## 4. The wiring

Three lines, and this is the only file that touches the browser.

```ts
// main.ts
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
import { createCounterTransport } from "./engine.js";

await new BrowserKernel(createCounterTransport(), document).start();
```

## 5. Run it

```sh
npx tsc            # if you wrote TypeScript
python3 -m http.server 4173
```

Open <http://localhost:4173/>. It must be **served** — ES modules do not work
from a `file://` URL.

Using no bundler and no TypeScript? A complete JavaScript copy of this exact
application ships in this package at
[`examples/minimal/`](../examples/minimal/README.md), including the import map
a browser needs to resolve a bare package name.

## What just happened

```text
click
  → SemanticEvent { name: "increment" }
  → transition(state, "increment") → { count: 1 }
  → project(state) → { count: 1, resetDisabled: false }
  → the kernel writes "1" into the <span> and enables Reset
```

Two facts do most of the work:

1. **State exists in exactly one place.** The number on screen is a picture of
   it, never a second copy.
2. **`resetDisabled` is projected, not derived.** The DOM never works out for
   itself whether Reset should be available.

## Next

| You want | Read |
| --- | --- |
| Who owns what, and why | [mental-model.md](mental-model.md) |
| Where a given change belongs | [where-code-goes.md](where-code-goes.md) |
| The exact API | [11-api-reference.md](11-api-reference.md) |
| Something is broken | [16-troubleshooting.md](16-troubleshooting.md) |
| A word you do not recognise | [glossary.md](glossary.md) |

### What else ships in this package

`README.md`, `LICENSE`, `CHANGELOG.md`, the five documents linked above, and
the complete minimal application in `examples/minimal/`.

Everything else — eight progressive examples covering forms, validation, fetch,
storage, clipboard and routing; the anti-patterns catalogue; the agent guide;
the architecture notes — lives online:

- Examples: <https://github.com/kemiller2002/typescript-wasm-kernel/tree/main/examples>
- Documentation index: <https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/README.md>
- Repository: <https://github.com/kemiller2002/typescript-wasm-kernel>
