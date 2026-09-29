// Kernel lifecycle for hosts (kemiller2002/limen#50, LCP-032): a read-only
// status, and dispose(), which ends a kernel so another can take the page —
// every listener removed, in-flight effects aborted, nothing sent again.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { defineCapability } from "../dist/kernel/capabilities.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineTransport } from "../dist/protocol.js";
import { withDom, withFetch } from "./dom-helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const recording = (overrides: Partial<EngineTransport> = {}, effects: (message: BrowserToEngineMessage) => unknown[] = () => []) => {
  const sent: string[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message) => {
      sent.push(message.kind === "Event" ? `Event:${message.event.name}` : message.kind);
      return { view: {}, effects: effects(message) as never, cancellations: [] };
    },
    ...overrides,
  };
  return { transport, sent };
};

test("status follows the kernel's phase: unstarted, running; faulted when the transport cannot start; incompatible on a refused handshake", async () => {
  await withDom(`<button data-event="go">go</button>`, async (document) => {
    const { transport } = recording();
    const kernel = new BrowserKernel(transport, document);
    assert.equal(kernel.status, "unstarted");
    await kernel.start();
    assert.equal(kernel.status, "running");
  });
  await withDom(`<p></p>`, async (document) => {
    const { transport } = recording({ start: async () => { throw new Error("no engine"); } });
    const kernel = new BrowserKernel(transport, document);
    await kernel.start();
    assert.equal(kernel.status, "faulted");
  });
  await withDom(`<p></p>`, async (document) => {
    const { transport } = recording();
    const kernel = new BrowserKernel(transport, document, undefined, { requireHandshake: true });
    await kernel.start();
    assert.equal(kernel.status, "incompatible", "a legacy engine without a handshake, when one is required");
  });
});

test("dispose removes every listener: a click, a popstate and a composition end send nothing afterwards", async () => {
  await withDom(`<button id="go" data-event="go">go</button><input id="field" data-event="typed">`, async (document) => {
    const { transport, sent } = recording();
    const kernel = new BrowserKernel(transport, document);
    await kernel.start();
    document.getElementById("go")?.click();
    await sleep(0);
    kernel.dispose();
    kernel.dispose();
    document.getElementById("go")?.click();
    const window = document.defaultView;
    assert.ok(window !== null);
    window.dispatchEvent(new window.Event("popstate"));
    document.getElementById("field")?.dispatchEvent(new window.Event("compositionend"));
    await sleep(5);
    assert.deepEqual(sent, ["Initialize", "Event:go"]);
    assert.equal(kernel.status, "disposed");
  });
});

test("dispose aborts in-flight effects, and their results are never delivered", async () => {
  const aborted: unknown[] = [];
  const fetchImpl = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => { aborted.push(init.signal?.reason); reject(new Error("aborted")); });
  })) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<p></p>`, async (document) => {
    const { transport, sent } = recording({}, (message) => (message.kind === "Initialize" ? [{ kind: "Http", correlationId: "c1" as CorrelationId, method: "GET", url: "/slow", timeoutMs: 5000 }] : []));
    const kernel = new BrowserKernel(transport, document);
    const started = kernel.start();
    await sleep(5);
    kernel.dispose();
    await started;
    await sleep(5);
    assert.deepEqual(aborted, ["disposed"]);
    assert.deepEqual(sent, ["Initialize"], "no EffectResult for an effect whose engine is gone");
  }));
});

test("disposed while the transport is still starting: the kernel never binds or initializes", async () => {
  await withDom(`<button id="go" data-event="go">go</button>`, async (document) => {
    const gate: { open?: () => void } = {};
    const { transport, sent } = recording({ start: () => new Promise<void>((resolve) => { gate.open = resolve; }) });
    const kernel = new BrowserKernel(transport, document);
    const started = kernel.start();
    kernel.dispose();
    gate.open?.();
    await started;
    document.getElementById("go")?.click();
    await sleep(5);
    assert.deepEqual(sent, []);
    assert.equal(kernel.status, "disposed");
  });
});

test("a capability's fact after dispose is not sent", async () => {
  const offer = { id: "test.echo" as CapabilityId, version: 1, fingerprint: "sha256:echo" };
  const host: { emit?: (fact: unknown) => void } = {};
  const provider = defineCapability<unknown, unknown, unknown>({
    offer,
    decodeRequest: (value) => ({ ok: true, value }),
    execute: async () => ({}),
    activate: (capabilityHost) => { host.emit = capabilityHost.emitFact; },
  });
  await withDom(`<p></p>`, async (document) => {
    const sent: string[] = [];
    const transport: EngineTransport = {
      start: async () => {},
      dispatch: async (message) => {
        sent.push(message.kind);
        return { view: {}, effects: [], cancellations: [], ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor: 3 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } } : {}) };
      },
    };
    const kernel = new BrowserKernel(transport, document, undefined, { capabilities: [provider] });
    await kernel.start();
    host.emit?.({ before: true });
    await sleep(0);
    kernel.dispose();
    host.emit?.({ after: true });
    await sleep(5);
    assert.deepEqual(sent, ["Initialize", "CapabilityFact"]);
  });
});
