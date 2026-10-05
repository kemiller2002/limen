# Environment evidence and formatting

> **Optional — not Limen Core.** This is environment evidence and formatting, a capability pack and engine library. It composes with the Core concept `semantic-input`: locale and time zone arrive as evidence the engine formats with. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Locale, time zone and direction as explicit evidence, and correct formatting
in every engine language (kemiller2002/limen#35, LCP-028).

An engine that reads `navigator.language` or relies on its runtime's default
time zone cannot be tested for a user in Rome while running in Los Angeles.
It also cannot run as F#, C# or Rust at all. So the engine asks for these
facts:

```ts
import { environmentCapability } from "@echelon-foundry/limen/capabilities/environment";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [environmentCapability()] }).start();
```

The contract is [`contract/environment.contract.json`](../contract/environment.contract.json),
with bindings for TypeScript, F#, C# and Rust.

| Request | Answer |
| --- | --- |
| `describe { preferences }` | `Described { environment: { locale, languages, timeZone, direction, preferences } }` |
| `watch { preferences }` | `Watching { environment }`, then `EnvironmentChanged { environment }` facts until `unwatch` |
| `format { locale, timeZone, items }` | `Formatted { texts }`, or `InvalidRequest { problem, item? }` naming the failing item |

## The facts

| Fact | Where it comes from |
| --- | --- |
| `locale`, `languages` | the user's language preferences, as BCP 47 tags |
| `timeZone` | an IANA name: the browser's own |
| `direction` | the document's direction (`dir` on the root, else its computed direction). RTL is explicit, never inferred by the engine from a language tag. |
| `preferences` | **only those named**: `reducedMotion`, `colorScheme`, `contrast`, `forcedColors`, each with the media value it matches |

Presentation preferences stay CSS. `@media (prefers-reduced-motion)` is the
right place to turn animation off. The engine asks for a preference only
when its *behaviour* depends on it, for example skipping an auto-advancing
carousel.

A change of language preference, or of a watched preference, arrives as
`EnvironmentChanged`, and only when something actually changed.

## Formatting, for facts the engine states

`format` uses the browser's `Intl` for the **locale and time zone the request
names**, never the machine's defaults:

- `number`: decimal, percent or currency;
- `date`: an instant, with date and time styles;
- `relative`: "yesterday";
- `list`: "a, b, and c";
- `plural`: the CLDR category an engine's message catalogue selects on.

Engines in F#, C# and Rust get correct formatting without shipping CLDR data
of their own.

**Deterministic per browser version, not across them.** The same request
gives the same text in the same browser. Browsers and runtimes ship different
CLDR data, though. Chromium formats 1234.50 EUR for `it-IT` as `1.234,50 €`,
and Node's ICU as `1234,50 €`. The tests pin each. An engine that must
produce byte-identical text everywhere (an invoice, say) formats with its own
pinned data instead.

## A fake host fixes the environment

`environmentCapability({ source })` takes the facts from anything. A test
fixes the locale and time zone, and changes them, and the engine cannot tell
the difference. `test/environment.test.ts` drives an engine through the real
kernel with an Italian fake host and checks that it renders `9,50 €`.

## Engine-side localization

Choosing a locale, a message and its text is application meaning. The
semantics are defined once, in any language, in
[`conformance/localization/`](../conformance/localization/README.md): 34
cases. [`libraries/fsharp/Limen.Localization`](../libraries/fsharp/Limen.Localization/Localization.fs)
is the F# reference.

- **`negotiate(available, preferred, fallback)`**: RFC 4647 lookup over the
  user's `languages` fact, never more specific than asked.
- **`direction(tag)`**: `rtl` for right-to-left scripts and languages, for
  content in a given locale.
- **`chain(locale, fallback)`** and
  **`render(catalogues, chain, id, args, category?)`**:
  - message lookup falls back along the chain;
  - `{name}` placeholders are filled, with `{{`/`}}` as literal braces;
  - plural templates are selected by the CLDR category the pack's `plural`
    item returns;
  - a missing argument is reported, never invented, and a missing message
    is `notFound`.

A mutation check confirmed the vectors bite: disabling RFC 4647's
singleton rule fails a `chain` case.

## Optional

Nothing in Core imports the pack. `kernel-with-environment` has its own
payload budget.

| Evidence | Where |
| --- | --- |
| en-US vs it-IT; the same instant on different days in Los Angeles and Tokyo; invalid locale, time zone and currency (with the failing item); RTL from `dir`; a fake host with a fixed locale and time zone; preferences only when named; a locale change as one fact per real change and none after unwatch; a real `languagechange` event; the engine formatting through the kernel; conformance suite | [`test/environment.test.ts`](../test/environment.test.ts) |
| Engine-side localization: 34 language-neutral cases (negotiation, chains, direction, messages, plurals, placeholders), run against the F# reference in `npm run test:libraries` | [`conformance/localization/`](../conformance/localization/) |
| In Chromium under a strict CSP with Trusted Types: real navigator, `Intl` and direction facts; a real media preference; Chromium's own `Intl` for en-US, it-IT and ar-EG; a `languagechange` with no change is not reported | [`test/browser/packs/environment/`](../test/browser/packs/environment/), `npm run smoke:packs` |
