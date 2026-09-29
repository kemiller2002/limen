// The scheduling capability pack (kemiller2002/limen#24, LCP-010) through the
// real kernel with the handshake negotiated. Reference tests from the issue:
// cancel-before-fire, stale scheduled event rejection, unsupported idle
// callback. Animation-frame ordering needs a real browser (jsdom has no
// requestAnimationFrame, which is itself the "unsupported" case here):
// test/browser/packs/schedule/.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { SCHEDULE_CAPABILITY, decodeScheduleResult, scheduleCapability, type ScheduleRequest, type ScheduleResult } from "../dist/capabilities/schedule/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EffectRequest, type EngineTransport } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const offer = { id: SCHEDULE_CAPABILITY.id as CapabilityId, version: SCHEDULE_CAPABILITY.version, fingerprint: SCHEDULE_CAPABILITY.fingerprint };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

type Step = { readonly schedule?: readonly (readonly [string, ScheduleRequest])[]; readonly cancel?: readonly string[] };
type Answer = { readonly id: string; readonly result: ScheduleResult | string };

// Answers Initialize and then each Event with the next scripted step: new
// wake-ups under the given correlation ids, and cancellations of earlier ones.
const scheduler = (steps: readonly Step[]): { readonly transport: EngineTransport; readonly answers: Answer[] } => {
  const answers: Answer[] = [];
  const cursor = { step: 0 };
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "EffectResult" && message.result.kind === "CapabilityResult") {
        const outcome = message.result.outcome;
        const decoded = outcome.kind === "Completed" ? decodeScheduleResult(outcome.result) : undefined;
        answers.push({ id: message.result.correlationId, result: decoded?.ok === true ? decoded.value : outcome.kind });
        return { view: {}, effects: [], cancellations: [] };
      }
      const step = steps[cursor.step] ?? {};
      cursor.step += 1;
      const effects = (step.schedule ?? []).map(([id, request]): EffectRequest => ({ kind: "Capability", correlationId: id as CorrelationId, capability: offer.id, version: 1, request }));
      const response = { view: {}, effects, cancellations: (step.cancel ?? []).map((id) => id as CorrelationId) };
      return message.kind === "Initialize"
        ? { ...response, handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } }
        : response;
    },
  };
  return { transport, answers };
};

const drive = async (steps: readonly Step[], act: (document: Document) => Promise<void> = async () => {}): Promise<readonly Answer[]> => {
  const engine = scheduler(steps);
  await withDom(`<button id="next" data-event="next">next</button>`, async (document) => {
    // start() resolves only once the initial effects have answered, so the
    // user acts while it is still pending — as a real user would.
    const started = new BrowserKernel(engine.transport, document, undefined, { capabilities: [scheduleCapability()], requireHandshake: true }).start();
    await act(document);
    await started;
  });
  return engine.answers;
};

const next = async (document: Document): Promise<void> => {
  document.getElementById("next")?.click();
  await sleep(0);
};

test("a timeout fires once, after at least its delay", async () => {
  const answers = await drive([{ schedule: [["t1", { operation: "timeout", delayMs: 20 }]] }], () => sleep(80));
  assert.equal(answers.length, 1);
  const [only] = answers;
  assert.equal(only?.id, "t1");
  assert.ok(typeof only?.result !== "string" && only?.result.kind === "Fired" && only.result.elapsedMs >= 15, JSON.stringify(only));
});

test("cancel-before-fire: the engine's cancellation is answered Cancelled, and the wake-up never fires", async () => {
  const answers = await drive([
    { schedule: [["t1", { operation: "timeout", delayMs: 60 }]] },
    { cancel: ["t1"] },
  ], async (document) => {
    await sleep(10);
    await next(document);
    await sleep(120);
  });
  assert.deepEqual(answers, [{ id: "t1", result: { kind: "Cancelled" } }]);
});

test("stale scheduled event rejection: a superseded wake-up is cancelled in the same response as its replacement, and only the replacement fires", async () => {
  const answers = await drive([
    { schedule: [["search-1", { operation: "timeout", delayMs: 80 }]] },
    // The user typed again: the engine replaces the pending debounce.
    { cancel: ["search-1"], schedule: [["search-2", { operation: "timeout", delayMs: 10 }]] },
  ], async (document) => {
    await sleep(5);
    await next(document);
    await sleep(160);
  });
  assert.deepEqual(answers.map((answer) => [answer.id, typeof answer.result === "string" ? answer.result : answer.result.kind]), [["search-1", "Cancelled"], ["search-2", "Fired"]]);
});

test("unsupported primitives are refused deterministically, with nothing scheduled", async () => {
  const answers = await drive([{ schedule: [["i1", { operation: "idle" }], ["a1", { operation: "animationFrame" }]] }], () => sleep(20));
  assert.deepEqual(answers, [{ id: "i1", result: { kind: "Unsupported" } }, { id: "a1", result: { kind: "Unsupported" } }]);
});

test("a delay outside 0..2147483647 is InvalidDelay, not a timer the browser would clamp", async () => {
  const answers = await drive([{ schedule: [["n", { operation: "timeout", delayMs: -1 }], ["big", { operation: "timeout", delayMs: 2147483648 }]] }], () => sleep(10));
  assert.deepEqual(answers, [{ id: "n", result: { kind: "InvalidDelay" } }, { id: "big", result: { kind: "InvalidDelay" } }]);
});

test("an engine that did not select the capability gets Unsupported from Core, and no timer is armed", async () => {
  const engine = scheduler([{ schedule: [["t1", { operation: "timeout", delayMs: 0 }]] }]);
  const answers: string[] = [];
  const transport: EngineTransport = {
    start: engine.transport.start,
    dispatch: async (message) => {
      const response = await engine.transport.dispatch(message);
      if (message.kind === "EffectResult" && message.result.kind === "CapabilityResult") answers.push(message.result.outcome.kind);
      return message.kind === "Initialize" && response.handshake?.kind === "Accepted" ? { ...response, handshake: { ...response.handshake, capabilities: [] } } : response;
    },
  };
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [scheduleCapability()] }).start();
    await sleep(20);
  });
  assert.deepEqual(answers, ["Unsupported"]);
});

test("the scheduling pack passes the shared provider conformance suite", async () => {
  await withDom(`<p></p>`, async (document) => {
    assert.deepEqual(await runProviderConformance(scheduleCapability(), {
      document,
      decodeResult: decodeScheduleResult,
      valid: [
        { name: "timeout-0", payload: { operation: "timeout", delayMs: 0 } },
        { name: "idle", payload: { operation: "idle", timeoutMs: 5 } },
        { name: "invalid", payload: { operation: "timeout", delayMs: -5 } },
      ],
      malformed: [
        { name: "fractional", payload: { operation: "timeout", delayMs: 1.5 } },
        { name: "missing-delay", payload: { operation: "timeout" } },
        { name: "interval", payload: { operation: "interval", delayMs: 10 } },
        { name: "extra", payload: { operation: "animationFrame", repeat: true } },
      ],
      cancellable: { name: "long-timeout", payload: { operation: "timeout", delayMs: 60000 } },
    }), []);
  });
});
