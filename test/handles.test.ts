// Opaque-handle lifecycle (kemiller2002/limen#51 §7) and the shared provider
// conformance suite (#32), including the negative cases.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { defineCapability, type CapabilityProvider } from "../dist/kernel/capabilities.js";
import { createHandleTable } from "../dist/capability-support/handles.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineToBrowserMessage, type EngineTransport } from "../dist/protocol.js";
import { CAPABILITY_OFFER as HANDLE, type HandleRequest, type HandleResult, type ResourceHandle } from "./fixtures/capabilities/generated/handle.ts";
import { decodeHandleRequest, decodeHandleResult } from "./fixtures/capabilities/generated/handle.codec.ts";
import { CAPABILITY_OFFER as ECHO, type EchoRequest, type EchoResult } from "./fixtures/capabilities/generated/echo.ts";
import { decodeEchoRequest, decodeEchoResult } from "./fixtures/capabilities/generated/echo.codec.ts";
import { withDom } from "./dom-helpers.ts";

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

test("a handle is live from create until dispose, and its cleanup runs exactly once", () => {
  const cleaned: string[] = [];
  const table = createHandleTable<string>("s1");
  const id = table.create("resource-a", (resource) => { cleaned.push(resource); });
  assert.deepEqual(table.use(id), { kind: "Live", resource: "resource-a" });
  assert.deepEqual(table.dispose(id), { kind: "Disposed" });
  assert.deepEqual(table.dispose(id), { kind: "Stale", reason: "disposed" }, "a second dispose is stale, not a second cleanup");
  assert.deepEqual(table.use(id), { kind: "Stale", reason: "disposed" });
  assert.deepEqual(cleaned, ["resource-a"]);
});

test("ids are never reused, an unknown id is stale, and an id from another session is stale", () => {
  const table = createHandleTable<string>("s1");
  const first = table.create("a", () => {});
  table.dispose(first);
  const second = table.create("b", () => {});
  assert.notEqual(first, second);
  assert.deepEqual(table.use("s1.99"), { kind: "Stale", reason: "unknown" });
  assert.deepEqual(table.use("not-a-handle"), { kind: "Stale", reason: "other-session" });
  // A reload is a new table: an id an engine restored from storage is not live.
  assert.deepEqual(createHandleTable<string>("s2").use(second), { kind: "Stale", reason: "other-session" });
});

test("host teardown disposes everything still live, and nothing leaks", () => {
  const cleaned: string[] = [];
  const table = createHandleTable<string>();
  ["a", "b", "c"].forEach((resource) => table.create(resource, (value) => { cleaned.push(value); }));
  table.dispose(table.create("d", (value) => { cleaned.push(value); }));
  assert.equal(table.disposeAll(), 3);
  assert.equal(table.size(), 0);
  assert.deepEqual(cleaned.sort(), ["a", "b", "c", "d"]);
});

// ---------------------------------------------------------------------------
// A handle-returning capability, end to end through the kernel
// ---------------------------------------------------------------------------

const handleCapability = (session: string): CapabilityProvider => {
  const table = createHandleTable<{ readonly label: string }>(session);
  return defineCapability<HandleRequest, HandleResult>({
    offer: HANDLE,
    decodeRequest: decodeHandleRequest,
    execute: async (request) => {
      switch (request.operation) {
        case "open": return { kind: "Opened", handle: table.create({ label: request.label }, () => {}) as ResourceHandle };
        case "read": {
          const found = table.use(request.handle);
          return found.kind === "Live" ? { kind: "Read", label: found.resource.label } : { kind: "Stale", reason: found.reason };
        }
        case "close": {
          const closed = table.dispose(request.handle);
          return closed.kind === "Disposed" ? { kind: "Closed" } : { kind: "Stale", reason: closed.reason };
        }
      }
    },
  });
};

const handleOffer = { id: HANDLE.id as CapabilityId, version: HANDLE.version, fingerprint: HANDLE.fingerprint };

