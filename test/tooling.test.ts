// Fake host, trace and replay (kemiller2002/limen#32, LCP-029/031), driven
// against the repository's real reference engine.

import assert from "node:assert/strict";
import test from "node:test";
import { DirectTypeScriptTransport } from "../dist/engine/transport.js";
import { answerHandshake } from "../dist/guest/handshake.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CorrelationId, type EngineToBrowserMessage, type EngineTransport } from "../dist/protocol.js";
import { createFakeHost } from "../dist/tooling/fake-host.js";
import { exportTrace, REDACTED, replay, tracingTransport, type TraceEntry } from "../dist/tooling/trace.js";

const available = { kind: "Success" as const, status: 200, body: { available: true } };

test("the fake host runs an engine with no DOM: events, effects and outcomes flow as they do through the kernel", async () => {
  const host = createFakeHost({ transport: new DirectTypeScriptTransport(), outcomes: { http: () => available } });
  assert.equal((await host.start()).kind, "Compatible");
  await host.event("emailChanged", undefined, "ada@example.com");
  await host.event("checkAvailability");
  assert.equal(host.view().statusText, "ada@example.com is available.");
  assert.deepEqual(host.pending(), []);
});

test("time is a fake clock: a held Http effect past its timeout becomes OutcomeUnknown, never Failure", async () => {
  const host = createFakeHost({ transport: new DirectTypeScriptTransport() });
  await host.start();
  await host.event("emailChanged", undefined, "ada@example.com");
  await host.event("checkAvailability");
  assert.equal(host.pending().length, 1, "no outcome scripted: the request is held");
  await host.advance(4999);
  assert.equal(host.pending().length, 1, "not yet timed out at 4999ms of 5000");
  await host.advance(1);
  assert.equal(host.now(), 5000);
  assert.deepEqual(host.pending(), []);
  assert.equal(host.view().statusText, "The result is uncertain; reconciliation is required.");
  const last = host.sent().at(-1);
  assert.deepEqual(last?.kind === "EffectResult" && last.result.kind === "HttpResult" && last.result.outcome, { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" });
});

test("a held result resolved late is still delivered, so an engine's stale-result guard can be tested deterministically", async () => {
  const host = createFakeHost({ transport: new DirectTypeScriptTransport() });
  await host.start();
  await host.event("emailChanged", undefined, "ada@example.com");
  await host.event("checkAvailability");
  const [first] = host.pending();
  assert.ok(first);
  await host.event("emailChanged", undefined, "grace@example.com");
  await host.resolve(first.effect.correlationId, { kind: "HttpResult", correlationId: first.effect.correlationId, outcome: available });
  assert.equal(host.view().statusText, "Ready to check.", "the answer about ada must not overwrite grace's draft");
});

test("the fake host requires the handshake when asked, and refuses a legacy engine", async () => {
  const host = createFakeHost({ transport: new DirectTypeScriptTransport(), requireHandshake: true });
  assert.deepEqual(await host.start(), { kind: "Incompatible", reason: { kind: "handshake-required" } });
  await assert.rejects(host.event("checkAvailability"), /not running/);
});

test("a handshaking engine negotiates with the fake host exactly as with the kernel", async () => {
  const engine: EngineTransport = {
    start: async () => {},
    dispatch: async (message) => ({
      view: { ok: true },
      effects: [],
      cancellations: [],
      ...(message.kind === "Initialize" ? { handshake: answerHandshake(message.handshake, { protocol: { major: 1, minor: 1 }, contract: { ...CORE_CONTRACT_IDENTITY }, required: [], optional: [] }) } : {}),
    }),
  };
  const host = createFakeHost({ transport: engine, requireHandshake: true });
  assert.deepEqual(await host.start(), { kind: "Compatible", negotiation: { kind: "Negotiated", capabilities: [] } });
});

test("fake storage and navigation behave like their browser counterparts, and cross-origin pushes are refused", async () => {
  const requests: BrowserToEngineMessage[] = [];
  const engine: EngineTransport = {
    start: async () => {},
    dispatch: async (message) => {
      requests.push(message);
      const effects = message.kind === "Initialize" ? [
        { kind: "Storage" as const, correlationId: "s1" as CorrelationId, operation: "set" as const, key: "k", value: "v" },
        { kind: "Storage" as const, correlationId: "s2" as CorrelationId, operation: "get" as const, key: "k" },
        { kind: "Navigation" as const, correlationId: "n1" as CorrelationId, operation: "push" as const, url: "/invoices/42?tab=history" },
        { kind: "Navigation" as const, correlationId: "n2" as CorrelationId, operation: "push" as const, url: "https://elsewhere.test/" },
      ] : [];
      return { view: {}, effects, cancellations: [] };
    },
  };
  const host = createFakeHost({ transport: engine });
  await host.start();
  const outcomes = requests.flatMap((message) => (message.kind === "EffectResult" ? [message.result] : [])).map((result) => ("outcome" in result ? result.outcome : undefined));
  assert.deepEqual(outcomes, [
    { kind: "Success", value: null },
    { kind: "Success", value: "v" },
    { kind: "Success", location: { origin: "https://fake.test", path: "/invoices/42", query: "?tab=history", hash: "" } },
    { kind: "Failure", reason: "not-same-origin" },
  ]);
  assert.equal(host.location().path, "/invoices/42");
  assert.equal(host.storage().get("k"), "v");
});

test("an engine that reuses an in-flight correlation id is caught, as the kernel refuses it", async () => {
  const engine: EngineTransport = {
    start: async () => {},
    dispatch: async (message) => ({
      view: {},
      effects: message.kind === "Initialize" ? [
        { kind: "Http", correlationId: "x" as CorrelationId, method: "GET", url: "/a", timeoutMs: 100 },
        { kind: "Http", correlationId: "x" as CorrelationId, method: "GET", url: "/b", timeoutMs: 100 },
      ] : [],
      cancellations: [],
    }),
  };
  await assert.rejects(createFakeHost({ transport: engine }).start(), /reused in-flight correlation id x/);
});

// ---------------------------------------------------------------------------
// Trace and replay
// ---------------------------------------------------------------------------

const recordSession = async (): Promise<readonly TraceEntry[]> => {
  const entries: TraceEntry[] = [];
  const clock = { now: 0 };
  const traced = tracingTransport(new DirectTypeScriptTransport(), (entry) => { entries.push(entry); }, { clock: () => { clock.now += 1; return clock.now; } });
  const host = createFakeHost({ transport: traced, outcomes: { http: () => available } });
  await host.start();
  await host.event("emailChanged", undefined, "ada@example.com");
  await host.event("checkAvailability");
  return entries;
};

test("trace order is deterministic: every message in, then its response, sequenced", async () => {
  const entries = await recordSession();
  assert.deepEqual(entries.map((entry) => `${entry.sequence}:${entry.direction}:${entry.direction === "to-engine" ? entry.message.kind : ""}`), [
    "1:to-engine:Initialize", "2:from-engine:",
    "3:to-engine:Event", "4:from-engine:",
    "5:to-engine:Event", "6:from-engine:",
    "7:to-engine:EffectResult", "8:from-engine:",
  ]);
  assert.deepEqual(entries.map((entry) => entry.at), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(await recordSession(), entries, "two recordings of the same session are identical");
});

test("replaying a trace against a fresh engine reproduces every response and the final projection", async () => {
  const entries = await recordSession();
  const result = await replay(entries, new DirectTypeScriptTransport());
  assert.deepEqual(result.divergences, []);
  assert.equal(result.finalView?.statusText, "ada@example.com is available.");
});

test("replay reports where a different engine diverges", async () => {
  const entries = await recordSession();
  const different: EngineTransport = { start: async () => {}, dispatch: async (): Promise<EngineToBrowserMessage> => ({ view: { statusText: "something else" }, effects: [], cancellations: [] }) };
  const result = await replay(entries, different);
  assert.equal(result.divergences.length, 4);
});

test("an exported trace redacts user data and keeps the application's vocabulary", async () => {
  const entries: TraceEntry[] = [
    { sequence: 1, at: 1, direction: "to-engine", message: { kind: "Event", event: { kind: "Event", name: "emailChanged", value: "ada@example.com" } } },
    { sequence: 2, at: 2, direction: "from-engine", message: { view: { email: "ada@example.com" }, effects: [
      { kind: "Http", correlationId: "c" as CorrelationId, method: "POST", url: "/api", headers: { authorization: "Bearer secret-token" }, body: "{\"password\":\"hunter2\"}", timeoutMs: 1 },
      { kind: "Clipboard", correlationId: "k" as CorrelationId, operation: "writeText", text: "copied secret" },
      { kind: "Storage", correlationId: "s" as CorrelationId, operation: "set", key: "session", value: "secret" },
    ], cancellations: [] } },
    { sequence: 3, at: 3, direction: "to-engine", message: { kind: "EffectResult", result: { kind: "HttpResult", correlationId: "c" as CorrelationId, outcome: { kind: "Success", status: 200, body: { ssn: "000-00-0000" } } } } },
    { sequence: 4, at: 4, direction: "to-engine", message: { kind: "LocationChanged", location: { origin: "https://a.test", path: "/reset", query: "?token=abc", hash: "" } } },
  ];
  const exported = exportTrace(entries);
  for (const secret of ["ada@example.com", "secret-token", "hunter2", "copied secret", "\"secret\"", "000-00-0000", "token=abc"]) {
    assert.ok(!exported.includes(secret), `the export leaked ${secret}`);
  }
  for (const vocabulary of ["emailChanged", "authorization", "/api", "session", "/reset", "\"email\""]) {
    assert.ok(exported.includes(vocabulary), `the export lost ${vocabulary}`);
  }
  assert.ok(exported.includes(REDACTED));
  JSON.parse(exported);
});

test("tracing disabled is a no-op: the transport returned is the one given", () => {
  const inner = new DirectTypeScriptTransport();
  assert.equal(tracingTransport(inner, () => { throw new Error("must not record"); }, { enabled: false }), inner);
});
