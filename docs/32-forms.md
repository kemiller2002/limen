# Forms

How a Limen application owns form state (kemiller2002/limen#21, LCP-006).

A form's values, what the user has touched, what is invalid, what is waiting
on the server, and where a submission stands are all **application state**.
They have one owner: the engine. The browser shows them through the
projection and reports what the user did as semantic events. There is no
second, DOM-side form store, and the kernel knows nothing about forms.

| Side | Does |
| --- | --- |
| HTML | the controls, with `data-event` on each (`change` by default; `data-on="input"` to report every keystroke) and `data-bind-value` / `data-bind-*` for what the engine projects |
| Kernel (Core) | reports control values; performs the engine's `Http` effect for a submission and reports all four outcomes |
| Engine | holds the form, applies commands, validates, correlates async checks and submissions, and projects errors, `touched` and `canSubmit` |

## One set of semantics, any language

The rules are defined once, independent of any language:

- [`conformance/forms/README.md`](../conformance/forms/README.md) states them
  in prose;
- [`conformance/forms/forms.vectors.json`](../conformance/forms/forms.vectors.json)
  states them as nine scenarios, 87 steps.

They cover:

- value and original, touched, dirty, validity, pending and submission
  status;
- typed synchronous rules for text, integer, number, flag, single and
  multiple choice, date and time;
- conditional `requiredWhen` / `visibleWhen`;
- readonly, disabled and hidden metadata, following HTML's own rules;
- correlated async validation that stale results cannot overwrite;
- field and global server errors, including unmapped ones;
- reset;
- autofill and password-manager fills that reconcile without touching;
- keyed repeated rows that keep their identity;
- a submission lifecycle whose `unknown` outcome blocks resubmission until
  the engine reconciles it.

## The F# reference library

[`libraries/fsharp/Limen.Forms`](../libraries/fsharp/Limen.Forms) is the
first conforming implementation. It is a pure engine library: `check:layers`
refuses any browser, interop, network, filesystem or process authority in it.
`npm run test:libraries` (part of `test:guests` in CI) runs every step.

```fsharp
open Limen.Forms

let schema =
    { Fields =
        [ { Field.spec "email" Kind.Text with Required = true; AsyncValidator = Some "emailAvailable" }
          { Field.spec "age" Kind.Integer with Min = Some "13" } ]
      Groups = [] }

// Every event from the page becomes one command; every command is one pure
// transition returning the next form, what to do, and why nothing changed.
let form, emitted, ignored = Form.apply (Command.Input("email", Raw.One "ada@example.com")) (Form.create schema)

// emitted = [ Emitted.Validate("email", "ada@example.com", "v1") ]: the engine
// runs the check as an Http effect and answers with Command.AsyncResult.
// Emitted.Submit(token, submitter, payload) becomes the submission's Http
// effect; its EffectOutcome maps onto Outcome.Success / Rejected / Failed /
// Unknown, and OutcomeUnknown is never collapsed into Failed.
```

The engine's projection reads `Form.field`, `Form.isValid`, `Form.canSubmit`,
`Form.status` and `Form.rows`, and decides what to show. A common choice is
to show a field's first error only once it is touched.

## Evidence for the acceptance criteria

| Criterion | Where |
| --- | --- |
| One authoritative state owner | Autofill, keyed rows and reset scenarios; the library is the only store. |
| Async validation is correlated and stale-safe | "async validation is correlated and stale-safe" and "reset invalidates pending async validation" |
| Repeated keyed fields preserve identity | "repeated keyed fields preserve identity" |
| Submission lifecycle is explicit and typed | "submission lifecycle…" and "edits during submission stay dirty…" |
| Invalid submit marks the intended fields touched | "invalid submit marks the intended fields touched, and only those" |
| Server field errors map correctly | the `rejected` steps, including an unmapped path |
| Reset restores the original model | "reset restores the original model" |

## Browser controls (protocol 1.2)

A checkbox's `.value` is its static value (`"on"`) whether or not it is
checked, and a multi-select's `.value` is only its first selection. So
protocol 1.2 adds three optional `SemanticEvent` fields that the kernel reads
from the control itself:

| Field | Carries |
| --- | --- |
| `checked` | a checkbox's or radio's checked state |
| `values` | a multi-select's selected values, or the checked values of a checkbox group (same name, same form) |
| `submitter` | the name of the button that submitted a form |

The kernel sends them only to an engine that negotiated 1.2, so an older
engine's strict decoder never sees a field it does not know
([`test/form-controls.test.ts`](../test/form-controls.test.ts)). Chromium's
own behaviour — real activation toggling a checkbox, a real submission
naming its submitter — is proven by
[`test/browser/packs/core-form-controls/`](../test/browser/packs/core-form-controls/).
