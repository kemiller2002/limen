# Binding security

What a projection may write, where, and how that is proven
(kemiller2002/limen#18, LCP-027).

The split that drives every rule below: **the HTML author chooses a binding's
target; the engine supplies its value**, and that value is often user data.
So a target no value could ever make safe is refused once, when the page
starts. A value is checked on every projection only where the target is safe
for some values and not others (URLs).

The policy lives in one Core module,
[`src/kernel/binding-policy.ts`](../src/kernel/binding-policy.ts). The kernel
applies it at runtime, and the static view checker
([28-view-contracts.md](28-view-contracts.md)) reports the same refusals
before a page runs. It is Core, not a capability pack, because `data-text`
and `data-bind-*` are Core primitives: a primitive's safety cannot be
optional.

## The rules

| Binding | Rule | When | On violation |
| --- | --- | --- | --- |
| `data-text` | always `textContent`: markup in a value is text, never parsed | every projection | — |
| `data-bind-on*` (any event handler) | never a target: projected text would run as script | page start | `BridgeError` phase `binding`; the kernel does not run |
| `data-bind-style` | never a target: inline style is appearance; bind a class or `data-*` and style it in CSS | page start | same |
| `data-bind-srcdoc`, `-srcset`, `-imagesrcset`, `-ping`, `-is`, `-http-equiv`, `-attributename` | never targets (a document from a string; URL lists; a request per click; a different constructor; page policy; attribute rewriting) | page start | same |
| any `data-text` / `data-bind-*` on `<script>`, `<style>`, `<iframe>`, `<frame>`, `<object>`, `<embed>`, `<applet>`, `<base>`, `<meta>`, `<link>`, SVG `<set>`, `<animate>`, `<animateMotion>`, `<animateTransform>` | refused: these load, run or restyle code, or rewrite other attributes. An empty `<script>` given text later **executes** it. | page start, including `<template>` content | same |
| URL attributes: `href`, `xlink:href`, `src`, `action`, `formaction`, `poster`, `cite`, `background`, `data`, `codebase`, `manifest`, `longdesc`, `lowsrc`, `dynsrc` | written only when the value, resolved as the browser resolves it, is `http:`, `https:`, `mailto:`, `tel:` or relative | every projection | the attribute is **removed** (so no stale safe URL lingers), and a `BridgeError` phase `projection` names the element, attribute and scheme — **never the value** — while the rest of the projection still applies |
| `disabled`, `checked`, `selected`, `hidden`, `open` | set as properties with `Boolean()` | every projection | — |
| `inert`, `required`, `readonly`, `multiple`, `autofocus`, `novalidate`, `formnovalidate`, `autoplay`, `controls`, `loop`, `muted`, `playsinline`, `default`, `reversed`, `ismap`, `itemscope`, `allowfullscreen` | toggled by presence (`toggleAttribute`), because any value — the string `"false"` included — turns a boolean attribute on | every projection | — |
| `value` | set as the property, skipped if unchanged | every projection | — |
| anything else (`title`, `aria-*`, `data-*`, `class`, `alt`, …) | `setAttribute(name, String(value))` | every projection | — |

"Resolved as the browser resolves it" matters: browsers strip tabs and
newlines anywhere in a URL, and leading control characters and spaces, before
they read the scheme. So `java\tscript:`, `" javascript:"` and
`"\u0001javascript:"` are all `javascript:`. The kernel resolves with the URL
parser against the document's base URL, then reads the scheme it gets.

A page with a refused target does not run at all, and the engine receives no
`Initialize`. Failing closed at start is deliberate. A binding that could
never be safe is a mistake in the page, not a runtime condition, and the
static checker reports it before deployment.

### Schemes outside the list

`data:`, `blob:` and every other scheme are refused, including for images. An
application that must show a picked file or generated content needs a
capability pack that owns that resource and its lifetime (see
[24](24-contract-and-capabilities.md), opaque handles). A binding is not a
back door for it.

## Diagnostics never carry secrets

A diagnostic describes what the bridge did, never the application's data:

- **Http effects:** no URL query, header or body, and no text from `fetch`'s
  own errors, which some implementations fill with the request.
- **Clipboard:** no clipboard text.
- **Projections:** no view value, and a refused URL is named by its scheme
  only.

[`test/binding-security.test.ts`](../test/binding-security.test.ts) runs every
failure path with marked secrets and a hostile `fetch` whose errors echo the
request, and asserts that no secret appears in any diagnostic.
[`src/tooling/trace.ts`](../src/tooling/trace.ts) redacts exported traces the
same way ([26](26-fake-host-trace-replay.md)).

## Strict CSP and Trusted Types

The kernel uses no HTML-string sink (`innerHTML`, `outerHTML`,
`insertAdjacentHTML`, `document.write`), no `eval` or `Function`, no inline
script or style, and no event-handler attribute. So it runs under the
strictest practical policy, with Trusted Types enforced and **no policy
defined**:

```text
default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self';
style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none';
object-src 'none'; require-trusted-types-for 'script'; trusted-types 'none'
```

`npm run smoke:security`
([`scripts/smoke-security.ts`](../scripts/smoke-security.ts)) proves it in
Chromium, in two parts.

**The kernel page.** The smoke page
([`test/browser/security/`](../test/browser/security/)) is served under that
policy.

1. An `innerHTML` probe must throw first, so Trusted Types is known to be
   enforced and nothing below can pass vacuously.
2. The engine projects script and markup payloads into text, rotating
   `javascript:`, mixed-case, tab-split, space-prefixed, `data:` and
   `vbscript:` URLs into links, an image and list rows.

The smoke then checks all of the following:

- zero policy violations;
- no uncaught errors;
- no payload ran;
- no unsafe URL was written;
- safe URLs were written;
- every refusal was reported without its value;
- clicking a neutralized link goes nowhere.

**The guest engines.** When `dist-guests/` is built, the F#, C# and Rust
WebAssembly guests run under the same policy plus `'wasm-unsafe-eval'`, which
compiling WebAssembly requires; it permits no JavaScript `eval`. Each guest
must negotiate the handshake, complete an effect round trip and cause zero
violations. All three do: the .NET runtime and the raw WebAssembly host both
run under enforced Trusted Types with no policy.

Two findings from building the smoke:

- The guest host page's inline `<style>` violated `style-src 'self'`; it is
  now [`host.css`](../guests/minimal/host/host.css).
- Playwright's `waitForFunction` with a string predicate evaluates it with
  `eval` *inside the page*. Trusted Types blocks that, which looks like the
  page failing. The smoke polls with `page.evaluate`, which the page's policy
  does not govern, so the harness adds no violation of its own.

## Third-party adapters are trust boundaries

Everything above constrains what **Core** writes. A host adapter, a capability
pack or an optional renderer runs with the page's full authority. For
example, a pack that renders a third-party widget, embeds an `<iframe>`, or
turns a handle into an object URL is making a trust decision the kernel
cannot check for it. Such code must:

- live outside Core, in its own layer
  ([`architecture/layers.json`](../architecture/layers.json));
- state what it trusts, in its own documentation and contract;
- be explicitly registered by the application (`KernelOptions.capabilities`),
  never loaded implicitly;
- keep its own diagnostics free of application data, as Core does.

Registering an adapter is the application's decision to extend trust. The
kernel's guarantees do not transfer to what the adapter does.
