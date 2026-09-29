// The measurement pack's real-browser scenarios: real ResizeObserver,
// IntersectionObserver and DOM removal through a projection, observed as the
// engine hears them (results and facts, decoded with the generated decoders).
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { measureCapability, MEASURE_CAPABILITY, decodeMeasureFact, decodeMeasureResult } from "../../../../dist/capabilities/measure/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: MEASURE_CAPABILITY.id, version: MEASURE_CAPABILITY.version, fingerprint: MEASURE_CAPABILITY.fingerprint };
const state = { view: { rows: [{ id: "a" }, { id: "b" }] }, queued: [], results: [], facts: [], sequence: 0 };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: state.view, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    if (message.kind === "EffectResult") {
      const decoded = message.result.outcome.kind === "Completed" ? decodeMeasureResult(message.result.outcome.result) : { ok: false };
      state.results.push(decoded.ok ? decoded.value : { kind: "Outcome:" + message.result.outcome.kind });
      return { view: state.view, effects: [], cancellations: [] };
    }
    if (message.kind === "CapabilityFact") {
      const decoded = decodeMeasureFact(message.fact);
      state.facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" });
      return { view: state.view, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => ({ kind: "Capability", correlationId: "m" + (state.sequence += 1), capability: offer.id, version: 1, request }));
    state.queued = [];
    return { view: state.view, effects, cancellations: [] };
  },
};

const until = async (predicate, ms = 3000) => {
  const deadline = performance.now() + ms;
  while (!predicate() && performance.now() < deadline) await new Promise((resolve) => requestAnimationFrame(resolve));
  return predicate();
};
const ask = async (requests) => {
  const before = state.results.length;
  state.queued = requests;
  document.getElementById("next").click();
  await until(() => state.results.length >= before + requests.length);
  return state.results.slice(before);
};
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [measureCapability()], requireHandshake: true }).start();

const [measured, viewport] = await ask([{ operation: "measure", target: { name: "box" } }, { operation: "viewport" }]);
expect("measure returns the real rectangle", measured.kind === "Measured" && measured.rect.width === 100 && measured.rect.height === 40, measured);
expect("viewport returns size, scroll extent and pixel ratio", viewport.kind === "ViewportMeasured" && viewport.viewport.width > 0 && viewport.viewport.scrollHeight > 6000 && viewport.viewport.devicePixelRatio > 0, viewport);

const [size] = await ask([{ operation: "observeSize", target: { name: "box" } }]);
await until(() => state.facts.some((fact) => fact.kind === "Resized" && fact.subscription === size.subscription));
document.getElementById("box").style.width = "250px";
const resized = await until(() => state.facts.some((fact) => fact.kind === "Resized" && fact.subscription === size.subscription && fact.width === 250));
expect("a real resize arrives as a Resized fact", size.kind === "Subscribed" && resized, state.facts);

const [seen] = await ask([{ operation: "observeVisibility", target: { name: "far" }, threshold: 0.5 }]);
await until(() => state.facts.some((fact) => fact.kind === "Visibility" && fact.subscription === seen.subscription));
const hiddenFirst = state.facts.filter((fact) => fact.kind === "Visibility" && fact.subscription === seen.subscription).at(-1);
document.getElementById("far").scrollIntoView({ block: "center" });
const entered = await until(() => state.facts.some((fact) => fact.kind === "Visibility" && fact.subscription === seen.subscription && fact.intersecting));
window.scrollTo(0, 0);
const left = await until(() => state.facts.filter((fact) => fact.kind === "Visibility" && fact.subscription === seen.subscription).at(-1)?.intersecting === false);
expect("intersection: starts hidden, enters when scrolled into view, leaves when scrolled away", hiddenFirst?.intersecting === false && entered && left, state.facts.filter((fact) => fact.kind === "Visibility"));

const [rowB] = await ask([{ operation: "observeSize", target: { name: "row", key: "b" } }]);
await until(() => state.facts.some((fact) => fact.kind === "Resized" && fact.subscription === rowB.subscription));
state.view = { rows: [{ id: "a" }] };
await ask([{ operation: "viewport" }]);
const removed = await until(() => state.facts.some((fact) => fact.kind === "TargetRemoved" && fact.subscription === rowB.subscription));
await new Promise((resolve) => setTimeout(resolve, 100));
const afterRemoval = state.facts.slice(state.facts.findIndex((fact) => fact.kind === "TargetRemoved" && fact.subscription === rowB.subscription) + 1).filter((fact) => fact.subscription === rowB.subscription);
expect("removing a row through the projection ends its subscription with one TargetRemoved, then silence", removed && afterRemoval.length === 0, state.facts.filter((fact) => fact.subscription === rowB.subscription));

const [unsubscribed, again] = await ask([{ operation: "unsubscribe", subscription: size.subscription }, { operation: "unsubscribe", subscription: size.subscription }]);
const factsBefore = state.facts.length;
document.getElementById("box").style.width = "300px";
await new Promise((resolve) => setTimeout(resolve, 150));
expect("unsubscribe ends facts; a second unsubscribe is Stale(disposed)", unsubscribed.kind === "Unsubscribed" && again.kind === "Stale" && again.reason === "disposed" && state.facts.length === factsBefore, { unsubscribed, again, newFacts: state.facts.slice(factsBefore) });

expect("every result and fact survives a JSON round trip unchanged", JSON.stringify(JSON.parse(JSON.stringify([state.results, state.facts]))) === JSON.stringify([state.results, state.facts]), null);

window.__limenPackResult = { pack: "limen.measure", checks };
