# Limen navigation and clipboard — implementation report

Work item: **WI-0015**. Branch: `claude/wasm-kernel-docs-audit-oyyntv`.

---

## 1. Baseline

| | |
| --- | --- |
| Repository | `kemiller2002/typescript-wasm-kernel` (Limen) |
| Branch | `claude/wasm-kernel-docs-audit-oyyntv` |
| Starting SHA | `6cc17de7641924b075379076c46f64e6b315a0da` |
| Working tree | clean |
| Limen version | 0.5.1 (published to npm) |
| Build | `npm run build` clean |
| Tests | **126 passed, 0 failed, 0 skipped** (TypeScript) · **104 passed, 0 skipped** (F#) |

No baseline tag was created. This repository does not use baseline tags, and
the sandbox cannot push tags at all (recorded in `CLAUDE.md`); the starting SHA
above serves the same purpose.

### SDE inputs read before editing

`.sde/README.md`, `method/CONSTRUCTION-METHOD.md`,
`method/CHANGE-CLASSIFICATION.md`, `method/FEATURE-MANIFESTS.md`,
`method/VERIFICATION-METHOD.md`, `method/AGENT-EXECUTION-RULES.md`,
`architecture/BOUNDARY-PRESERVATION.md`.

**Change classification.** Most sites here are **Boundary Changes** (the wire
contract between engine and kernel). The example and site engines' new
transitions are **Semantic Changes**. The `mode` → `operation` renames across
tests and docs are **Mechanical Propagation** — but per the method's own
warning, each one was verified behaviourally rather than assumed safe because
it compiled.

**Routing declaration.** There is **no `SDE-MAP.md`** in this repository, and
`method/FEATURE-MANIFESTS.md` says a nontrivial adopting repository MUST expose
one. `AGENTS.md` and `CLAUDE.md` serve as the de facto routing table and are
linked unambiguously from the README, which the method permits as an
alternative — but the permission is for "an existing architecture/index
document", and neither file is structured as a routing table. **Recorded as an
open item, not resolved here**: creating one is a separate piece of work and
inventing feature boundaries to fill it would be worse than leaving the gap
visible.

---

## 2. Findings from the audit

### The mission's F# premise does not match this repository

The mission describes an F# application making routing and clipboard
decisions. **In this repository the application engine is TypeScript**
(`src/engine/`, `site/app/`, `examples/*/engine.ts`). The only F# is the
lifecycle CLI under `cli/`, which is repository tooling and has nothing to do
with the browser boundary.

This is not treated as a contradiction, because the mission itself resolves it:
§24 says Limen must not know what `Chrona`, `Summa`, `Strata` or `TimeEntry`
mean, and §66 says application routing tables must not live in Limen core. This
repository **is** Limen core plus its examples. So the work done here is the
generic capability — protocol, kernel, contracts, tests — which an F# engine
consumes unchanged, because the contract is plain JSON-serializable data by
construction.

**What was deliberately not done:** no F# routing or clipboard code was added
to `cli/`. Putting browser routing into the lifecycle CLI would violate §66 and
this repository's own rule that `cli/` is a lifecycle tool, not an application.

### What existed before this work

| Area | State at baseline |
| --- | --- |
| Navigation | **A formal capability**, added hours earlier under WI-0014: `push`/`replace`, `popstate` → event, `Initialize.location`, cross-origin refusal. |
| Back / Forward as effects | **Absent.** Deliberately deferred in WI-0014 on the grounds that nothing had demonstrated the need. |
| Link interception | **Absent.** Same reason. |
| Clipboard | **Entirely absent.** Zero occurrences of `navigator.clipboard`, `writeText`, `readText`, or `execCommand` anywhere in the repository. |
| Raw `history` / `location` use in application code | **None.** Confirmed by search: every occurrence lives in `src/kernel/browser-kernel.ts`, `src/protocol.ts`, the two boundary checkers, the example engine's route table, and tests. |
| JavaScript route decisions | **None.** No JS inspects `pathname` and picks a screen anywhere. |
| Separate JS route state | **None.** |
| Site routing | **None needed** — see §6. |

The rework criteria in mission §62 were therefore **mostly not met**: there was
no split-brain to repair, no JS route authority to dismantle, and no direct
clipboard call to replace. Two criteria did apply: "lacks typed effect/result
handling" (for clipboard, which did not exist) and "cannot handle Back/Forward
correctly" (browser-initiated worked; engine-initiated was impossible).

### Defects and weaknesses found

**F-1 — The navigation effect was a flat record with a `mode` field.**
`{ kind: "Navigate", correlationId, mode: "push" | "replace", url }`. SDE
`architecture/BOUNDARY-PRESERVATION.md`'s Host Contract rule requires "effects
described by a closed algebra, one constructor per legal operation — not a flat
record with optional/nullable fields". Adding `back`/`forward` made the defect
concrete: they carry no `url`, so the record shape would have permitted
`{ operation: "back", url: "/somewhere" }` to be written down. **This was my
own design from the previous work item.** Reworked.

**F-2 — The architecture checker did not cover application code.**
`scripts/check-architecture.ts` scanned `src/engine` only. `site/app/engine.ts`
and all six `examples/*/engine.ts` files — which are application code, and which
a newcomer copies before they read anything — were **completely unchecked**. A
`navigator.clipboard` call or a `history.pushState` in any of them would have
passed CI.

**F-3 — The two boundary checkers disagreed.** The F# port strips comments and
string literals before matching; the TypeScript one matched raw text. This was
a known, documented divergence, survivable only while the checker looked at
four hand-curated files. Widening it per F-2 produced **seven findings in one
run, every one of them prose in a comment or a quiz string**. Under SDE this is
Uncoordinated Duplication: two implementations of one semantic decision with no
mechanism requiring agreement.

**F-4 — `examples/04-save-data` narrowed `EffectResult` by elimination.**
Found and fixed under WI-0014; the same pattern in `site/app/engine.ts` was
found and fixed here. "Anything that is not `HttpResult` is a `StorageResult`"
stopped being true at three variants and is now plainly wrong at four.

**F-5 — No capability could be discovered without reading the kernel.** There
was no single authoritative list of what an engine may request. Mission §45
requires one.

### Ambiguities recorded, not invented away

- **§22's "location event is authoritative" model cannot apply to
  `push`/`replace`**, because `pushState` does not fire `popstate` — that is a
  specification fact, not a design choice. Making it uniform would require the
  kernel to synthesize a location event after every push, which invites exactly
  the loop the model exists to prevent. The resolution, documented and tested,
  is one path per direction (§4 below).
- **No `SDE-MAP.md`** (above).
- **Clipboard gesture behaviour outside Chromium is unverified** (§7).

---

## 3. Decisions

| Question | Decision |
| --- | --- |
| Who owns route meaning | The **engine**, entirely. Parsing, formatting, legality, redirects. |
| Who owns the URL | The **browser**. Limen executes History API calls; it never decides what a URL means. |
| Where routes become URLs | In the **engine**, as late as possible — per SDE's "typed route → URL as late as possible". Limen receives a string it treats as opaque browser-bound data. |
| `push` vs `replace` | A **domain decision the engine makes**. Push for a move the user may want to come back from; replace for correcting or canonicalizing. Navigating to the current screen produces no effect at all. |
| `back` / `forward` | **Requests to the browser**, not edits. There is one history. The outcome is `Accepted`; the destination arrives afterwards as a history event. |
| Location event semantics | **Authoritative for browser-initiated movement only.** Engine-initiated pushes change engine state in the transition that requested them. |
| Clipboard scope | **Write only.** Read is omitted on the least-capability rule, with its shape recorded so adding it is a decision rather than a discovery. |
| Clipboard failure | A **modelled outcome** with four normalized reasons — never a browser exception string. |
| Link interception | **Opt-in**, and narrow. The kernel reports an intent; it never navigates and never decides what an href means. |
| Correlation IDs | **Reused, not invented.** Both capabilities use the existing `correlationId` on every effect. No new correlation machinery. |
| Document title | **Not implemented.** See §8. |

---

## 4. Changes

### Protocol (`src/protocol.ts`)

```ts
// Before
type NavigationEffectRequest = { kind: "Navigate"; correlationId; mode: "push" | "replace"; url: string };
type NavigationOutcome = { kind: "Success"; url } | { kind: "Failure"; reason };

// After — one member per legal operation
type NavigationEffectRequest =
  | { kind: "Navigate"; correlationId; operation: "push";    url: string }
  | { kind: "Navigate"; correlationId; operation: "replace"; url: string }
  | { kind: "Navigate"; correlationId; operation: "back" }
  | { kind: "Navigate"; correlationId; operation: "forward" };

type NavigationOutcome =
  | { kind: "Success"; url: string }   // push/replace — synchronous, so the URL is known
  | { kind: "Accepted" }               // back/forward — queued; the history event is authoritative
  | { kind: "Failure"; reason: "unavailable" | "cross-origin" | "invalid-url" };

// New
type ClipboardEffectRequest =
  | { kind: "Clipboard"; correlationId; operation: "writeText"; text: string };

type ClipboardOutcome =
  | { kind: "Success" }
  | { kind: "Failure"; reason: "permission-denied" | "not-secure-context" | "unsupported" | "failed" };

type Capability = "Http" | "Storage" | "Navigation" | "Clipboard";
```

`EffectRequest` and `EffectResult` each gained the clipboard member.

### Kernel (`src/kernel/browser-kernel.ts`)

- `runNavigation` handles `back`/`forward` via `history.back()`/`forward()`,
  returning `Accepted`.
- `runClipboard` performs `navigator.clipboard.writeText`, normalizing failures.
  The copied text is never read back, never logged, never returned.
- `enhanceableAnchor` decides link eligibility against eleven conditions, every
  one of which exists to *not* break native behaviour.
- The third constructor argument is now `DiagnosticsSink | BrowserKernelOptions`.
  Capabilities live in a named object rather than as a fourth and fifth
  positional argument.
- Capabilities are announced only when wired.

### Checkers

- `scripts/check-architecture.ts` now scans `src/engine`, `site/app` and every
  `examples/NN-*/` engine; strips comments and string literals before matching
  (**F-3** closed); and bans `navigator.clipboard` and `execCommand`.
- `cli/Limen.Core/Boundary.fs` gained the same two tokens, keeping the two
  implementations in lockstep.

### Applications

- `examples/05-multi-screen/` — the routing reference. Typed `Screen` routes, a
  pure `routeFor` parser returning `Screen | null`, a `urlFor` formatter, `push`
  on user navigation, `replace` on canonicalization, `back`/`forward` buttons, a
  real in-app link and a deliberately untouched external one.
- `site/app/engine.ts` — a `CopyState` machine driving the install command's
  Copy button, with a sentence per failure reason.
- `site/app/main.ts` — enables the clipboard capability. Deliberately does
  **not** enable navigation: the site is static pages.

### Documentation

New: `docs/23-clipboard.md`, `docs/24-navigation-and-github-pages.md`,
`docs/25-browser-capabilities.md` (the §45 discovery page).

Updated: `docs/07`, `docs/08`, `docs/11`, `docs/13` (five new anti-pattern
pairs), `docs/ROADMAP.md`, `docs/README.md`, `AGENTS.md` (rules 2 and 9–12),
`CLAUDE.md`, `site/pages/index.html`.

---

## 5. Compatibility

| API | Status |
| --- | --- |
| `new BrowserKernel(transport, document)` | **Unchanged.** |
| `new BrowserKernel(transport, document, sink)` | **Unchanged** — still means diagnostics. Tested explicitly. |
| `new BrowserKernel(transport, document, undefined, navigation)` | **Changed** → `{ navigation }` as the third argument. |
| `Navigate` effect `mode` field | **Renamed** to `operation`. |
| `capabilities` | Widened earlier to `readonly Capability[]`; gained two members. |
| `EffectResult` | Gained a fourth variant. |

**The two changed rows were introduced in PR #6 and have never been released.**
npm's latest is 0.5.1, which predates navigation entirely. No published
consumer can be affected, which is why they were reshaped now rather than
carried as a compatibility wrapper — the alternative is versioning a mistake
that nobody has yet depended on.

No compatibility wrappers were added, and none of the old names
(`navigate(path)`, `copy(text)`) exist in this repository to preserve.

A consumer on 0.5.1 upgrading past this point sees one type-level break: code
narrowing `EffectResult` by elimination stops compiling. That is the compiler
doing its job, is loud, and cannot fail silently. Recorded in
`docs/18-naming-and-compatibility.md`.

---

## 6. GitHub Pages

**The site needs no routing, and deliberately has none.**

`scripts/build-site.ts` emits one real HTML file per page at the output root
(`index.html`, `architecture.html`, `demos.html`, `docs.html`, `agents.html`,
`evidence.html`) with entirely relative links. Every URL is directly loadable,
bookmarkable and shareable because **it is a file that exists**. This is mission
§18's Option A, already in place before this work.

Deep links therefore work natively on GitHub Pages with no fallback, no
`404.html` trick, and no hash in any URL. The common SPA workaround — copying
`index.html` to `404.html` — was **rejected**: it serves every deep link with an
HTTP 404 status, which is bad for crawlers and monitoring and is a genuine lie
about what happened.

Converting the site to client-side routing would make its deep links *less*
reliable than they are now, and would contradict the architecture it exists to
document. It was not done.

**Example 05 uses hash routes** (`#/customers`) so it runs from any static file
server with no configuration. That is a property of the example, not a
recommendation; path routing is better wherever you can serve it, and swapping
is two pure functions. Documented so nobody mistakes the example for advice.

---

## 7. Verification

### Automated

| Suite | Result |
| --- | --- |
| `npm run check` | **145 passed, 0 failed, 0 skipped** (was 126) |
| `npm run test:cli` (F#) | **107 passed, 0 skipped** (was 104) |
| `npm run check:architecture` | passes, and **verified to fail** on a planted leak in each of the three newly covered roots |

New tests: 16 in `test/kernel.test.ts` (traversal, link eligibility across 13
cases, all five clipboard outcomes, capability announcement, the legacy
constructor shape), 4 in `test/examples.test.ts`, 3 in `test/site.test.ts`,
3 in `cli/tests/Limen.Core.Tests/BoundaryTests.fs`.

**Negative controls were run, not assumed.** The architecture checker was
verified to exit 1 on a planted `navigator.clipboard` call in `site/app/`, a
planted `history.pushState` in an example engine, and a planted
`location.reload()` in `src/engine/` — and to exit 0 when the same tokens
appear only in a comment.

### Real browser (Chromium 141, over CDP)

**24 checks, all passing.** jsdom cannot prove that a Ctrl-click still opens a
tab, that a history traversal is genuinely queued, or that
`navigator.clipboard` is reached at all.

Navigation: direct load, canonicalization, tab click, browser Back and Forward,
**engine-requested Back and Forward**, history length unchanged by a traversal,
deep link, refresh, unknown route. Links: a plain click routes; Ctrl-click,
middle-click and an external link are all left to the browser
(`defaultPrevented === false`). Clipboard: a real click copies, **the text is
read back out of the real system clipboard**, a refusal is shown to the user,
success is not also shown, and the button returns to a retryable state.

### What the browser run found

Three harness defects, and one genuine product-relevant fact:

1. A `ready` condition that matched static markup before the engine had
   projected — the test was measuring too early.
2. An assertion that an external link "did not change the screen". It *should*
   navigate away, and does; `defaultPrevented === false` is the real claim.
3. Synthesized mouse events landing outside the input viewport, because
   headless lays out the full page height. Fixed with an explicit viewport.

**The genuine finding: `navigator.clipboard.writeText` rejects with
`NotAllowedError` for an untrusted (scripted) click even when clipboard
permission has been granted, and resolves for a trusted one.** Verified
directly:

```text
direct writeText (no gesture):     REJECTED: NotAllowedError
writeText inside a TRUSTED click:  RESOLVED
navigator.userActivation.isActive: true
```

This is mission §36's user-gesture concern, confirmed with evidence rather than
repeated as folklore. It also exercised the failure path end to end: the
application showed "Your browser blocked the copy. Select the command and copy
it manually." — which is precisely why the failure is modelled.

### What was NOT verified — stated plainly

- **Clipboard behaviour in Safari and Firefox.** Only Chromium 141 was
  available. The gesture rule is documented as a design constraint, not a
  tested cross-browser boundary.
- **A deferred clipboard write** (behind a network round trip or a timer).
  Documented as a thing not to build; not empirically tested.
- **That an untrusted click is always refused.** It is on a fresh profile, but
  once clipboard permission is granted in a session Chrome relaxes the gesture
  requirement, so the result depends on what ran before it. An unstable
  assertion is worse than none, so it is not in the automated set — the
  standalone probe result above is the evidence.
- **Real GitHub Pages deployment.** The static-file conclusion follows from the
  build output, which was inspected; no deploy was performed from here.
- **Property-based round-trip testing** of parse/format. The repository has no
  property-testing dependency and §9 says not to add one for this. Round-trip is
  covered by example-based tests across every supported route plus malformed
  input.

---

## 8. Remaining issues

**None blocking.** These are recorded rather than resolved.

1. **No `SDE-MAP.md`.** Required by `method/FEATURE-MANIFESTS.md` for a
   nontrivial adopting repository. Not created here: inventing feature
   boundaries to fill a template would be worse than the visible gap.
2. ~~**`document.title` is not settable.**~~ **Closed in WI-0016** — see §10.
3. ~~**Focus is not managed on route change.**~~ **Closed in WI-0016** — see §10.
4. **Scroll *restoration*** is left to native browser behaviour, deliberately.
   Scroll is now reset on a push (WI-0016, §10).
5. **Clipboard read**, page reload, and external-navigation capabilities do not
   exist. Shapes recorded; adding any should follow a named requirement.
6. **`linkEvent` and `historyEvent` are separate names.** An application must
   wire both to get full link routing. This is deliberate — they are genuinely
   different events — but it is two things to remember.
7. **Cross-browser clipboard verification** (§7).

---

## 9. SDE review

| Question | Answer |
| --- | --- |
| State authority clear? | Yes. Route meaning and copy state live only in the engine; the kernel holds no application state. |
| Legal transitions explicit? | Yes. `Navigate`, `RestoreRoute`, `FollowLink`, `GoBack`, `GoForward`, `CopyInstall`, `RecordCopy`. |
| External effects explicit? | Yes. Both capabilities are `EffectRequest`s with typed outcomes. |
| Browser boundary explicit? | Yes, and now mechanically enforced across application code, not just `src/engine` (**F-2**). |
| Capabilities explicit? | Yes — announced in `Initialize`, only when wired, and listed in one authoritative document. |
| No duplicate state? | Yes. One history (the browser's); one route authority (the engine). No parallel stack. |
| No hidden effects? | Yes. Zero `navigator.clipboard` / `history.*` calls outside the kernel, mechanically checked. |
| Structural locality preserved? | Yes. Navigation and clipboard sit beside the existing effects in the same three files. |
| Navigation discoverable? | Yes — `docs/25-browser-capabilities.md`. |
| Clipboard discoverable? | Yes — same. |
| Tests heterogeneous? | Yes: compiler exhaustiveness, two lexical architecture checkers, pure transition tests, jsdom integration, real-browser CDP, and negative controls proving the checkers fail when they should. |

### Against the mission's definition of done

Items 1–14 and 16–21 are met. **Item 15** ("clipboard contents are not logged")
is met and asserted by a test. The two partial items are named above: the
document-title gap (8.2) and cross-browser clipboard verification (8.7).

The closing statement the mission asks to be made true:

> The browser performs browser operations, Limen governs the boundary, and F#
> owns application meaning.

**True, with one substitution of fact:** the engine that owns application
meaning in *this* repository is TypeScript, and the boundary it sits behind is
plain serializable data specifically so that an F# engine can take its place
without the kernel changing. That substitution is the repository's documented
position, not a compromise made here.


---

## 10. Follow-up: WI-0016 — the two named gaps

Items 8.2 and 8.3 above were closed on request. Both were real; neither needed
what the earlier report assumed it would.

### The document title needed no capability at all

The gap was recorded with "two implementation options: a small `Document`
capability with `setTitle`, or extending binding to cover `<title>`". The
second turned out to be strictly better, and the reason generalizes:

> **A title is a function of state, not an action.**

As a projection it cannot drift — it changes whenever the state it describes
changes, and nothing has to remember to fire it. As an imperative `setTitle`
effect it would have to be issued from every path that changes the screen, and
the one you forget is the bug.

So `start()` now binds `document.head` as well as `document.body`, and:

```html
<title data-text="pageTitle">Fallback</title>
```

is the whole feature. **Zero protocol surface**, and a head with no bindings is
untouched, so it costs nothing for a page that does not opt in. The general
rule is now written down in `docs/24`: derivable from state ⇒ projection;
happens *at* a moment ⇒ effect.

### Focus and scroll: the engine decides when, the markup decides where

These genuinely are one-shot actions, so they are effects — a new opt-in
`Document` capability:

```ts
| { kind: "Document"; correlationId; operation: "focusTarget" }
| { kind: "Document"; correlationId; operation: "scrollToTop" }

type DocumentOutcome =
  | { kind: "Success" }
  | { kind: "Failure"; reason: "unavailable" | "no-target" };
```

**Neither operation names an element**, and that was the hard constraint.
`docs/01-architecture.md` states that the engine never sees a DOM node or an
element id; a `{ operation: "focus", selector: "#main-heading" }` would have
broken exactly that, and it was the obvious first design. The three-way split
instead:

| | Decides |
| --- | --- |
| The engine | **when** focus should move |
| The markup (`data-focus-target`) | **where** |
| The kernel | **how** |

The kernel adds `tabindex="-1"` when the target lacks one, because `focus()` on
a plain heading does **nothing at all** — the silent no-op that lets this class
of accessibility bug survive review. A missing marker reports
`Failure { reason: "no-target" }` rather than nothing.

### When they fire — three arrivals, three answers

| Arrival | Focus | Scroll |
| --- | --- | --- |
| Initial load, **including a deep link** | No | No |
| The user navigated | Yes | Yes |
| The browser moved (Back/Forward) | Yes | **No** |

The deep-link row is the one worth calling out, and the test suite caught it:
a rule keyed on "did the screen change" gets it **wrong**, because a deep link
reaches Settings by moving there from an initial state of Home — so a cold page
load would have yanked focus past the skip link. The engine distinguishes
*arriving* from *navigating*. Confirmed failing against the pre-fix engine, so
the test is not vacuous.

Scroll resets only on a push because `pushState` deliberately does not scroll;
history traversal is left to the browser's own restoration, which is why there
is still no scroll-*restoration* capability and should not be.

### Verification

| | |
| --- | --- |
| `npm run check` | **160 passed, 0 failed, 0 skipped** (was 145) |
| `npm run test:cli` | **107 passed, 0 skipped** |
| Real browser (Chromium 141, CDP) | **13 checks, all passing** |

The browser run covered what jsdom cannot: the real tab title changing across
navigation and back again, real focus landing on a real `<h2>` with the
kernel-added `tabindex`, a cold load and a deep link **not** stealing focus,
and a genuinely scrolled page being reset by a push.

One test defect found and fixed along the way: a scripted transport that
re-projected a different screen when acknowledging the focus effect, which
unmounted the element it had just focused. That is a real hazard for anyone
writing one — an effect result is a round trip carrying a complete `ViewState`
— and it is now documented in `docs/24`.

### Still open after this

- Focus restoration after a **keyed list item is removed** (a different problem
  from route-change focus, and still unaddressed).
- Scroll **restoration**, deliberately not built.
- Cross-browser verification: Chromium only, as before.
