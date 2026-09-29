// The realtime pack's real-browser scenarios against the runner's same-origin
// endpoints (test/browser/servers/realtime.ts). The engine is a scripted
// stand-in: it queues requests, the page clicks, and answers and facts are
// collected. scripts/smoke-packs.ts reads window.__limenPackResult.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { realtimeCapability, REALTIME_CAPABILITY, decodeRealtimeResult, decodeRealtimeFact } from "../../../../dist/capabilities/realtime/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: REALTIME_CAPABILITY.id, version: REALTIME_CAPABILITY.version, fingerprint: REALTIME_CAPABILITY.fingerprint };
const state = { queued: [], answers: [], facts: [], waiting: null, sequence: 0, undecodable: 0 };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "CapabilityFact") {
      const decoded = decodeRealtimeFact(message.fact);
      if (decoded.ok) state.facts.push(decoded.value); else state.undecodable += 1;
      return { view: {}, effects: [], cancellations: [] };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeRealtimeResult(outcome.result) : { ok: false };
      state.answers.push(decoded.ok ? decoded.value : { kind: "Outcome:" + outcome.kind });
      if (state.waiting !== null && state.answers.length >= state.waiting.count) {
        const { resolve } = state.waiting;
        state.waiting = null;
        resolve(state.answers.splice(0));
      }
      return { view: {}, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => {
      state.sequence += 1;
      return { kind: "Capability", correlationId: "rt-" + state.sequence, capability: offer.id, version: 1, request };
    });
    state.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};

const ask = (...requests) => new Promise((resolve) => {
  state.queued = requests;
  state.waiting = { count: requests.length, resolve };
  document.getElementById("poke").click();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits until the facts for a connection satisfy `done`, or 3 s.
const factsFor = async (connection, done) => {
  const deadline = Date.now() + 3000;
  const mine = () => state.facts.filter((fact) => fact.connection === connection);
  while (!done(mine()) && Date.now() < deadline) await sleep(20);
  return mine();
};
const kinds = (facts) => facts.map((fact) => fact.kind + (fact.kind === "Message" ? ":" + fact.data : ""));

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [realtimeCapability()], requireHandshake: true }).start();

// --- WebSocket: connect, message, close ------------------------------------
const [connecting] = await ask({ operation: "openWebSocket", url: "/__limen/ws", protocols: ["limen.test"] });
const socket = connecting.connection;
const openFacts = await factsFor(socket, (facts) => facts.some((fact) => fact.kind === "Opened"));
expect("a relative URL connects a real WebSocket; Opened reports the subprotocol the server chose", connecting.kind === "Connecting" && openFacts[0]?.kind === "Opened" && openFacts[0].protocol === "limen.test", { connecting, openFacts });

const [sent, binary] = await ask({ operation: "send", connection: socket, text: "hello, {\"json\":\"is just text\"}" }, { operation: "send", connection: socket, text: "binary" });
const echoed = await factsFor(socket, (facts) => facts.some((fact) => fact.kind === "BinaryMessage"));
expect("sent text is echoed back as a Message, uninterpreted", sent.kind === "Sent" && echoed.some((fact) => fact.kind === "Message" && fact.data === "hello, {\"json\":\"is just text\"}"), { sent, echoed });
expect("a binary frame is reported by size only", binary.kind === "Sent" && echoed.some((fact) => fact.kind === "BinaryMessage" && fact.bytes === 5), echoed);

await ask({ operation: "send", connection: socket, text: "close-me" });
const remote = await factsFor(socket, (facts) => facts.some((fact) => fact.kind === "Closed"));
const closedFact = remote.find((fact) => fact.kind === "Closed");
expect("a server close ends with exactly one Closed from the remote, with its code and reason", remote.filter((fact) => fact.kind === "Closed").length === 1 && closedFact?.initiator === "remote" && closedFact.code === 4001 && closedFact.reason === "server said so" && closedFact.clean, closedFact);
const [afterRemote] = await ask({ operation: "send", connection: socket, text: "late" });
expect("the id is Stale after Closed", afterRemote.kind === "Stale" && afterRemote.reason === "disposed", afterRemote);

// --- Explicit cancel, and a replacement connection -------------------------
const [first] = await ask({ operation: "openWebSocket", url: "/__limen/ws", protocols: [] });
await factsFor(first.connection, (facts) => facts.some((fact) => fact.kind === "Opened"));
// Ask for an echo and close in the same breath: the echo is in flight when the
// engine closes, and must never be heard.
const [inFlight, closed] = await ask({ operation: "send", connection: first.connection, text: "in flight" }, { operation: "close", connection: first.connection, code: 4000, reason: "replaced" });
const [second] = await ask({ operation: "openWebSocket", url: "/__limen/ws", protocols: [] });
await factsFor(second.connection, (facts) => facts.some((fact) => fact.kind === "Opened"));
await ask({ operation: "send", connection: second.connection, text: "fresh" });
const fresh = await factsFor(second.connection, (facts) => facts.some((fact) => fact.kind === "Message"));
await sleep(200);
const firstFacts = state.facts.filter((fact) => fact.connection === first.connection);
expect("explicit close is answered Closed; nothing more is heard for that id, not even the echo already in flight", inFlight.kind === "Sent" && closed.kind === "Closed" && kinds(firstFacts).join() === "Opened", { inFlight, closed, firstFacts: kinds(firstFacts) });
expect("the replacement connection has a new id and hears only its own messages", second.connection !== first.connection && kinds(fresh).join() === "Opened,Message:fresh", kinds(fresh));
await ask({ operation: "close", connection: second.connection });

const [refused] = await ask({ operation: "openWebSocket", url: "javascript:alert(1)", protocols: [] });
expect("a non-network URL is refused by scheme, and nothing is constructed", refused.kind === "InvalidUrl" && refused.scheme === "javascript", refused);

// --- Server-Sent Events: messages, and no reconnect of its own -------------
const count = async (stream) => (await (await fetch("/__limen/sse-count?stream=" + stream)).json()).count;
const [stream] = await ask({ operation: "openEventSource", url: "/__limen/sse?stream=a", withCredentials: false, events: ["price"] });
const streamed = await factsFor(stream.connection, (facts) => facts.some((fact) => fact.kind === "Closed"));
expect("an event stream reports Opened, the unnamed and the listed named events (not unlisted ones), then Closed when it drops", kinds(streamed).join() === "Opened,Message:tick,Message:42,Closed" && streamed[2].event === "price" && streamed[2].lastEventId === "7" && streamed[3].initiator === "error", streamed);
await sleep(500);
expect("with a 50 ms retry hint, the browser's own reconnect never happened: one connection in 500 ms", (await count("a")) === 1, await count("a"));

const [again] = await ask({ operation: "openEventSource", url: "/__limen/sse?stream=a", withCredentials: false, events: [] });
await factsFor(again.connection, (facts) => facts.some((fact) => fact.kind === "Closed"));
expect("reconnection happens when the engine asks, under a new id", again.kind === "Connecting" && again.connection !== stream.connection && (await count("a")) === 2, { again, count: await count("a") });

const [send] = await ask({ operation: "send", connection: again.connection, text: "x" });
expect("every answer and fact decoded with the generated decoders", state.undecodable === 0 && send.kind === "Stale", { undecodable: state.undecodable, send });

window.__limenPackResult = { pack: "limen.realtime", checks };
