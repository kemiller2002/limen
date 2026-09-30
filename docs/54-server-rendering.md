# Server and static rendering

> **Optional — not Limen Core.** This is the server and static renderer, an optional renderer. It composes with the Core concepts `engine-owns-meaning` and `projection-output`: the same engine produces the same projection, and the renderer writes it into HTML instead of a live DOM. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Render a route to semantic HTML on a server or at build time, from the same
engine and the same page the browser uses (kemiller2002/limen#38, LCP-022).
The application chooses per route: client rendering only (the default), static
generation (SSG), or rendering on request (SSR).

```ts
import { renderRoute, renderStatic } from "@echelon-foundry/typescript-wasm-kernel/renderer";

const { html, settled, refused } = await renderRoute({
  page,                        // the page's template HTML: the same file the browser loads
  engine: createEngine(),      // any EngineTransport; a new instance per render
  url: "https://shop.example/items/kettle",
  fetch: serverFetch,          // optional: without it, Http is not offered
});
```

`renderStatic(routes, { page, origin, engine: () => createEngine(), fetch })`
renders a list of routes and returns path → result. Writing the files is
yours.

## What happens

1. **The engine starts at the request's location.** `Initialize` carries the
   URL's origin, path and query. The fragment never reaches a server, so it is
   empty. It also carries the handshake, as in a browser.
2. **Only Http is offered, and only if you supplied a fetch.** The server
   offers no optional capability at all. An engine that selects one anyway is
   refused with `RenderRefused`, never half-rendered.
3. **Effects run until the engine stops asking,** within `maxRounds`
   (default 8) and `timeoutMs` (default 5000). If a budget runs out, the page
   shows the last projection and `settled` is `false`.
4. **The settled projection is written into the page, head included.** The
   binding rules are the kernel's own (`src/kernel/binding-policy.ts`):
   - an unsafe URL is not written, and is reported in `refusals`;
   - a forbidden binding throws `ProjectionError`, with the kernel's message.

The server's engine instance lives for one render and is then discarded. The
browser's engine starts from the same location and owns everything after. There
is no second authority, and the renderer never imports `BrowserKernel`
(`test/renderer.test.ts` checks its module graph).

## Browser-only capabilities on the server

| Request | Server answer |
| --- | --- |
| `Http` | performed through your fetch, with the kernel's outcome rules: a timeout is `OutcomeUnknown`, and so is a thrown write (`connection-lost` from protocol 1.4); a thrown read is `Failure{network}`. Without a fetch, `Failure{network}`. |
| `Storage`, `Clipboard`, `Navigation` | `Failure{unavailable}` |
| any optional `Capability` | `Unsupported{not-negotiated}` |

Every refusal is also listed in the result's `refused`. The engine decides
what to show instead, exactly as it would for an unavailable capability in a
browser. The fixture engine treats missing Storage as "no recently viewed
items".

## Browser-only sections

Mark an element `data-client-only`, and it is written exactly as authored:
unbound, with its content as the fallback until the page runs. Nothing on the
server ever reads a browser global.

## Output for the browser

The renderer adds two attributes for hydration (kemiller2002/limen#39) to adopt:

- a mounted `data-if` root carries `data-limen-if="<key>"`;
- each `data-each` row carries `data-limen-key="<key>"`.

The `<template>` elements stay, inert, so the kernel can still mount and
unmount in the browser.

Static output reads without JavaScript. In Chromium, a page that is
`renderRoute`'s output — no Limen code runs on it — shows the route's title,
description, canonical link, data rows and links, and the client-only
fallback (`npm run smoke:packs`, page `renderer`).

## The template reader

The renderer is not an HTML5 parser, and does not pretend to be one. It reads
the pages you author for Limen strictly:

- elements are closed explicitly, apart from void elements;
- `<script>`, `<style>`, `<textarea>` and `<title>` hold raw text;
- anything ambiguous is a `TemplateError` naming the line — never a guess.

Output is deterministic: attribute order and whitespace are kept, and text is
escaped.

## Not built

- **Streaming output.** No measured use case yet, as #38 requires before
  building it.
- **Hydration.** Adopting rendered markup without recreating it, and replaying
  early events, is #39. Adoption needs the kernel to take a marked element
  instead of cloning its template. The owner approved that Core change on
  2026-09-29 (CA-0002, `architecture/core-admissions/CA-0002.json`), but it
  is not built yet. Until it is, start the kernel on a page built for the
  client, not on renderer output: the kernel would mount its own copy beside
  every rendered section.

## Size

The `renderer` profile in `bench/budgets.json` is 16.6 KB gzip bundled. It
runs on a server or at build time and is never loaded by a page.