// An engine that scripts a sequence of handle requests, one per result.
const scriptedEngine = (script: (previous: readonly HandleResult[]) => HandleRequest | undefined): { readonly transport: EngineTransport; readonly results: HandleResult[] } => {
  const results: HandleResult[] = [];
  const next = (): EngineToBrowserMessage["effects"] => {
    const request = script(results);
    return request === undefined ? [] : [{ kind: "Capability", correlationId: `h${results.length + 1}` as CorrelationId, capability: handleOffer.id, version: 1, request }];
  };
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "Initialize") {
        return { view: {}, effects: next(), cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 1 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [handleOffer] } };
      }
      if (message.kind === "EffectResult" && message.result.kind === "CapabilityResult" && message.result.outcome.kind === "Completed") {
        const decoded = decodeHandleResult(message.result.outcome.result);
        if (decoded.ok) results.push(decoded.value);
      }
      return { view: {}, effects: next(), cancellations: [] };
    },
  };
  return { transport, results };
};

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

test("open → read → close → read → close: live, then stale with the reason, through the real kernel", async () => {
  const opened = (results: readonly HandleResult[]) => results[0]?.kind === "Opened" ? results[0].handle : ("?" as ResourceHandle);
  const steps: readonly ((results: readonly HandleResult[]) => HandleRequest)[] = [
    () => ({ operation: "open", label: "report.csv" }),
    (results) => ({ operation: "read", handle: opened(results) }),
    (results) => ({ operation: "close", handle: opened(results) }),
    (results) => ({ operation: "read", handle: opened(results) }),
    (results) => ({ operation: "close", handle: opened(results) }),
  ];
  const engine = scriptedEngine((results) => steps[results.length]?.(results));
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(engine.transport, document, undefined, { capabilities: [handleCapability("page-1")], requireHandshake: true }).start();
    for (let settled = 0; settled < 10; settled += 1) await flush();
  });
  assert.deepEqual(engine.results.map((result) => result.kind === "Stale" ? `Stale(${result.reason})` : result.kind), ["Opened", "Read", "Closed", "Stale(disposed)", "Stale(disposed)"]);
  assert.deepEqual(engine.results[1], { kind: "Read", label: "report.csv" });
  assert.doesNotMatch(JSON.stringify(engine.results), /\{\}|function/, "only serialized ids and values crossed");
});

test("a handle kept across a reload is stale (other-session), never live by accident", async () => {
  const first = scriptedEngine((results) => (results.length === 0 ? { operation: "open", label: "draft" } : undefined));
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(first.transport, document, undefined, { capabilities: [handleCapability("page-1")] }).start();
    await flush();
  });
  const kept = first.results[0]?.kind === "Opened" ? first.results[0].handle : undefined;
  assert.ok(kept);
  const second = scriptedEngine((results) => (results.length === 0 ? { operation: "read", handle: kept } : undefined));
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(second.transport, document, undefined, { capabilities: [handleCapability("page-2")] }).start();
    await flush();
  });
  assert.deepEqual(second.results, [{ kind: "Stale", reason: "other-session" }]);
});

// ---------------------------------------------------------------------------
// The shared provider conformance suite
// ---------------------------------------------------------------------------

const echoCapability = (): CapabilityProvider => defineCapability<EchoRequest, EchoResult>({
  offer: ECHO,
  decodeRequest: decodeEchoRequest,
  execute: async (request, { signal }) => {
    switch (request.operation) {
      case "echo": return { kind: "Echoed", text: request.text };
      case "announce": return { kind: "Announced" };
      case "wait":
        return new Promise<EchoResult>((resolve) => {
          const timer = setTimeout(() => resolve({ kind: "Waited" }), request.ms);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve({ kind: "Cancelled" }); });
          if (signal.aborted) { clearTimeout(timer); resolve({ kind: "Cancelled" }); }
        });
    }
  },
});

