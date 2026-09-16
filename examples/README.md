# Examples

Six progressive examples plus an interactive primitives showcase. Every numbered
example is executed by the test suite
([`test/examples.test.ts`](../test/examples.test.ts)) against its **own real
`index.html`**, so none of them can silently stop working.

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
| Kitchen sink | <http://localhost:4173/examples/kitchen-sink.html> |

Examples 03, 04, and 06 call endpoints that do not exist without a backend.
That is deliberate — they demonstrate the typed failure states. The kitchen sink
fakes its own `fetch`, so it needs no server.

## Structure

Every numbered example has the same three files, and nothing else:

| File | Responsibility | Touches the browser? |
| --- | --- | --- |
| `index.html` | structure + `data-*` bindings | it *is* the browser |
| `engine.ts` | state, transitions, validation, projection, transport | **never** |
| `main.ts` | construct the kernel and start it | yes — the entry point |

Shared presentation lives in [`examples.css`](examples.css). Nothing in it is
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
| **05-multi-screen** | Screens as ordinary state. `data-each` navigation carrying item keys, shared vs. screen-local lifetimes, engine-side filtering. (No URL/history — not supported.) |
| **06-time-entries** | A realistic feature assembled only from the above: load on startup, validate, add, mark processed, refresh. A failed refresh keeps the list; a failed initial load does not. |

## Deliberately absent

These examples show no clever abstraction, no shared base class, and no helper
library. Each is self-contained, and the repetition between them is the lesson:
every one shows the real protocol in full. If a shared helper appeared here, it
would be the beginning of the second framework
[13-anti-patterns.md](../docs/13-anti-patterns.md) warns about.

## Related

- [Documentation index](../docs/README.md)
- [Getting started](../docs/02-getting-started.md) — build one from scratch
- [Recipes](../docs/15-recipes.md) — task-by-task instructions
