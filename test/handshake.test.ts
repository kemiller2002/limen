import assert from "node:assert/strict";
import test from "node:test";
// Kernel code from dist, as in kernel.test.ts: its runtime imports resolve only
// once built. The echo capability's generated binding is test-only source.
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { defineCapability, type CapabilityHost } from "../dist/kernel/capabilities.js";
import type { DiagnosticEvent } from "../dist/kernel/diagnostics.js";
import { verifyHandshake } from "../dist/kernel/handshake.js";
import { answerHandshake } from "../dist/guest/handshake.js";
import { CORE_CONTRACT_IDENTITY, PROTOCOL_MINOR, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EffectResult, type EngineHandshake, type EngineToBrowserMessage, type EngineTransport, type HostHandshake } from "../dist/protocol.js";
import { CAPABILITY_OFFER as ECHO, type EchoFact, type EchoRequest, type EchoResult } from "./fixtures/capabilities/generated/echo.ts";
import { decodeEchoRequest, decodeEchoResult } from "./fixtures/capabilities/generated/echo.codec.ts";
import { withDom } from "./dom-helpers.ts";

const CORE = { unit: CORE_CONTRACT_IDENTITY.unit, version: CORE_CONTRACT_IDENTITY.version, fingerprint: CORE_CONTRACT_IDENTITY.fingerprint };
const ECHO_ID = ECHO.id as CapabilityId;
const echoOffer = { id: ECHO_ID, version: ECHO.version, fingerprint: ECHO.fingerprint };
const hostOffer: HostHandshake = { protocol: { major: 1, minor: PROTOCOL_MINOR }, contract: CORE, capabilities: [echoOffer] };
const accepted = (capabilities = [echoOffer], contract = CORE, protocol = { major: 1, minor: 1 }): EngineHandshake =>
  ({ kind: "Accepted", protocol, contract, capabilities });

// ---------------------------------------------------------------------------
// The verdict is a pure function of offer and answer
// ---------------------------------------------------------------------------

test("an engine that accepts the offered contract and selects an offered capability is compatible", () => {
  assert.deepEqual(verifyHandshake(hostOffer, accepted(), false), { kind: "Compatible", negotiation: { kind: "Negotiated", protocol: { major: 1, minor: 1 }, capabilities: [echoOffer] } });
});

test("an engine that sends no handshake is a legacy engine, unless the host requires one", () => {
  assert.deepEqual(verifyHandshake(hostOffer, undefined, false), { kind: "Compatible", negotiation: { kind: "Legacy" } });
  assert.deepEqual(verifyHandshake(hostOffer, undefined, true), { kind: "Incompatible", reason: { kind: "handshake-required" } });
});

test("a contract fingerprint mismatch is incompatible, never optimistic", () => {
  const engine = { ...CORE, fingerprint: "sha256:0000" };
  assert.deepEqual(verifyHandshake(hostOffer, accepted([], engine), false), { kind: "Incompatible", reason: { kind: "contract-mismatch", host: CORE, engine } });
});

test("a different protocol major, or a newer minor than the host speaks, is incompatible; an older minor is not", () => {
  assert.equal(verifyHandshake(hostOffer, accepted([], CORE, { major: 2, minor: 0 }), false).kind, "Incompatible");
  assert.equal(verifyHandshake(hostOffer, accepted([], CORE, { major: 1, minor: PROTOCOL_MINOR + 1 }), false).kind, "Incompatible", "an engine newer than the host");
  assert.equal(verifyHandshake(hostOffer, accepted([], CORE, { major: 1, minor: 1 }), false).kind, "Compatible", "a 1.1 engine on a 1.2 host");
  assert.equal(verifyHandshake(hostOffer, accepted([], CORE, { major: 1, minor: 0 }), false).kind, "Compatible");
});

test("selecting a capability the host did not offer is incompatible", () => {
  const unknown = { id: "limen.fixture.nope" as CapabilityId, version: 1, fingerprint: "sha256:1" };
  assert.deepEqual(verifyHandshake(hostOffer, accepted([unknown]), false), { kind: "Incompatible", reason: { kind: "capability-not-offered", selected: unknown } });
});

test("selecting an offered capability at another version or fingerprint is incompatible", () => {
  const otherVersion = { ...echoOffer, version: 2 };
  const otherShape = { ...echoOffer, fingerprint: "sha256:ffff" };
  assert.deepEqual(verifyHandshake(hostOffer, accepted([otherVersion]), false).kind, "Incompatible");
  assert.deepEqual(verifyHandshake(hostOffer, accepted([otherShape]), false), { kind: "Incompatible", reason: { kind: "capability-mismatch", offered: echoOffer, selected: otherShape } });
});

