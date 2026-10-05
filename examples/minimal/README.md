# The minimal Limen application

This is the smallest complete Limen application, and it ships **inside the npm
package** so you can read a whole working example without cloning anything.

Four files. Nothing elided, nothing abstracted.

| File | Responsibility | Touches the browser? |
| --- | --- | --- |
| [`index.html`](index.html) | structure and `data-*` bindings | it *is* the browser |
| [`engine.js`](engine.js) | state, transitions, projection | **never** |
| [`main.js`](main.js) | constructs the kernel and starts it | yes — the entry point |
| [`package.json`](package.json) | the one dependency | — |

One optional file sits beside them: [`index.view.json`](index.view.json), the
page's view contract. The application runs without it; see
[Checking the page before it runs](#checking-the-page-before-it-runs).

## Run it

From an empty directory:

```sh
npm init -y
npm install @echelon-foundry/limen
# copy index.html, engine.js and main.js from this directory
python3 -m http.server 4173
```

Then open <http://localhost:4173/>. Click **Add one**; the number changes and
**Reset** becomes available.

It must be *served*, not opened as a `file://` URL — ES modules and import maps
both require an origin.

## What it demonstrates

```text
click  →  SemanticEvent { name: "increment" }  →  transition()  →  new State
       →  project()  →  ViewState { count, resetDisabled }  →  the DOM
```

Three things are worth pausing on:

1. **`engine.js` imports nothing.** It cannot reach `document`, `fetch` or
   `localStorage`, so the application's logic is portable by construction — to
   a test, to a worker, eventually to another language.
2. **`resetDisabled` is projected, not derived.** The engine decides whether
   Reset is allowed. The DOM never works it out from the number on screen.
   Doing that consistently is most of what using Limen well consists of.
3. **The kernel understands no application vocabulary.** It moves the string
   `"increment"` across the boundary without knowing what it means.

## No build step

`main.js` imports the package by name, and browsers cannot resolve a bare
specifier on their own — so `index.html` carries an import map pointing at
`node_modules`. If you use a bundler (Vite, esbuild, webpack), it resolves the
import instead and the import map is unnecessary.

TypeScript consumers get complete types for everything here;
[`types.check.ts`](types.check.ts) is the same application written in
TypeScript, and the repository type-checks it against the published package on
every release.

## Checking the page before it runs

[`index.view.json`](index.view.json) states what the engine projects
(`count`, `resetDisabled`) and which events it accepts (`increment`, `reset`),
as plain JSON that an engine in any language can publish. The package checks
the HTML against it with no browser:

```js
import { checkPage, formatDiagnostic, parseViewContract } from "@echelon-foundry/limen/testing/views";

const parsed = parseViewContract(JSON.parse(await readFile("index.view.json", "utf8")));
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const problems = checkPage("index.html", await readFile("index.html", "utf8"), parsed.contract);
console.log(problems.map(formatDiagnostic).join("\n") || "index.html matches its contract");
```

Rename `data-text="count"` to `data-text="cuont"` and it reports the file,
the line, the element and the keys the contract does have — before anything
runs. `checkProjection` and `checkEvent` hold the engine to the same file.

## Where to go next

| Next | Where |
| --- | --- |
| The five-minute version of this, explained | [docs/quick-start.md](../../docs/quick-start.md) |
| Who owns what, and why | [docs/mental-model.md](../../docs/mental-model.md) |
| Where a given change belongs | [docs/where-code-goes.md](../../docs/where-code-goes.md) |
| Forms, fetch, storage, routing, clipboard | the numbered examples on GitHub |

Online: <https://github.com/kemiller2002/limen/tree/main/examples>
