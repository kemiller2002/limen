// A thrown fetch is a confident Failure only when nothing can have changed
// (kemiller2002/limen#40, protocol 1.4). fetch() throws one TypeError whether
// the request never left or the connection dropped after the server had it —
// and Chromium resends a reset POST once before rejecting — so for a write
// while online the kernel reports OutcomeUnknown{connection-lost}, never the
// retryable Failure{network} it reported before. Safe methods and requests
// made offline stay Failure{network}. An engine that negotiated 1.3 hears the
// one unknown reason it can decode. The real reset is proven in Chromium in
// test/browser/packs/core-http/.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CorrelationId, type EffectOutcome, type EngineTransport, type HttpMethod } from "../dist/protocol.js";
import { withDom, withFetch } from "./dom-helpers.ts";

type Case = { readonly method: HttpMethod; readonly minor?: number; readonly offline?: boolean };

// One Http effect whose fetch throws, through the real kernel; the engine
// speaks `minor` (absent: a legacy engine without a handshake).
const thrown = async ({ method, minor, offline = false }: Case): Promise<EffectOutcome | undefined> => {
  const state: { outcome?: EffectOutcome } = {};
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "EffectResult" && message.result.kind === "HttpResult") state.outcome = message.result.outcome;
      if (message.kind !== "Initialize") return { view: {}, effects: [], cancellations: [] };
      return {
        view: {}, cancellations: [],
        effects: [{ kind: "Http", correlationId: "h1" as CorrelationId, method, url: "/api", timeoutMs: 1000, ...(method === "GET" || method === "HEAD" || method === "OPTIONS" ? {} : { body: "{}" }) }],
        ...(minor !== undefined ? { handshake: { kind: "Accepted", protocol: { major: 1, minor }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [] } } : {}),
      };
    },
  };
  const fetchImpl = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
  await withFetch(fetchImpl, () => withDom("<p>http</p>", async (document) => {
    if (offline) Object.defineProperty(document.defaultView?.navigator, "onLine", { value: false, configurable: true });
    await new BrowserKernel(transport, document).start();
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }));
  return state.outcome;
};

const sequentially = <T, R>(items: readonly T[], each: (item: T) => Promise<R>): Promise<readonly R[]> =>
  items.reduce<Promise<readonly R[]>>(async (done, item) => [...(await done), await each(item)], Promise.resolve([]));

test("a write whose fetch threw while online is OutcomeUnknown{connection-lost} for a 1.4 engine — never a retryable Failure", async () => {
  const outcomes = await sequentially(["POST", "PUT", "PATCH", "DELETE"] as const, (method) => thrown({ method, minor: 4 }));
  assert.deepEqual(outcomes, Array.from({ length: 4 }, () => ({ kind: "OutcomeUnknown", reason: "connection-lost" })));
});

test("a safe method whose fetch threw is still Failure{network}: reading twice changes nothing", async () => {
  const outcomes = await sequentially(["GET", "HEAD", "OPTIONS"] as const, (method) => thrown({ method, minor: 4 }));
  assert.deepEqual(outcomes, Array.from({ length: 3 }, () => ({ kind: "Failure", reason: "network" })));
});

test("a write made while the browser was offline is Failure{network}: it cannot have left the browser", async () => {
  assert.deepEqual(await thrown({ method: "POST", minor: 4, offline: true }), { kind: "Failure", reason: "network" });
});

test("an engine that negotiated 1.3, or none, still hears OutcomeUnknown — with the one reason it can decode", async () => {
  const outcomes = await sequentially([{ method: "POST", minor: 3 }, { method: "DELETE" }] as const, thrown);
  assert.deepEqual(outcomes, [{ kind: "OutcomeUnknown", reason: "timeout-after-dispatch" }, { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" }]);
});
