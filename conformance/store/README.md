# Store conformance vectors

The language-neutral definition of the `limen.store` capability, version 2
(kemiller2002/limen#28, LCP-075). [`store.vectors.json`](https://github.com/kemiller2002/limen/blob/main/conformance/store/store.vectors.json)
holds 32 vectors and 124 steps. An implementation conforms when every vector
it can run passes. Two implementations run them today:

- the TypeScript pack, through one runner
  ([`runner.js`](https://github.com/kemiller2002/limen/blob/main/test/browser/packs/store-conformance/runner.js)):
  under node over an in-memory IndexedDB with every fault injected
  (`test/store-conformance.test.ts`), and in real Chromium and WebKit (the
  `store-conformance` page of `npm run smoke:packs`);
- the F# in-memory fake, through its own runner over the same file.

Every `StoreResult` and `StoreFact` variant is expected by at least one
vector, and a test fails if one is not.

## A vector

```json
{
  "name": "…",
  "covers": ["Opened", "VersionConflict"],
  "requires": ["inject:quota"],
  "tabs": { "a": { "app": "one" }, "b": { "app": "two" } },
  "registration": { "limits": { "maxValueBytes": 64, "maxTransactionBytes": 200 } },
  "steps": [ … ]
}
```

- Each vector runs on a **fresh origin**: no database exists.
- A **tab** is one registration of the pack on that origin (one provider,
  with its own connections), named in the steps (`"a"`, `"b"`). Tabs share
  the origin's databases. A tab's `app` names its application: tabs with
  different apps register different namespaces. By default every tab is the
  same application.
- `registration.limits` is the size limits every tab registers with;
  without it, the defaults.
- `requires` names what the runner must be able to do; see below.

## Steps

| Step | Meaning |
| --- | --- |
| `{ "tab", "request", "expect" }` | Send `request` from the tab; the result must equal `expect`. |
| `{ "tab", "request", "cancelled": true, "expect" }` | The same, with the request already cancelled by the engine. |
| `{ "facts": "a", "expect": [ … ] }` | Every fact tab `a` received since the last such step must equal `expect`, in order. |
| `{ "inject": "…", "tab" }` | A fault, below. |
| `{ "holdOpen": "db" }`, `{ "release": "db" }` | A raw connection to `db` that ignores version changes, and closing it. |

Equality is JSON equality with exactly the same object keys. The one
exception is `{ "$any": "bool" }` (or `"int"`, `"string"`), which matches any
value of that kind; it is used only where the browser decides the value
(persistence, estimates).

## Requirements, and unsupported vectors

| Requirement | What the runner must do | node | Chromium | WebKit |
| --- | --- | --- | --- | --- |
| `holdOpen` | hold a raw connection that ignores version changes | yes | yes | yes |
| `inject:quota` | fail the tab's next transaction at commit with `QuotaExceededError`, after its operations ran | yes | no: not producible on demand (docs/41) | no |
| `inject:openFails` | fail the tab's next `indexedDB.open` with a named error | yes | no | no |
| `inject:storageCleared` | clear the origin's IndexedDB under open connections, as clearing site data or eviction does | yes | yes: DevTools `Storage.clearDataForOrigin` | no: no DevTools protocol in Playwright WebKit |
| `inject:missing` | run the tab with no `indexedDB` | yes | no | no |
| `storage:present` | the browser has `navigator.storage` persist, persisted and estimate | scripted | yes | no: absent in Playwright WebKit on Linux (measured) |
| `storage:absent` | the browser has no `navigator.storage` | yes | no | no |

A runner that cannot meet a vector's requirement reports the vector
**unsupported, never passed**, and every run reports its passed, failed and
unsupported counts separately. Today: node 32 passed; Chromium 27 passed and
5 unsupported; WebKit 25 passed and 7 unsupported; none failed.