test("selecting the same capability twice is incompatible", () => {
  assert.deepEqual(verifyHandshake(hostOffer, accepted([echoOffer, echoOffer]), false), { kind: "Incompatible", reason: { kind: "duplicate-capability", id: ECHO_ID } });
});

test("an engine's typed rejection is incompatible and carries its reason", () => {
  const rejection = { kind: "ContractMismatch" as const, expected: { ...CORE, fingerprint: "sha256:9" }, offered: CORE };
  assert.deepEqual(verifyHandshake(hostOffer, { kind: "Rejected", reason: rejection }, false), { kind: "Incompatible", reason: { kind: "engine-rejected", rejection } });
});

test("a malformed handshake is incompatible with the decoder's path, not a crash", () => {
  const verdict = verifyHandshake(hostOffer, { kind: "Accepted", protocol: { major: 1 } }, false);
  assert.equal(verdict.kind, "Incompatible");
  assert.equal(verdict.kind === "Incompatible" && verdict.reason.kind, "malformed-handshake");
});

// ---------------------------------------------------------------------------
// The kernel applies nothing from an engine until the handshake is verified
// ---------------------------------------------------------------------------

function respond(overrides: Partial<EngineToBrowserMessage> = {}): EngineToBrowserMessage {
  return { view: {}, effects: [], cancellations: [], ...overrides };
}

class ScriptedTransport implements EngineTransport {
  readonly calls: BrowserToEngineMessage[] = [];
  readonly handler: (message: BrowserToEngineMessage) => EngineToBrowserMessage;
  constructor(handler: (message: BrowserToEngineMessage) => EngineToBrowserMessage) { this.handler = handler; }
  async start(): Promise<void> {}
  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    this.calls.push(message);
    return this.handler(message);
  }
}

const flush = (ms = 0): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

type EchoHarness = { readonly hosts: CapabilityHost<EchoFact>[]; readonly executed: string[] };

// A capability pack registered from outside Core: its generated decoder is the
// only path from wire JSON to a typed request.
const echoCapability = (harness: EchoHarness) => defineCapability<EchoRequest, EchoResult, EchoFact>({
  offer: ECHO,
  decodeRequest: decodeEchoRequest,
  activate: (host) => { harness.hosts.push(host); },
  execute: async (request, context) => {
    harness.executed.push(request.operation);
    switch (request.operation) {
      case "echo": return { kind: "Echoed", text: request.text };
      case "announce": return { kind: "Announced" };
      case "wait":
        return await new Promise<EchoResult>((resolve) => {
          const timer = setTimeout(() => resolve({ kind: "Waited" }), request.ms);
          context.signal.addEventListener("abort", () => { clearTimeout(timer); resolve({ kind: "Cancelled" }); });
        });
    }
  },
});

const diagnostics = (): { readonly events: DiagnosticEvent[]; readonly sink: { report: (event: DiagnosticEvent) => void } } => {
  const events: DiagnosticEvent[] = [];
  return { events, sink: { report: (event) => { events.push(event); } } };
};

const echoEffect = (correlationId: string, request: unknown, version = 1) =>
  ({ kind: "Capability" as const, correlationId: correlationId as CorrelationId, capability: ECHO_ID, version, request });

const capabilityResults = (calls: readonly BrowserToEngineMessage[]): EffectResult[] =>
  calls.flatMap((call) => (call.kind === "EffectResult" && call.result.kind === "CapabilityResult" ? [call.result] : []));

test("Initialize offers the core contract and every registered capability", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability({ hosts: [], executed: [] })] }).start();
    const initialize = transport.calls[0];
    assert.equal(initialize?.kind, "Initialize");
    assert.deepEqual(initialize?.kind === "Initialize" && initialize.handshake, hostOffer);
  });
});

