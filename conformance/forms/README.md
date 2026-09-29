# Form-state semantics

The language-neutral definition of form state for Limen engines
(kemiller2002/limen#21, LCP-006). [`forms.vectors.json`](forms.vectors.json)
is the same definition as nine scenarios, 87 steps. A forms library in any
language conforms when every step produces the stated snapshot, emits exactly
the stated requests, and ignores exactly the stated commands.

**One owner.** The form is engine state. The browser shows it through the
projection and reports what the user did (typing, leaving a field, an
autofill, a submit) as semantic events. There is no DOM-side form store to
reconcile, and the kernel knows nothing about forms. Nothing here is a Limen
protocol type, and no library's API shape is canonical.

## Schema

| Field property | Meaning |
| --- | --- |
| `kind` | `text`, `integer`, `number`, `flag`, `choice`, `choices`, `date` or `time` |
| `required`, `requiredWhen { field, equals }` | a value is needed, always or while another field has that value |
| `visibleWhen { field, equals }` | hidden otherwise: not validated, not submitted, not editable |
| `readonly` | submitted, but not validated or editable (as in HTML) |
| `disabled` | neither submitted, validated nor editable (as in HTML) |
| `minLength`, `maxLength` | `text`, counted in Unicode scalar values |
| `min`, `max` | `integer` and `number` numerically; `date` and `time` in their canonical order |
| `options`, `minCount`, `maxCount` | `choice` (one value) and `choices` (several distinct values) |
| `asyncValidator` | the name of an engine-run check, such as "is this email taken" |

Groups hold repeated rows. Each row has a key, and a field in a row is
addressed as `group[key].field`.

## Values and validation

Values are what the browser reports: a string, or a list of strings for
`choices`.

**Formats:**
- `integer` is canonical decimal and 53-bit safe.
- `number` is `-?(0|[1-9]\d*)(\.\d+)?`, with no exponent.
- `date` is `YYYY-MM-DD` and a real calendar date.
- `time` is `HH:MM` or `HH:MM:SS`, 00:00 to 23:59:59.
- `flag` is `true` or `false`.

A field has at most one **synchronous error**, checked in this order:

1. **Required.** When empty (`""`, `[]`, or a `false` flag) and required:
   `required`. An empty optional field is valid.
2. **Format:** `not-an-integer`, `not-a-number`, `not-a-date`, `not-a-time`,
   `not-a-flag` or `not-an-option`.
3. **Bounds:** `too-short`, `too-long`, `below-min`, `above-max`, `too-few` or
   `too-many`.

A field's **errors** are its synchronous error, then its asynchronous error,
then its server errors. A hidden, disabled or readonly field has none.

**Errors are state, not presentation.** A field is invalid whether or not it
has been touched. Whether to *show* the error is a projection decision the
engine makes, typically using `touched`.

## Commands

| Command | Effect |
| --- | --- |
| `load { values, rows }` | Sets values and originals, and clears touched, errors, pending, global errors and submission. Status becomes `editing`. |
| `input { field, value }` | Sets the value. Clears that field's async and server errors. A `submitted`, `rejected` or `failed` form returns to `editing`. Ignored as `unknown-field` or `not-editable` (hidden, disabled, readonly). |
| `fill { values }` | An autofill or password manager: several `input`s at once, in declaration order, **without touching**. Fields it cannot edit are skipped silently, as the browser skips them. |
| `blur { field }` | Marks it touched. |
| `addRow` / `removeRow { group, key }` | Keys are identity: other rows keep every piece of state. A duplicate key is `duplicate-row`, an absent one `unknown-row`. A re-added key is a new, empty row. |
| `submit { submitter }` | See the lifecycle. |
| `asyncResult { field, token, error }` | Applied only if `token` is the field's current pending token; otherwise `stale-async`. |
| `submitResult { token, outcome }` | Applied only while `submitting` with that token; otherwise `stale-submit`. |
| `resolveUnknown { applied }` | Only while `unknown`; otherwise `not-unknown`. |
| `reset` | Values and rows return to their originals, and touched, errors, pending and global errors are cleared. Refused as `in-flight` or `outcome-unknown`. |

**Async validation is correlated.** An `input` or `fill` to a field with an
`asyncValidator`, whose value is non-empty and synchronously valid, emits
`validate { field, value, token }` with a new token (`v1`, `v2`, …). The field
is then pending. Any later value change, and `reset`, retires the token, so a
late result can never overwrite newer input.

## Submission lifecycle

```text
editing ──submit (valid, nothing pending)──▶ submitting(sN) ──success──▶ submitted
   ▲                                                        ├─rejected─▶ rejected
   └──── input / resolveUnknown(false) ◀── unknown ◀─unknown┴─failed───▶ failed
```

**Starting a submission:**
- **Refused** as `in-flight` while submitting, and as `outcome-unknown` while
  unknown.
- **Invalid:** if any field has an error, the command is ignored as
  `invalid`, and every visible, editable field, rows included, becomes
  touched.
- **Pending:** otherwise, if any validation is pending, it is ignored as
  `validation-pending` and fields are touched the same way.
- **Accepted:** otherwise it emits `submit { token, submitter, values }`,
  clears global errors, and captures the values sent.
  - `values` carries the typed values: integers and numbers as numbers,
    flags as booleans, `choices` as lists.
  - It includes every visible, non-disabled, non-empty field (a flag always).
  - Rows are sent as `[{ key, values }]`.

**Outcomes:**
- **`success`** makes the *sent* values the new originals and clears touched.
  An edit made while the submission was in flight stays dirty.
- **`rejected { fields, global }`** gives each field its server errors. An
  error for a path the form does not have becomes a global error
  `"path: message"`, after the given global errors.
- **`failed`** means nothing was applied. The user may submit again.
- **`unknown`** means the server may or may not have applied it. Submitting
  and resetting are refused until the engine reconciles with
  `resolveUnknown`: `applied: true` behaves as `success`, `applied: false`
  returns to `editing`. An unknown outcome is never treated as a failure.

## Snapshot

Per field:

| Property | Meaning |
| --- | --- |
| `value` | the current value |
| `touched` | the user has left the field, or an invalid submit touched it |
| `dirty` | `value ≠ original` |
| `errors` | as above |
| `pending` | an async validation is outstanding |
| `visible` | not hidden by `visibleWhen` |
| `required` | visible and required now |

Per form:

| Property | Meaning |
| --- | --- |
| `status` | the lifecycle state above |
| `canSubmit` | not `submitting` and not `unknown` |
| `valid` | no errors and nothing pending |
| `dirty` | any field dirty, or the row keys differ from the originals |
| `global` | global errors |
| `rows` | the keys of each group, in order |

## Browser controls

A checkbox reports `true`/`false`. A checkbox group or multi-select reports
the selected values. A radio group reports its checked value. A submit
reports its submitter.

The kernel has to deliver those values faithfully. Its current
`value`-only reading of form controls is recorded as WI-0061, a kernel
mechanism change that is separate from these semantics. Files arrive through
the file capability as references, not contents.
