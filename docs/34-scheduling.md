# Scheduling

Browser timing as explicit, cancellable mechanism
(kemiller2002/limen#24, LCP-010). An engine that needs to wait asks for a
wake-up, and is told **exactly once** whether it fired or was cancelled.

Debounce, throttle, polling, retry with backoff and "show the spinner only
after 300 ms" are application policy. The engine builds them from these
requests and keeps them in its own state. The pack holds no policy, and the
kernel hides no timer.

```ts
import { scheduleCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/schedule";

await new BrowserKernel(transport, document, diagnostics, { capabilities: [scheduleCapability()] }).start();
// engine → { kind: "Capability", correlationId: "search-2", capability: "limen.schedule", version: 1,
//            request: { operation: "timeout", delayMs: 250 } }
// engine cancels the previous one by listing its correlation id in `cancellations`.
```

The contract is [`contract/schedule.contract.json`](../contract/schedule.contract.json),
with bindings for TypeScript, F#, C# and Rust.

| Request | Answer |
| --- | --- |
| `timeout { delayMs }` | `Fired { elapsedMs }` after at least `delayMs`; `InvalidDelay` outside 0 to 2147483647, rather than a delay the browser would silently clamp |
| `animationFrame {}` | `Fired { elapsedMs }` before the next repaint; frames requested together fire in request order |
| `idle { timeoutMs? }` | `IdleFired { elapsedMs, didTimeout, remainingMs }`; `Unsupported` where the browser has no idle callback |
| any, cancelled by the engine | `Cancelled`, and never a later `Fired`. A cancellation that races the timer still yields one answer. |

**Stale wake-ups.** Every wake-up carries the engine's correlation id. To
replace one, the engine lists the old id in `cancellations` in the same
response that schedules the new one. The old one answers `Cancelled`, and
only the new one fires. The engine discards any answer for an id it no
longer expects, exactly as it does for Http.

**Deliberately absent.** Intervals and prioritized task scheduling
(`scheduler.postTask`) are not offered. The issue allows them only with a
concrete reference case or a measured need, and there is neither. A repeating
wake-up is a timeout the engine re-requests when it fires, so the engine can
stop, change or skip it on the next response.

**Optional.** Nothing in Core imports the pack. `kernel-with-schedule` has
its own payload budget, and the minimal consumer loads none of it
(`bench/budgets.json`).

| Evidence | Where |
| --- | --- |
| Fires once after its delay; cancel-before-fire; stale supersession; unsupported primitives; invalid delays; not negotiated; conformance suite | [`test/schedule.test.ts`](../test/schedule.test.ts) |
| Animation-frame ordering, delay ordering, real idle callbacks and cancel-before-fire in Chromium, under a strict CSP with Trusted Types | [`test/browser/packs/schedule/`](../test/browser/packs/schedule/), `npm run smoke:packs` |