test("a legacy engine (no handshake) still runs, exactly as before protocol 1.1", async () => {
  const transport = new ScriptedTransport((message) => message.kind === "Initialize" ? respond({ view: { status: "ready" } }) : respond());
  await withDom(`<p data-text="status"></p>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal(document.querySelector("p")!.textContent, "ready");
  });
});

test("a fingerprint mismatch applies neither the view nor the effects, and later events are not dispatched", async () => {
  const { events, sink } = diagnostics();
  const transport = new ScriptedTransport((message) => message.kind === "Initialize"
    ? respond({
      view: { status: "should never render" },
      effects: [{ kind: "Storage", correlationId: "s1" as CorrelationId, operation: "get", key: "k" }],
      handshake: accepted([], { ...CORE, fingerprint: "sha256:stale" }),
    })
    : respond());
  await withDom(`<p data-text="status">initial</p><button data-event="go">Go</button>`, async (document) => {
    await new BrowserKernel(transport, document, sink).start();
    assert.equal(document.querySelector("p")!.textContent, "initial");
    document.querySelector("button")!.click();
    await flush();
    assert.equal(transport.calls.length, 1, "only Initialize ever reached the engine");
    const verdict = events.find((event) => event.kind === "Handshake");
    assert.equal(verdict?.kind === "Handshake" && verdict.verdict.kind, "Incompatible");
    assert.ok(events.some((event) => event.kind === "BridgeError" && event.phase === "protocol" && event.detail.includes("Incompatible")));
    // A compatibility failure is not an effect outcome: no EffectResult of any kind was produced.
    assert.equal(transport.calls.filter((call) => call.kind === "EffectResult").length, 0);
  });
});

test("a host that requires a handshake refuses a legacy engine before applying anything", async () => {
  const { events, sink } = diagnostics();
  const transport = new ScriptedTransport(() => respond({ view: { status: "legacy" } }));
  await withDom(`<p data-text="status">initial</p>`, async (document) => {
    await new BrowserKernel(transport, document, sink, { requireHandshake: true }).start();
    assert.equal(document.querySelector("p")!.textContent, "initial");
    assert.deepEqual(events.find((event) => event.kind === "Handshake"), { kind: "Handshake", verdict: { kind: "Incompatible", reason: { kind: "handshake-required" } } });
  });
});

test("a negotiated capability executes through its provider and the result returns correlated and typed", async () => {
  const harness: EchoHarness = { hosts: [], executed: [] };
  const transport = new ScriptedTransport((message) => message.kind === "Initialize"
    ? respond({ handshake: accepted(), effects: [echoEffect("e1", { operation: "echo", text: "hi" })] })
    : respond());
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability(harness)] }).start();
    await flush();
    const [result] = capabilityResults(transport.calls);
    assert.deepEqual(result, { kind: "CapabilityResult", correlationId: "e1", capability: ECHO_ID, version: 1, outcome: { kind: "Completed", result: { kind: "Echoed", text: "hi" } } });
    const typed = result?.kind === "CapabilityResult" && result.outcome.kind === "Completed" ? decodeEchoResult(result.outcome.result) : undefined;
    assert.deepEqual(typed, { ok: true, value: { kind: "Echoed", text: "hi" } });
  });
});

test("a capability the engine did not negotiate is answered Unsupported and never executed", async () => {
  const harness: EchoHarness = { hosts: [], executed: [] };
  const transport = new ScriptedTransport((message) => message.kind === "Initialize"
    ? respond({ handshake: accepted([]), effects: [echoEffect("e1", { operation: "echo", text: "hi" })] })
    : respond());
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability(harness)] }).start();
    await flush();
    assert.deepEqual(capabilityResults(transport.calls)[0]?.kind === "CapabilityResult" && capabilityResults(transport.calls)[0], { kind: "CapabilityResult", correlationId: "e1", capability: ECHO_ID, version: 1, outcome: { kind: "Unsupported", reason: "not-negotiated" } });
    assert.deepEqual(harness.executed, []);
    assert.deepEqual(harness.hosts, [], "an unselected capability is never activated");
  });
});

test("a legacy engine requesting any capability is answered Unsupported", async () => {
  const transport = new ScriptedTransport((message) => message.kind === "Initialize"
    ? respond({ effects: [echoEffect("e1", { operation: "echo", text: "hi" })] })
    : respond());
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability({ hosts: [], executed: [] })] }).start();
    await flush();
    const [result] = capabilityResults(transport.calls);
    assert.equal(result?.kind === "CapabilityResult" && result.outcome.kind, "Unsupported");
  });
});

test("a request at a version other than the negotiated one is answered version-unsupported", async () => {
  const transport = new ScriptedTransport((message) => message.kind === "Initialize"
    ? respond({ handshake: accepted(), effects: [echoEffect("e1", { operation: "echo", text: "hi" }, 2)] })
    : respond());
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability({ hosts: [], executed: [] })] }).start();
    await flush();
    const [result] = capabilityResults(transport.calls);
    assert.deepEqual(result?.kind === "CapabilityResult" && result.outcome, { kind: "Unsupported", reason: "version-unsupported" });
  });
});

test("a malformed capability payload is Rejected by the generated decoder and never executed", async () => {
  const harness: EchoHarness = { hosts: [], executed: [] };
  const { events, sink } = diagnostics();
  const transport = new ScriptedTransport((message) => message.kind === "Initialize"
    ? respond({ handshake: accepted(), effects: [echoEffect("e1", { operation: "echo", text: 42 }), echoEffect("e2", { operation: "shell", command: "rm" })] })
    : respond());
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, sink, { capabilities: [echoCapability(harness)] }).start();
    await flush();
    const outcomes = capabilityResults(transport.calls).map((result) => result.kind === "CapabilityResult" && result.outcome);
    assert.deepEqual(outcomes, [{ kind: "Rejected", reason: "malformed-request" }, { kind: "Rejected", reason: "malformed-request" }]);
    assert.deepEqual(harness.executed, []);
    assert.equal(events.filter((event) => event.kind === "BridgeError" && event.phase === "effect").length, 2);
  });
});

test("cancelling a capability effect aborts the provider, which reports its own Cancelled variant", async () => {
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ handshake: accepted(), effects: [echoEffect("slow", { operation: "wait", ms: 10_000 })] });
    if (message.kind === "Event") return respond({ cancellations: ["slow" as CorrelationId] });
    return respond();
  });
  await withDom(`<button data-event="cancel">Cancel</button>`, async (document) => {
    const started = new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability({ hosts: [], executed: [] })] }).start();
    await flush();
    document.querySelector("button")!.click();
    await started;
    await flush();
    const [result] = capabilityResults(transport.calls);
    assert.deepEqual(result?.kind === "CapabilityResult" && result.outcome, { kind: "Completed", result: { kind: "Cancelled" } });
  });
});

test("a negotiated capability can emit facts; they reach the engine as CapabilityFact", async () => {
  const harness: EchoHarness = { hosts: [], executed: [] };
  const transport = new ScriptedTransport((message) => message.kind === "Initialize" ? respond({ handshake: accepted() }) : respond());
  await withDom(`<p></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [echoCapability(harness)] }).start();
    assert.equal(harness.hosts.length, 1, "activated once, after negotiation");
    harness.hosts[0]!.emitFact({ text: "tick" });
    await flush();
    assert.deepEqual(transport.calls.at(-1), { kind: "CapabilityFact", capability: ECHO_ID, version: 1, fact: { text: "tick" } });
  });
});

