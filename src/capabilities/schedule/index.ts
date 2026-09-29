// The scheduling capability pack (kemiller2002/limen#24, LCP-010): browser
// timing as explicit, cancellable mechanism. The engine asks for a wake-up and
// is told, exactly once, whether it fired or was cancelled — never both, even
// when a cancellation races the timer. Debounce, throttle, polling and retry
// are engine policy built from these requests; the pack holds none.
//
// Timers come from the document's own window, so the pack never reaches for a
// global and behaves identically wherever the kernel runs. Optional: nothing
// in Core imports this module.

import { defineCapability, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type ScheduleRequest, type ScheduleResult } from "./generated/schedule.js";
import { decodeScheduleRequest } from "./generated/schedule.codec.js";

export { CAPABILITY_OFFER as SCHEDULE_CAPABILITY } from "./generated/schedule.js";
export type { ScheduleRequest, ScheduleResult } from "./generated/schedule.js";
export { decodeScheduleRequest, decodeScheduleResult } from "./generated/schedule.codec.js";

const MAX_DELAY = 2147483647;
const validDelay = (ms: number): boolean => Number.isInteger(ms) && ms >= 0 && ms <= MAX_DELAY;

// Arms one wake-up and resolves with the first of: its own result, or
// Cancelled when the engine aborts. A promise settles once, so a timer that
// fires in the same turn as a cancellation cannot produce a second answer;
// disarming on abort keeps the browser from running a callback nobody awaits.
const once = (signal: AbortSignal, arm: (finish: (result: ScheduleResult) => void) => () => void): Promise<ScheduleResult> =>
  new Promise<ScheduleResult>((resolve) => {
    if (signal.aborted) {
      resolve({ kind: "Cancelled" });
      return;
    }
    const disarm = arm(resolve);
    signal.addEventListener("abort", () => {
      disarm();
      resolve({ kind: "Cancelled" });
    }, { once: true });
  });

const perform = (request: ScheduleRequest, view: Window, signal: AbortSignal): Promise<ScheduleResult> => {
  const started = view.performance.now();
  const elapsed = (): number => view.performance.now() - started;
  switch (request.operation) {
    case "timeout":
      if (!validDelay(request.delayMs)) return Promise.resolve({ kind: "InvalidDelay" });
      return once(signal, (finish) => {
        const handle = view.setTimeout(() => finish({ kind: "Fired", elapsedMs: elapsed() }), request.delayMs);
        return () => view.clearTimeout(handle);
      });
    case "animationFrame":
      if (typeof view.requestAnimationFrame !== "function") return Promise.resolve({ kind: "Unsupported" });
      return once(signal, (finish) => {
        const handle = view.requestAnimationFrame(() => finish({ kind: "Fired", elapsedMs: elapsed() }));
        return () => view.cancelAnimationFrame(handle);
      });
    case "idle": {
      if (typeof view.requestIdleCallback !== "function") return Promise.resolve({ kind: "Unsupported" });
      const timeout = request.timeoutMs;
      if (timeout !== undefined && !validDelay(timeout)) return Promise.resolve({ kind: "InvalidDelay" });
      return once(signal, (finish) => {
        const handle = view.requestIdleCallback(
          (deadline) => finish({ kind: "IdleFired", elapsedMs: elapsed(), didTimeout: deadline.didTimeout, remainingMs: deadline.timeRemaining() }),
          timeout === undefined ? undefined : { timeout },
        );
        return () => view.cancelIdleCallback(handle);
      });
    }
  }
};

const execute = async (request: ScheduleRequest, context: CapabilityRequestContext): Promise<ScheduleResult> => {
  const view = context.document.defaultView;
  return view === null ? { kind: "Unsupported" } : perform(request, view, context.signal);
};

export const scheduleCapability = (): CapabilityProvider =>
  defineCapability<ScheduleRequest, ScheduleResult>({ offer: CAPABILITY_OFFER, decodeRequest: decodeScheduleRequest, execute });
