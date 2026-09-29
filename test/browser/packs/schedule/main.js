// The scheduling pack's real-browser scenarios: each round, the page queues
// the wake-ups and cancellations the engine will send with its next response,
// clicks, and waits for the answers in the order the pack delivers them.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { scheduleCapability, SCHEDULE_CAPABILITY, decodeScheduleResult } from "../../../../dist/capabilities/schedule/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: SCHEDULE_CAPABILITY.id, version: SCHEDULE_CAPABILITY.version, fingerprint: SCHEDULE_CAPABILITY.fingerprint };
const state = { queued: { schedule: [], cancel: [] }, answers: [], waiting: null };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeScheduleResult(outcome.result) : { ok: false };
      state.answers.push({ id: message.result.correlationId, result: decoded.ok ? decoded.value : { kind: outcome.kind } });
      if (state.waiting !== null && state.answers.length >= state.waiting.count) state.waiting.resolve(state.answers.splice(0));
      return { view: {}, effects: [], cancellations: [] };
    }
    const { schedule, cancel } = state.queued;
    state.queued = { schedule: [], cancel: [] };
    return { view: {}, cancellations: cancel, effects: schedule.map(([id, request]) => ({ kind: "Capability", correlationId: id, capability: offer.id, version: 1, request })) };
  },
};

const round = (schedule, cancel, count) => new Promise((resolve) => {
  state.queued = { schedule, cancel };
  state.waiting = { count, resolve };
  document.getElementById("next").click();
});
const kinds = (answers) => answers.map((answer) => answer.id + ":" + answer.result.kind);
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [scheduleCapability()], requireHandshake: true }).start();

const frames = await round([["f1", { operation: "animationFrame" }], ["f2", { operation: "animationFrame" }], ["f3", { operation: "animationFrame" }]], [], 3);
expect("animation frames fire, in the order they were requested", JSON.stringify(kinds(frames)) === JSON.stringify(["f1:Fired", "f2:Fired", "f3:Fired"]), frames);

const delays = await round([["slow", { operation: "timeout", delayMs: 60 }], ["fast", { operation: "timeout", delayMs: 5 }]], [], 2);
expect("timeouts fire by delay, not by request order, each after at least its delay", kinds(delays).join() === "fast:Fired,slow:Fired" && delays[1].result.elapsedMs >= 55, delays);

const idle = await round([["i1", { operation: "idle", timeoutMs: 500 }]], [], 1);
expect("Chromium supports idle callbacks: IdleFired with a timeout flag and remaining time", idle[0].result.kind === "IdleFired" && typeof idle[0].result.didTimeout === "boolean" && idle[0].result.remainingMs >= 0, idle);

// Cancel-before-fire: arm a long timeout, then cancel it in the next response.
const arming = new Promise((resolve) => { state.waiting = { count: 1, resolve }; });
state.queued = { schedule: [["long", { operation: "timeout", delayMs: 400 }]], cancel: [] };
document.getElementById("next").click();
await new Promise((resolve) => setTimeout(resolve, 20));
state.queued = { schedule: [], cancel: ["long"] };
document.getElementById("next").click();
const cancelled = await arming;
await new Promise((resolve) => setTimeout(resolve, 500));
expect("cancel-before-fire: Cancelled, and nothing fires afterwards", kinds(cancelled).join() === "long:Cancelled" && state.answers.length === 0, { cancelled, after: state.answers });

window.__limenPackResult = { pack: "limen.schedule", checks };
