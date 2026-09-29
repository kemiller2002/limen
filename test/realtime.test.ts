// The realtime and streaming pack (kemiller2002/limen#26, LCP-016). Scripted
// WebSocket and EventSource classes on the jsdom window drive the lifecycle
// deterministically: connect, message, close, explicit cancel, a replacement
// connection rejecting the old one's messages, and no reconnect unless the
// engine asks. Real sockets and a real event stream are proven in Chromium
// (test/browser/packs/realtime/).

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import {
  REALTIME_CAPABILITY, decodeRealtimeFact, decodeRealtimeResult, realtimeCapability, type ConnectionId, type RealtimeFact, type RealtimeRequest, type RealtimeResult,
} from "../dist/capabilities/realtime/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineTransport } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const offer = { id: REALTIME_CAPABILITY.id as CapabilityId, version: REALTIME_CAPABILITY.version, fingerprint: REALTIME_CAPABILITY.fingerprint };

// ---------------------------------------------------------------------------
// Scripted transports: every instance is recorded; the test plays the server
// ---------------------------------------------------------------------------

type Listener = (event: Record<string, unknown>) => void;
type Scripted = {
  readonly kind: "ws" | "sse";
  readonly url: string;
  readonly options: unknown;
  readyState: number;
  readonly sent: string[];
  closed: { code?: number; reason?: string } | undefined;
  readonly fire: (type: string, fields?: Record<string, unknown>) => void;
  readonly listening: () => readonly string[];
};
const instances: Scripted[] = [];

const scripted = (kind: "ws" | "sse") => class {
  readonly #record: Scripted;
  readonly #listeners = new Map<string, Listener[]>();
  binaryType = "blob";
  protocol = "";
  bufferedAmount = 0;
  constructor(url: string, options: unknown) {
    const listeners = this.#listeners;
    const record: Scripted = {
      kind, url, options, readyState: 0, sent: [], closed: undefined,
      fire: (type, fields = {}) => {
        if (type === "open") record.readyState = 1;
        if (type === "close") record.readyState = 3;
        (listeners.get(type) ?? []).forEach((listener) => listener({ type, ...fields }));
      },
      listening: () => Array.from(listeners.keys()),
    };
    this.#record = record;
    instances.push(record);
  }
  get readyState(): number { return this.#record.readyState; }
  addEventListener(type: string, listener: Listener): void { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]); }
  send(text: string): void { this.#record.sent.push(text); this.bufferedAmount += text.length; }
  close(code?: number, reason?: string): void {
    if (this.#record.closed === undefined) this.#record.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    this.#record.readyState = 2;
  }
};

const install = (document: Document): void => {
  const view = document.defaultView;
  assert.ok(view !== null);
  Reflect.set(view, "WebSocket", scripted("ws"));
  Reflect.set(view, "EventSource", scripted("sse"));
};

type Provider = ReturnType<typeof realtimeCapability>;
type Harness = { readonly ask: (request: RealtimeRequest) => Promise<RealtimeResult>; readonly facts: RealtimeFact[]; readonly document: Document };

const withProvider = async (act: (harness: Harness) => Promise<void>, installTransports = true): Promise<void> => {
  instances.length = 0;
  await withDom("<p>realtime</p>", async (document) => {
    if (installTransports) install(document);
    const facts: RealtimeFact[] = [];
    const provider: Provider = realtimeCapability();
    provider.activate({ document, emitFact: (fact) => {
      const decoded = decodeRealtimeFact(fact);
      assert.ok(decoded.ok, "every fact decodes with the generated decoder");
      assert.deepEqual(JSON.parse(JSON.stringify(fact)), fact, "every fact is plain JSON");
      facts.push(decoded.value);
    } });
    const ask = async (request: RealtimeRequest): Promise<RealtimeResult> => {
      const answer = await provider.execute(request, { correlationId: "r" as CorrelationId, signal: new AbortController().signal, document });
      const decoded = answer.kind === "Completed" ? decodeRealtimeResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true, "every result decodes with the generated decoder");
      return decoded.value;
    };
    await act({ ask, facts, document });
  });
};

const opened = (result: RealtimeResult): ConnectionId => {
  assert.equal(result.kind, "Connecting");
  return result.kind === "Connecting" ? result.connection : ("" as ConnectionId);
};
const socket = (index: number): Scripted => {
  const found = instances[index];
  assert.ok(found !== undefined, `connection ${index}`);
  return found;
};

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

