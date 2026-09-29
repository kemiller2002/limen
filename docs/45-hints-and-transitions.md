# Resource hints and view transitions

> **Optional — not Limen Core.** This is resource hints and view transitions, a capability pack. It composes with the Core concepts `typed-capabilities` and `css-owns-presentation`: they are requested through the Capability seam and styled by CSS. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Browser-native loading and polish, with the decisions left to the engine
(kemiller2002/limen#34, LCP-025 and LCP-026).

```ts
import { presentationCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/presentation";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [presentationCapability()] }).start();
```

The contract is [`contract/presentation.contract.json`](../contract/presentation.contract.json),
with bindings for TypeScript, F#, C# and Rust.

## Resource hints

**Write static hints in the HTML.** A `<link rel="preconnect">` to your API,
or a `preload` for the font every page uses, is known when the page is
written, so it belongs in the page.

The pack is for hints only the engine can know: the next route the user is
about to open, or the module a workflow step will need.

```text
hint { kind: "preconnect" | "dns-prefetch" | "preload" | "modulepreload" | "prefetch", href, as?, crossOrigin }
  → Added | AlreadyPresent | InvalidUrl { scheme } | InvalidRequest | Unsupported
```

- **Idempotent.** A `<link>` with the same `rel` and the same *resolved*
  `href` answers `AlreadyPresent` and is not duplicated. That includes a link
  written in the static HTML, and the same URL written differently
  (`./page.css` and `/app/page.css`).
- `preload` needs `as`. Only `http(s)` and relative URLs are accepted; others
  are refused by scheme.
- A `rel` the browser does not support answers `Unsupported`, and nothing is
  added.
- The page's content security policy still governs what a hint may fetch.

Fetch priority and speculation rules are **not** included. The issue admits
them only as evidence-backed extensions of this same family, and there is no
measurement yet that calls for either.

## View transitions

A view transition must capture the old view before the new one is written.
The kernel applies a projection first and runs its effects after, so an
effect in the same response as the new view would be too late. The engine
therefore asks **first**:

```text
engine → prepareTransition { label: "open-detail", timeoutMs: 1000 }
pack   → Ready                  (the browser has captured the current view)
engine → its next projection is the new view
pack   → TransitionFinished { label, outcome: "finished" }
```

`outcome` is one of:

- `finished`: the transition ran;
- `skipped`: the browser skipped it, for example because the document was
  hidden;
- `timedOut`: the page did not change within `timeoutMs`, typically because
  the engine had not answered `Ready` in time. The transition ends without
  animating, and the page is never held.

While one transition waits for its projection, another answers `Busy`.

**The label is the engine's name for the transition; CSS decides what it
looks like.** It must be a lower-case CSS identifier. The pack exposes it in
two places:

- as the transition's **type**, where the browser supports transition types:
  `:active-view-transition-type(open-detail)`;
- always, as `data-view-transition="open-detail"` on the root element, for as
  long as the transition runs.

```css
:root[data-view-transition="open-detail"]::view-transition-new(root) { animation: slide-in 200ms; }
@media (prefers-reduced-motion: reduce) { ::view-transition-group(*) { animation: none; } }
```

**Reduced motion stays CSS.** The pack never reads a motion, contrast or
colour-scheme preference. The browser smoke counts `matchMedia` calls and
requires zero.

**Unsupported browsers render normally.** Without the API, `prepareTransition`
answers `Unsupported`. The engine then projects the new view as it always
would; nothing depends on the animation.

The kernel rewrites bound text on every projection (see WI-0043 in
[27](27-performance-baseline.md)). So any answer from the engine, even the
same view, ends the wait. A transition therefore wraps exactly the engine's
answer to `Ready`.

## Optional

Nothing in Core imports the pack. `kernel-with-presentation` has its own
payload budget.

| Evidence | Where |
| --- | --- |
| Unsupported fallback; Ready then completion on the next change; the root label present only during a transition; Busy; transition types passed where supported; timedOut and skipped; idempotent hints, including against the static HTML; scheme and `as` refusals; an unsupported `rel`; conformance suite | [`test/presentation.test.ts`](../test/presentation.test.ts) |
| In Chromium under a strict CSP with Trusted Types: hints added once (a static one and a differently written URL answer AlreadyPresent); a real view transition around the engine's projection, finishing under its label; Busy; a slow engine ending as timedOut; zero preference reads | [`test/browser/packs/presentation/`](../test/browser/packs/presentation/), `npm run smoke:packs` |
