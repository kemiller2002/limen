# Localization semantics

The language-neutral definition of engine-side localization
(kemiller2002/limen#35, LCP-028). [`localization.vectors.json`](localization.vectors.json)
is the same definition as data. A library in any language conforms when every
case produces the stated result exactly.

Every function is pure. The browser facts it needs (the user's languages, and
the CLDR plural category for a number) come from the environment pack
([46](../../docs/46-environment-and-formatting.md)). Nothing here reads a
browser, and nothing here formats numbers or dates; that is the pack's
`format`.

## Tags

Tags are compared case-insensitively. Results use the casing the application
listed as available.

## Negotiation

`negotiate(available, preferred, fallback)` picks one available locale by
**lookup** (RFC 4647 §3.4):

1. For each preferred tag, in order, try it.
2. Then drop its last subtag, repeatedly (`zh-Hant-TW` → `zh-Hant` → `zh`).
   A single-letter subtag is dropped together with the subtag after it.
3. The first available match wins.
4. If none matches, `fallback`.

It never picks a more specific tag than the user asked for (`en` does not
choose `en-GB`).

## Direction

`direction(tag)` is `rtl` when the tag's script subtag is a right-to-left
script: `Arab`, `Hebr`, `Thaa`, `Syrc`, `Nkoo`, `Adlm` or `Rohg`. Otherwise it
is `ltr` when a script subtag is present. Without one, it is `rtl` when the
language is one of `ar`, `he`, `iw`, `fa`, `ur`, `ps`, `dv`, `yi`, `ckb`,
`sd` or `ug`, and `ltr` otherwise.

The document's actual direction is a separate fact, and the environment pack
reports it. This function is for choosing the direction to project for
content in a given locale.

## Messages

A catalogue maps a locale to messages. A message is one of:

- `text`: a template;
- `plural`: a template per CLDR category (`zero`, `one`, `two`, `few`,
  `many`, `other`).

`message(catalogues, chain, id, args, category?)`:

1. **Finds** the message in the first locale of `chain` that has it. The
   chain is typically the negotiated locale, then its truncations, then the
   fallback.
2. **Selects** for `plural`: the template for `category`, else `other`. A
   plural message asked for without a category uses `other`.
3. **Fills** each `{name}` with `args[name]`. `{{` and `}}` are literal
   braces. A placeholder with no argument stays as written (`{name}`) and is
   reported in `missing`.

The result is `found { locale, text, missing }`, or `notFound { id }` when no
locale in the chain has the message. The engine decides what a missing
message shows; the library never invents text.

`chain(locale, fallback)` is the locale, its truncations as above, then
`fallback`, without duplicates.