test("well-behaved packs pass the shared provider conformance suite", async () => {
  await withDom(`<p></p>`, async (document) => {
    assert.deepEqual(await runProviderConformance(echoCapability(), {
      document,
      decodeResult: decodeEchoResult,
      valid: [{ name: "echo", payload: { operation: "echo", text: "hi" } }, { name: "announce", payload: { operation: "announce", text: "x" } }],
      malformed: [{ name: "wrong type", payload: { operation: "echo", text: 1 } }, { name: "unknown operation", payload: { operation: "shell" } }, { name: "not an object", payload: "echo" }, { name: "null", payload: null }],
      cancellable: { name: "wait", payload: { operation: "wait", ms: 60_000 } },
    }), []);
    assert.deepEqual(await runProviderConformance(handleCapability("conformance"), {
      document,
      decodeResult: decodeHandleResult,
      valid: [{ name: "open", payload: { operation: "open", label: "x" } }, { name: "read unknown", payload: { operation: "read", handle: "nope" } }],
      malformed: [{ name: "handle is not a string", payload: { operation: "read", handle: 7 } }, { name: "extra field", payload: { operation: "close", handle: "x", force: true } }],
    }), []);
  });
});

test("the suite catches a provider that leaks a DOM node, answers outside its contract, or ignores cancellation", async () => {
  const leaky: CapabilityProvider = {
    descriptor: { id: "limen.fixture.leaky" as CapabilityId, version: 1, fingerprint: "not-a-fingerprint" },
    activate: () => {},
    execute: async (request, { document, signal }) => {
      if (request === "hang") return new Promise(() => {});
      if (request === "boom") throw new Error("provider bug");
      void signal;
      return { kind: "Completed", result: { kind: "Echoed", text: document.body } };
    },
  };
  await withDom(`<p></p>`, async (document) => {
    const failures = await runProviderConformance(leaky, {
      document,
      decodeResult: decodeEchoResult,
      valid: [{ name: "leak", payload: {} }],
      malformed: [{ name: "boom", payload: "boom" }],
      cancellable: { name: "hang", payload: "hang" },
      settleWithinMs: 50,
    });
    assert.ok(failures.some((failure) => failure.startsWith("descriptor: fingerprint")), failures.join("\n"));
    assert.ok(failures.some((failure) => failure.startsWith("malformed boom: threw")), failures.join("\n"));
    assert.ok(failures.some((failure) => failure.startsWith("valid leak: result is outside the pack's contract")), failures.join("\n"));
    assert.ok(failures.some((failure) => failure.startsWith("valid leak: result is not plain JSON")), failures.join("\n"));
    assert.ok(failures.some((failure) => failure.startsWith("cancellable hang: did not settle")), failures.join("\n"));
  });
});

test("cancellation race: a cancellation that arrives after the effect completed changes nothing and fabricates nothing", async () => {
  const results: BrowserToEngineMessage[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message) => {
      if (message.kind === "Initialize") {
        return { view: {}, cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 1 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [{ id: ECHO.id as CapabilityId, version: 1, fingerprint: ECHO.fingerprint }] },
          effects: [{ kind: "Capability", correlationId: "e1" as CorrelationId, capability: ECHO.id as CapabilityId, version: 1, request: { operation: "echo", text: "done" } }] };
      }
      results.push(message);
      // The engine cancels e1 in response to e1's own result: too late.
      return { view: {}, effects: [], cancellations: message.kind === "EffectResult" ? ["e1" as CorrelationId] : [] };
    },
  };
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability()] }).start();
    await flush();
    await flush();
  });
  assert.equal(results.length, 1, "exactly one result; the late cancellation produced no second answer");
  const [only] = results;
  assert.deepEqual(only?.kind === "EffectResult" && only.result.kind === "CapabilityResult" && only.result.outcome, { kind: "Completed", result: { kind: "Echoed", text: "done" } });
});
