# Examples

> **Reading this inside `node_modules`?** Only
> [`minimal/`](minimal/README.md) ships in the npm package — it is a complete
> four-file application with no build step. Every other example below lives
> online, and the links go there.

Eight progressive examples, a copy-and-run minimal application, and an
interactive primitives showcase. Every numbered example is executed by the test
suite ([`test/examples.test.ts`](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/test/examples.test.ts)) against its **own
real `index.html`**, so none of them can silently stop working.

Every example has its own README explaining what it demonstrates, its state
model, its event and effect flow, what to change as an exercise, and the
mistakes people actually make with it.

**Start at [01-counter](https://github.com/kemiller2002/typescript-wasm-kernel/tree/main/examples/01-counter).** If you only have five minutes, read
[docs/quick-start.md](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/quick-start.md) instead.

## Running them

```sh
npm install
npm run build            # the kernel → dist/
npm run build:examples   # the examples → *.js next to their .ts sources
python3 -m http.server 4173
```

| Example | URL |
| --- | --- |
| Counter | <http://localhost:4173/examples/01-counter/> |
| Form | <http://localhost:4173/examples/02-form/> |
| Fetch data | <http://localhost:4173/examples/03-fetch-data/> |
| Save data | <http://localhost:4173/examples/04-save-data/> |
| Multi-screen | <http://localhost:4173/examples/05-multi-screen/> |
| Time entries | <http://localhost:4173/examples/06-time-entries/> |
| Clipboard | <http://localhost:4173/examples/07-clipboard/> |
| Routing | <http://localhost:4173/examples/08-routing/> |
| Kitchen sink | <http://localhost:4173/examples/kitchen-sink.html> |

[`minimal/`](minimal/) is not in that list because it is not built from this
repository: it imports the kernel by its published package name and is the copy
shipped **inside the npm package**, so a consumer can read one whole working
application without cloning anything.

Example 07 needs a **secure context** for the clipboard; `localhost` counts as
one. Examples 03, 04, and 06 call endpoints that do not exist without a backend.
That is deliberate — they demonstrate the typed failure states. The kitchen sink
fakes its own `fetch`, so it needs no server.

## Structure

Every numbered example has the same three files, and nothing else:

| File | Responsibility | Touches the browser? |
| --- | --- | --- |
| `index.html` | structure + `data-*` bindings | it *is* the browser |
| `engine.ts` | state, transitions, validation, projection, transport | **never** |
| `main.ts` | construct the kernel and start it | yes — the entry point |

Shared presentation lives in [`examples.css`](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/examples.css). Nothing in it is
known to the kernel or the engine — that is the point.

Each `engine.ts` imports from the kernel **type-only**, so it has no runtime
dependency on the kernel at all. That is what lets the test suite import it
directly as TypeScript, and what would let it be ported to another language
without reproducing any kernel behavior.

## What each one adds

| Example | Introduces |
| --- | --- |
| **01-counter** | The whole mechanism in ~70 lines: `data-event` → transition → projection → `data-text`. Projects a capability (`resetDisabled`) rather than letting the DOM derive it. |
| **02-form** | Validation as pure functions; `data-on="input"`; `data-if` for messages; `data-bind-value`/`data-bind-disabled`; an illegal transition rejected explicitly. |
| **03-fetch-data** | The first external effect. Http request, `data-each` list rendering, all four `EffectOutcome` variants as distinct states, and a stale-result guard. |
| **04-save-data** | Full lifecycle `Restoring → Editing → Saving → Saved / SaveFailed / SaveOutcomeUnknown`. Storage effect for a local draft. Shows why a timed-out **POST** must not be retried — contrast 03's GET. |
| **05-multi-screen** | Screens as ordinary state. `data-each` navigation carrying item keys, shared vs. screen-local lifetimes, engine-side filtering. Deliberately **no URLs** — see 08 for when a screen has earned one. |
| **06-time-entries** | A realistic feature assembled only from the above: load on startup, validate, add, mark processed, refresh. A failed refresh keeps the list; a failed initial load does not. |
| **07-clipboard** | The `Clipboard` capability. Three distinct failure reasons, only one of which is worth offering a retry for. Waiting is a state. No `navigator` call appears anywhere in the engine — the architecture check would fail the build if it did. |
| **08-routing** | The `Navigation` capability. Typed routes, parse and format side by side, the initial screen taken from the address bar, and the asymmetry that matters: an application-initiated move pushes, a browser-initiated move adopts and pushes nothing. |
| **minimal** | The npm-shipped copy: four files, plain JavaScript, no build step, imported by package name exactly as a consumer would. |

## Deliberately absent

These examples show no clever abstraction, no shared base class, and no helper
library. Each is self-contained, and the repetition between them is the lesson:
every one shows the real protocol in full. If a shared helper appeared here, it
would be the beginning of the second framework
[13-anti-patterns.md](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/13-anti-patterns.md) warns about.

## Per-example guides

| Example | README |
| --- | --- |
| 01 | [Counter](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/01-counter/README.md) |
| 02 | [Input and form](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/02-form/README.md) |
| 03 | [Fetch data](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/03-fetch-data/README.md) |
| 04 | [Save data](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/04-save-data/README.md) |
| 05 | [Multi-screen](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/05-multi-screen/README.md) |
| 06 | [Time entries](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/06-time-entries/README.md) |
| 07 | [Clipboard](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/07-clipboard/README.md) |
| 08 | [Routing](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/examples/08-routing/README.md) |
| — | [Minimal (npm)](minimal/README.md) |

## Related

- [Documentation index](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/README.md)
- [Getting started](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/02-getting-started.md) — build one from scratch
- [Recipes](https://github.com/kemiller2002/typescript-wasm-kernel/blob/main/docs/15-recipes.md) — task-by-task instructions
