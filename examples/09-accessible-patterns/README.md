# 09 — Accessible interaction patterns

Tabs, a menu button, a listbox, a combobox, a tree, a right-to-left grid and
a dialog. Each has full keyboard and focus behaviour, and **none of it is in
the kernel** (kemiller2002/limen#31, LCP-008).

| Piece | Owns |
| --- | --- |
| [`patterns.ts`](patterns.ts) | Each pattern as a pure state machine: `(state, key, direction) → state` |
| [`engine.ts`](engine.ts) | Every widget's state, the projection (**every ARIA state is a projected value**), and requests to move focus |
| [`index.html`](index.html) | Roles and structure. Keys are declared with `data-rich-*` (the events capability), focus targets with `data-focus-*` (the focus capability). |
| [`main.ts`](main.ts) | The kernel plus `focusCapability()` and `eventsCapability()` — nothing else |

What each pattern proves:

| Pattern | Keyboard | Focus | Disabled | Escape / cancel |
| --- | --- | --- | --- | --- |
| Tabs | ←/→ (reversed in RTL), Home, End; automatic activation | roving `tabindex`, one tab stop | skipped | — |
| Menu button | ↓/↑ open; ↓/↑ wrap, Home, End, Enter, Space | moves into the menu; returns to the button | skipped, and cannot be activated | closes and returns focus |
| Listbox | ↓/↑ clamp, Home, End, Enter, Space | stays on the listbox (`aria-activedescendant`) | skipped, and cannot be selected | — |
| Combobox | typing filters; ↓/↑, Enter | stays in the input (`aria-activedescendant`) | — | first closes the popup, then clears the text |
| Tree | ↓/↑ in visible order; →/← expand, enter, collapse, climb (reversed in RTL); Home, End | roving `tabindex` | — | — |
| Grid (`dir="rtl"`) | arrows (left/right reversed by the *computed* direction), Home, End, Ctrl+Home, Ctrl+End | roving `tabindex` | — | — |
| Dialog | Escape | enters on open (`focusFirst`); the background is `inert`; returns to the opener | — | cancels and returns focus |

**Right-to-left** comes from an explicit environment fact: the events
capability's `direction` fact group reports the element's computed text
direction. The pattern decides that ArrowLeft means "next" in RTL.

**Default actions** that must be decided synchronously are declared in the
HTML, not asked of the engine: an arrow key scrolling the page, or Space
scrolling the listbox. `data-rich-keys` lists exactly the keys a widget
handles, and `data-rich-prevent` prevents those and only those.

## Ownership

These patterns are **reference proofs**, not a pattern library. Reusable
interaction patterns are owned by the Forma project
([kemiller2002/forma](https://github.com/kemiller2002/forma)). This example
shows that Limen's generic mechanics are sufficient for them: semantic
events, projection, the events capability and the focus capability. It does
not define Forma's API. See [docs/37](../../docs/37-accessible-patterns.md).

## Tests

- [`test/patterns.test.ts`](../../test/patterns.test.ts) runs every pattern
  purely, then through the real kernel and both capabilities: ARIA projection,
  focus movement, and every projection checked against
  [`index.view.json`](index.view.json).
- [`checks.ts`](checks.ts) runs the same behaviour with real key presses in
  Chromium, under a strict CSP with Trusted Types (`npm run smoke:packs`,
  via `test/browser/packs/patterns/page.json`). It is loaded only with
  `?check`.