test("connect, message, close: every step is a fact under the connection's id, ending with exactly one Closed", async () => {
  await withProvider(async ({ ask, facts }) => {
    const id = opened(await ask({ operation: "openWebSocket", url: "/live", protocols: ["chat.v1"] }));
    assert.deepEqual([socket(0).url, socket(0).options], ["ws://localhost/live", ["chat.v1"]], "relative http URLs resolve to ws against the page");
    assert.deepEqual(await ask({ operation: "send", connection: id, text: "early" }), { kind: "NotOpen", state: "connecting" });
    socket(0).fire("open");
    assert.deepEqual(await ask({ operation: "send", connection: id, text: "hello" }), { kind: "Sent", bufferedAmount: 5 });
    socket(0).fire("message", { data: "{\"not\":\"interpreted\"}" });
    socket(0).fire("message", { data: new ArrayBuffer(12) });
    socket(0).fire("close", { code: 1001, reason: "going away", wasClean: true });
    socket(0).fire("message", { data: "after close" });
    assert.deepEqual(facts, [
      { kind: "Opened", connection: id, protocol: "" },
      { kind: "Message", connection: id, data: "{\"not\":\"interpreted\"}" },
      { kind: "BinaryMessage", connection: id, bytes: 12 },
      { kind: "Closed", connection: id, initiator: "remote", code: 1001, reason: "going away", clean: true },
    ]);
    assert.deepEqual(socket(0).sent, ["hello"]);
    assert.deepEqual(await ask({ operation: "send", connection: id, text: "late" }), { kind: "Stale", reason: "disposed" });
  });
});

test("a failed connection ends with Closed from error, and the pack does not try again", async () => {
  await withProvider(async ({ ask, facts }) => {
    const id = opened(await ask({ operation: "openWebSocket", url: "wss://example.test/live", protocols: [] }));
    socket(0).fire("error");
    socket(0).fire("close", { code: 1006, reason: "", wasClean: false });
    assert.deepEqual(facts, [{ kind: "Closed", connection: id, initiator: "error", code: 1006, reason: "", clean: false }]);
    assert.equal(instances.length, 1, "no reconnect");
  });
});

test("explicit close: answered Closed, the socket is closed with the engine's code, and nothing more is heard — not even queued messages", async () => {
  await withProvider(async ({ ask, facts }) => {
    const id = opened(await ask({ operation: "openWebSocket", url: "ws://example.test/", protocols: [] }));
    socket(0).fire("open");
    assert.deepEqual(await ask({ operation: "close", connection: id, code: 4000, reason: "replaced" }), { kind: "Closed" });
    assert.deepEqual(socket(0).closed, { code: 4000, reason: "replaced" });
    socket(0).fire("message", { data: "already queued" });
    socket(0).fire("close", { code: 4000, reason: "replaced", wasClean: true });
    assert.deepEqual(facts, [{ kind: "Opened", connection: id, protocol: "" }]);
    assert.deepEqual(await ask({ operation: "close", connection: id }), { kind: "Stale", reason: "disposed" });
    assert.deepEqual(await ask({ operation: "close", connection: "elsewhere.1" as ConnectionId }), { kind: "Stale", reason: "other-session" });
  });
});

test("a replacement connection: the engine closes the old id and opens a new one; the old one's late messages are rejected by identity", async () => {
  await withProvider(async ({ ask, facts }) => {
    const first = opened(await ask({ operation: "openWebSocket", url: "ws://example.test/", protocols: [] }));
    socket(0).fire("open");
    await ask({ operation: "close", connection: first });
    const second = opened(await ask({ operation: "openWebSocket", url: "ws://example.test/", protocols: [] }));
    socket(1).fire("open");
    socket(0).fire("message", { data: "stale" });
    socket(1).fire("message", { data: "fresh" });
    assert.notEqual(first, second, "ids are never reused");
    assert.deepEqual(facts.map((fact) => [fact.kind, fact.connection === first ? "first" : "second", fact.kind === "Message" ? fact.data : ""]), [
      ["Opened", "first", ""], ["Opened", "second", ""], ["Message", "second", "fresh"],
    ]);
  });
});

test("close codes outside 1000 and 3000–4999 are refused before the browser throws; bad URLs are named by scheme only", async () => {
  await withProvider(async ({ ask }) => {
    const id = opened(await ask({ operation: "openWebSocket", url: "ws://example.test/", protocols: [] }));
    assert.deepEqual(await ask({ operation: "close", connection: id, code: 1001 }), { kind: "InvalidCloseCode" });
    assert.deepEqual(await ask({ operation: "openWebSocket", url: "javascript:alert(document.cookie)", protocols: [] }), { kind: "InvalidUrl", scheme: "javascript" });
    assert.deepEqual(await ask({ operation: "openEventSource", url: "ws://example.test/", withCredentials: false, events: [] }), { kind: "InvalidUrl", scheme: "ws" });
    assert.deepEqual(await ask({ operation: "openWebSocket", url: "http://[bad", protocols: [] }), { kind: "InvalidUrl", scheme: "" });
    assert.equal(instances.length, 1, "nothing was constructed for a refused URL");
  });
});

// ---------------------------------------------------------------------------
// Server-Sent Events
// ---------------------------------------------------------------------------

