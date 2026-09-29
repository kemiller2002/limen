// A throwaway engine for the coordination pages: queues capability requests,
// hands back results and facts. Application meaning lives in main.js and
// peer.js, not here.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { coordinationCapability, COORDINATION_CAPABILITY, decodeCoordinationResult, decodeCoordinationFact } from "../../../../dist/capabilities/coordination/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

export const startEngine = async (onFact) => {
  const offer = { id: COORDINATION_CAPABILITY.id, version: COORDINATION_CAPABILITY.version, fingerprint: COORDINATION_CAPABILITY.fingerprint };
  const bridge = { queued: [], waiting: new Map(), sequence: 0, facts: [] };
  const engine = {
    start: async () => {},
    dispatch: async (message) => {
      if (message.kind === "Initialize") return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
      if (message.kind === "CapabilityFact") { const decoded = decodeCoordinationFact(message.fact); const fact = decoded.ok ? decoded.value : { kind: "Undecodable" }; bridge.facts.push(fact); onFact?.(fact); }
      if (message.kind === "EffectResult") bridge.waiting.get(message.result.correlationId)?.(message.result);
      const effects = bridge.queued;
      bridge.queued = [];
      return { view: {}, effects, cancellations: [] };
    },
  };
  const policy = trustedTypes.createPolicy("limen-coordination", { createScriptURL: (url) => { if (url !== "./hub.js") throw new TypeError(url); return new URL(url, location.href).href; } });
  await new BrowserKernel(engine, document, undefined, { capabilities: [coordinationCapability({ hub: { url: "./hub.js", scriptURL: (url) => policy.createScriptURL(url) } })], requireHandshake: true }).start();
  const ask = (request) => {
    bridge.sequence += 1;
    const effect = { kind: "Capability", correlationId: `c-${bridge.sequence}`, capability: offer.id, version: 1, request };
    const answered = new Promise((resolve) => bridge.waiting.set(effect.correlationId, resolve));
    bridge.queued = [...bridge.queued, effect];
    document.getElementById("poke").click();
    return answered.then((result) => { const decoded = result.outcome.kind === "Completed" ? decodeCoordinationResult(result.outcome.result) : { ok: false }; return decoded.ok ? decoded.value : { kind: "Undecodable", result }; });
  };
  const waitFor = async (predicate, ms = 5000) => {
    const deadline = Date.now() + ms;
    const poll = async () => (predicate() || Date.now() > deadline ? predicate() : (await new Promise((resolve) => setTimeout(resolve, 40)), poll()));
    return poll();
  };
  return { ask, facts: bridge.facts, waitFor };
};