test("a handshake in a response to anything but Initialize is a protocol violation and is not applied", async () => {
  const { events, sink } = diagnostics();
  const transport = new ScriptedTransport((message) => message.kind === "Initialize"
    ? respond({ handshake: accepted([]), view: { status: "ready" } })
    : respond({ handshake: accepted([]), view: { status: "hijacked" } }));
  await withDom(`<p data-text="status"></p><button data-event="go">Go</button>`, async (document) => {
    await new BrowserKernel(transport, document, sink).start();
    document.querySelector("button")!.click();
    await flush();
    assert.equal(document.querySelector("p")!.textContent, "ready");
    assert.ok(events.some((event) => event.kind === "BridgeError" && event.phase === "protocol" && event.detail.includes("handshake")));
  });
});

test("registering the same capability twice is a configuration error", () => {
  const provider = echoCapability({ hosts: [], executed: [] });
  assert.throws(() => new BrowserKernel(new ScriptedTransport(() => respond()), {} as Document, undefined, { capabilities: [provider, provider] }), /registered more than once/);
});

test("start() twice is refused rather than re-binding", async () => {
  const { events, sink } = diagnostics();
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<button data-event="go">Go</button>`, async (document) => {
    const kernel = new BrowserKernel(transport, document, sink);
    await kernel.start();
    await kernel.start();
    assert.equal(transport.calls.length, 1);
    assert.ok(events.some((event) => event.kind === "BridgeError" && event.phase === "protocol"));
  });
});

// ---------------------------------------------------------------------------
// The engine's half: a new engine meeting an old kernel refuses, typed
// ---------------------------------------------------------------------------

const engineNeeds = { protocol: { major: 1, minor: 1 }, contract: CORE, required: [echoOffer], optional: [] };

test("new engine / old kernel: an Initialize with no handshake is refused as HandshakeMissing", () => {
  assert.deepEqual(answerHandshake(undefined, engineNeeds), { kind: "Rejected", reason: { kind: "HandshakeMissing" } });
});

test("the engine refuses a host missing a required capability, and a host on another contract", () => {
  assert.deepEqual(answerHandshake({ ...hostOffer, capabilities: [] }, engineNeeds), { kind: "Rejected", reason: { kind: "CapabilityUnavailable", id: ECHO_ID, version: 1 } });
  const other = { ...CORE, fingerprint: "sha256:other" };
  assert.deepEqual(answerHandshake({ ...hostOffer, contract: other }, engineNeeds), { kind: "Rejected", reason: { kind: "ContractMismatch", expected: CORE, offered: other } });
});

test("the engine selects required capabilities and only the optional ones actually offered", () => {
  const extra = { id: "limen.fixture.other" as CapabilityId, version: 1, fingerprint: "sha256:2" };
  assert.deepEqual(answerHandshake(hostOffer, { ...engineNeeds, required: [], optional: [echoOffer, extra] }), accepted([echoOffer]));
});

test("an engine answer and a host verdict agree end to end", () => {
  assert.equal(verifyHandshake(hostOffer, answerHandshake(hostOffer, engineNeeds), true).kind, "Compatible");
  assert.equal(verifyHandshake(hostOffer, answerHandshake(undefined, engineNeeds), true).kind, "Incompatible");
});