test("event streams: unnamed and listed named events arrive as Message; a stream is receive-only", async () => {
  await withProvider(async ({ ask, facts }) => {
    const id = opened(await ask({ operation: "openEventSource", url: "/events", withCredentials: true, events: ["price", "message"] }));
    assert.deepEqual([socket(0).url, socket(0).options], ["http://localhost/events", { withCredentials: true }]);
    assert.deepEqual([...socket(0).listening()].sort(), ["error", "message", "open", "price"]);
    socket(0).fire("open");
    socket(0).fire("message", { data: "tick", lastEventId: "" });
    socket(0).fire("price", { data: "42", lastEventId: "7" });
    assert.deepEqual(await ask({ operation: "send", connection: id, text: "x" }), { kind: "NotSendable" });
    assert.deepEqual(facts, [
      { kind: "Opened", connection: id, protocol: "" },
      { kind: "Message", connection: id, data: "tick" },
      { kind: "Message", connection: id, data: "42", event: "price", lastEventId: "7" },
    ]);
  });
});

test("a dropped event stream does not retry on its own: the pack closes it and reports Closed; the engine reconnects by asking", async () => {
  await withProvider(async ({ ask, facts }) => {
    const first = opened(await ask({ operation: "openEventSource", url: "/events", withCredentials: false, events: [] }));
    socket(0).fire("open");
    socket(0).readyState = 0; // the browser is about to retry
    socket(0).fire("error");
    assert.ok(socket(0).closed !== undefined, "the native retry was stopped");
    socket(0).fire("message", { data: "from a retry", lastEventId: "" });
    assert.deepEqual(facts, [
      { kind: "Opened", connection: first, protocol: "" },
      { kind: "Closed", connection: first, initiator: "error", code: 0, reason: "", clean: false },
    ]);
    const second = opened(await ask({ operation: "openEventSource", url: "/events", withCredentials: false, events: [] }));
    assert.notEqual(first, second);
    assert.equal(instances.length, 2, "exactly one reconnect: the one the engine asked for");
  });
});

// ---------------------------------------------------------------------------
// Absence, cancellation, the kernel, conformance
// ---------------------------------------------------------------------------

test("a browser without WebSocket or EventSource answers Unsupported", async () => {
  await withProvider(async ({ ask, document }) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    Reflect.set(view, "WebSocket", undefined);
    Reflect.set(view, "EventSource", undefined);
    assert.deepEqual(await ask({ operation: "openWebSocket", url: "ws://example.test/", protocols: [] }), { kind: "Unsupported" });
    assert.deepEqual(await ask({ operation: "openEventSource", url: "/events", withCredentials: false, events: [] }), { kind: "Unsupported" });
  });
});

test("a request the engine cancelled before it ran opens nothing", async () => {
  await withProvider(async ({ document }) => {
    const aborted = new AbortController();
    aborted.abort();
    const answer = await realtimeCapability().execute({ operation: "openWebSocket", url: "ws://example.test/", protocols: [] }, { correlationId: "c" as CorrelationId, signal: aborted.signal, document });
    assert.deepEqual(answer, { kind: "Completed", result: { kind: "Cancelled" } });
    assert.equal(instances.length, 0);
  });
});

test("through the kernel, facts reach only an engine that selected the pack", async () => {
  const run = async (select: boolean): Promise<readonly unknown[]> => {
    instances.length = 0;
    const heard: unknown[] = [];
    const transport: EngineTransport = {
      start: async () => {},
      dispatch: async (message: BrowserToEngineMessage) => {
        if (message.kind === "CapabilityFact") heard.push(message.fact);
        return {
          view: {}, cancellations: [],
          effects: message.kind === "Initialize" && select ? [{ kind: "Capability", correlationId: "r1" as CorrelationId, capability: offer.id, version: 1, request: { operation: "openWebSocket", url: "ws://example.test/", protocols: [] } }] : [],
          ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: select ? [offer] : [] } } : {}),
        };
      },
    };
    return withDom("<p>realtime</p>", async (document) => {
      install(document);
      await new BrowserKernel(transport, document, undefined, { capabilities: [realtimeCapability()], requireHandshake: true }).start();
      instances.forEach((instance) => instance.fire("open"));
      return [...heard];
    });
  };
  const selected = await run(true);
  assert.equal(selected.length, 1);
  assert.equal((selected[0] as { kind: string }).kind, "Opened");
  assert.deepEqual(await run(false), []);
});

test("the realtime pack passes the shared provider conformance suite", async () => {
  await withDom("<p>realtime</p>", async (document) => {
    install(document);
    assert.deepEqual(await runProviderConformance(realtimeCapability(), {
      document,
      decodeResult: decodeRealtimeResult,
      valid: [{ name: "openWebSocket", payload: { operation: "openWebSocket", url: "ws://example.test/", protocols: [] } }, { name: "close stale", payload: { operation: "close", connection: "x.1" } }],
      malformed: [
        { name: "no protocols", payload: { operation: "openWebSocket", url: "ws://example.test/" } },
        { name: "binary send", payload: { operation: "send", connection: "x.1", text: 7 } },
        { name: "extra field", payload: { operation: "close", connection: "x.1", socket: {} } },
      ],
      cancellable: { name: "openWebSocket", payload: { operation: "openWebSocket", url: "ws://example.test/", protocols: [] } },
    }), []);
  });
});
