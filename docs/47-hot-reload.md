# State-safe hot reload

A fast edit loop that never invents application state
(kemiller2002/limen#36, LCP-030).

Hot reload usually goes wrong in one of two ways. It silently keeps state that
the new code no longer understands. Or it keeps a hidden copy of state in the
browser that disagrees with the engine. Limen's edit loop avoids both:

- the **engine** produces and consumes its own versioned snapshot;
- the browser side only carries that snapshot across;
- **one pure function** decides what happens for each change.

```bash
npm run dev -- examples/01-counter 4180   # serves the directory; streams changes
```

```ts
import { createHotReloader, connectDevEvents } from "@echelon-foundry/typescript-wasm-kernel/tooling/hot-reload";

const reloader = await createHotReloader({
  document,
  engine,                                             // { snapshotVersion, create(restored) }
  kernel: (transport) => new BrowserKernel(transport, document, diagnostics, options),
  loadEngine: (path) => import(`${path}?t=${Date.now()}`).then((module) => module.engine),
  loadPage: async (path) => /* the changed page's <body> nodes */,
  reload: () => location.reload(),
  currentPage: location.pathname,
});
connectDevEvents(document, "/__limen/dev/events", (change) => { void reloader.apply(change); });
```

This is development tooling only. Nothing in Core, and nothing on the default
package path, imports it.

## The policy

`planReload(change, facts)` is pure and tested on its own:

| Change | Plan | What happens |
| --- | --- | --- |
| a stylesheet the page links | `swapStylesheet` | The new stylesheet loads next to the old one, then the old one is removed, so the page is never unstyled. No DOM node, kernel or engine is touched. |
| a stylesheet the page does not link | `fullReload` | |
| the open page's HTML | `remount` | The engine's snapshot is taken, the kernel is disposed, the new page's body replaces the old, and a fresh kernel starts the **same engine** from its snapshot. |
| another page | `fullReload` | |
| the engine, with **exactly the same** `snapshotVersion` | `restoreEngine` | The new engine is created from the old one's snapshot. |
| the engine, with a different version | `resetEngine { incompatible }` | The new engine starts fresh, and the old snapshot is never offered to it. |
| an engine without a `snapshotVersion` | `resetEngine { no-snapshot }` | |
| anything else | `fullReload` | |

**Compatibility is never guessed.** `3` and `3.1` are different versions. An
engine that wants state to survive a change keeps its `snapshotVersion`, and
bumps it whenever the snapshot's meaning changes. Snapshot and restore are
engine code, so an F#, C# or Rust engine exposes them from its own module.

Every restart uses the kernel's `dispose()`
([03](03-kernel-lifecycle.md#status-and-shutdown)), so the old kernel's
listeners are gone and one click is one event.

## The dev server

`scripts/dev-server.ts` serves a directory and streams file changes as
Server-Sent Events, one `{ kind, path }` per message:

- `.css` → `css`, `.html` → `html`, `.js`/`.mjs`/`.wasm` → `engine`, anything
  else → `other`;
- repeated writes of one file within 50 ms are one message;
- `node_modules`, `.git`, `bin` and `obj` are ignored.

## Limits

- **Remounting needs to parse HTML.** Under enforced Trusted Types (as the
  smoke pages run), `DOMParser` needs a policy. A development page therefore
  either runs without Trusted Types enforcement, or defines a policy for the
  dev server's own origin. The Chromium smoke proves the stylesheet swap and
  engine replacement under the strict policy. `test/hot-reload.test.ts`
  proves remounting in jsdom.
- A module's old code stays in the browser's module map after a
  cache-busting import. That is harmless for a development session, and it is
  why a full reload is always available.

| Evidence | Where |
| --- | --- |
| The plan, case by case; CSS swap with the same DOM, kernel and engine; HTML remount continuing from the snapshot, with one click being one event; compatible restore; incompatible and missing-version reset; unknown changes reloading; the real dev server serving files and streaming a real file write | [`test/hot-reload.test.ts`](../test/hot-reload.test.ts) |
| In Chromium under a strict CSP with Trusted Types: a real stylesheet load swapped in place with the page, DOM and state intact; compatible restore and incompatible reset on fresh kernels; no page reload | [`test/browser/packs/core-hot-reload/`](../test/browser/packs/core-hot-reload/), `npm run smoke:packs` |
