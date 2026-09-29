# Rich event facts

Keyboard, pointer, drag-and-drop, composition, selection and input facts,
without DOM Event objects (kemiller2002/limen#29, LCP-020).

The simple path stays simple. `data-event` still sends `SemanticEvent
{ name, key?, value? }` (plus 1.2's form-control state), and nothing about it
changed. Richer facts come from an optional capability pack, through its own
attributes. **Each listener opts into exactly the facts it needs**, so a
high-volume event carries nothing it did not ask for.

```ts
import { eventsCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/events";
await new BrowserKernel(transport, document, diagnostics, { capabilities: [eventsCapability()] }).start();
```

```html
<textarea data-rich-event="shortcut" data-rich-on="keydown"
          data-rich-facts="keyboard modifiers" data-rich-keys="Enter Escape" data-rich-prevent></textarea>

<div data-rich-event="canvasDrag" data-rich-on="pointerdown pointermove pointerup"
     data-rich-facts="pointer coordinates" data-rich-coalesce="frame" data-rich-pointer-capture></div>
```

## The declaration

Everything the browser must decide **synchronously** is declared in HTML. The
engine is never asked a question it would have to answer before the event
handler returns.

| Attribute | Meaning |
| --- | --- |
| `data-rich-event="name"` | the fact's name (required) |
| `data-rich-on="type …"` | one or more DOM event types sharing these settings (required) |
| `data-rich-facts="…"` | the groups to include: `keyboard`, `modifiers`, `pointer`, `coordinates`, `drag`, `composition`, `selection`, `input`, `value` |
| `data-rich-keys="Enter Escape"` | only these `key` values count; others are ignored entirely, neither reported nor prevented |
| `data-rich-prevent` / `data-rich-stop` | `preventDefault()` / `stopPropagation()`, applied mechanically to every counted event |
| `data-rich-capture` / `data-rich-passive` / `data-rich-once` | the listener options of the same names. Passive together with prevent is refused. |
| `data-rich-pointer-capture` | on `pointerdown`, capture the pointer to this element, so the drag keeps reporting when the pointer leaves it |
| `data-rich-coalesce="frame"` | continuous streams (moves, `dragover`, `scroll`, `wheel`) send at most their latest fact per frame. Discrete events are never delayed, and they flush the moves before them, so order is preserved. |
| `data-bind-data-rich-key="id"` on a row | the fact carries that row's key, projected by the engine |

A declaration the browser could not honour is not bound. The pack's
`describe` request lists every declaration and why any was refused.

## Facts

Each fact is a `RichEvent { name, type, key?, value?, modifiers?, keyboard?,
pointer?, drag?, composition?, selection?, input? }`, delivered as a
capability fact and decoded with the generated decoder. It is plain JSON by
construction.

- **keyboard:** `key`, `code`, `repeat`, `composing`. The pack interprets no
  shortcut; the engine decides what Ctrl+Shift+Enter means.
- **pointer:** `pointerType`, `pointerId`, `button`, `buttons`, `isPrimary`,
  and `x`/`y` only when `coordinates` is requested. The pack interprets no
  gesture.
- **drag:** `phase` (`start`, `enter`, `over`, `leave`, `drop`, `end`), the
  dragged `types`, and `fileCount`. Contents are never read; reading a
  dropped file is a file capability's job.
- **composition:** `phase`. `committed` is present only at `end`.
- **input:** `inputType`, and `data` only when not composing.
- **selection:** a text control's `start`, `end` and `direction`.

## IME composition

Text an input method is still composing is not the user's yet, and no part
of Limen reports it:

- the simple path's `data-on="input"` skips composing `input` events and
  reports the committed value at `compositionend`;
- the pack withholds `input` facts during composition unless the listener
  asked for `composition`, and reports composed text only as `committed` at
  the end.

Both rules are proven with a real IME, through the DevTools protocol, in
Chromium.

## Evidence

| What | Where |
| --- | --- |
| Keyboard modifiers and key filtering with prevent; opt-in shaping; IME; coalescing that never reorders; row keys, template-mounted listeners and `once`; refused declarations; the simple path unchanged; conformance | [`test/events.test.ts`](../test/events.test.ts), [`test/ime.test.ts`](../test/ime.test.ts) |
| Real key presses (a prevented Enter inserts no newline), a pointer drag with capture outside the element, native drag and drop, and real IME composition on both paths, in Chromium under a strict CSP with Trusted Types | [`test/browser/packs/events/`](../test/browser/packs/events/), `npm run smoke:packs` |

`scripts/smoke-packs.ts` performs the trusted input a page asks for: key
presses, pointer drags, drag and drop, and IME composition. Any pack whose
facts only real input produces can be proven the same way.
