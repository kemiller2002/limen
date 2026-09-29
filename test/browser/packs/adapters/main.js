// The adapters pack's real-browser scenarios: a real custom element (shadow
// DOM, built without HTML strings) behind the reference Web Component
// adapter, an SVG chart widget stub behind a hand-written adapter, and a
// faulty adapter — all under a strict CSP with Trusted Types.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { adaptersCapability, defineAdapter, ADAPTERS_CAPABILITY, decodeAdaptersResult, decodeAdaptersFact } from "../../../../dist/capabilities/adapters/index.js";
import { webComponentAdapter } from "../../../../dist/capabilities/adapters/web-component.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

// --- A real custom element: a star rating ------------------------------------
customElements.define("limen-rating", class extends HTMLElement {
  #value = 0;
  #max = 5;
  #root = this.attachShadow({ mode: "open" });
  set value(value) { this.#value = value; this.#render(); }
  get value() { return this.#value; }
  set max(max) { this.#max = max; this.#render(); }
  get max() { return this.#max; }
  bump(by) { this.value = Math.min(this.#max, this.#value + by); return this.#value; }
  #render() {
    this.#root.replaceChildren(...Array.from({ length: this.#max }, (_, index) => {
      const star = document.createElement("button");
      star.textContent = index < this.#value ? "★" : "☆";
      star.setAttribute("aria-label", `${index + 1} stars`);
      star.addEventListener("click", () => {
        this.value = index + 1;
        this.dispatchEvent(new CustomEvent("change", { detail: { value: index + 1 } }));
      });
      return star;
    }));
  }
});

// --- A complex widget stub: an SVG bar chart ---------------------------------
const SVG = "http://www.w3.org/2000/svg";
const chart = defineAdapter({
  id: "chart",
  version: 3,
  mount: ({ slot, emit }, props) => {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("width", "300");
    svg.setAttribute("height", "100");
    const state = { highlighted: null };
    const render = ({ series }) => {
      svg.replaceChildren(...series.map((point, index) => {
        const bar = document.createElementNS(SVG, "rect");
        bar.setAttribute("x", String(index * 40));
        bar.setAttribute("y", String(100 - point.value));
        bar.setAttribute("width", "30");
        bar.setAttribute("height", String(point.value));
        bar.setAttribute("data-label", point.label);
        bar.setAttribute("fill", point.label === state.highlighted ? "orange" : "steelblue");
        bar.addEventListener("click", () => emit("barSelected", { label: point.label, value: point.value }));
        return bar;
      }));
    };
    render(props);
    slot.append(svg);
    return {
      update: render,
      commands: { highlight: (label) => { state.highlighted = label; svg.querySelectorAll("rect").forEach((bar) => bar.setAttribute("fill", bar.getAttribute("data-label") === label ? "orange" : "steelblue")); return { highlighted: label }; } },
      unmount: () => svg.remove(),
    };
  },
});
const faulty = defineAdapter({
  id: "faulty", version: 1,
  mount: ({ slot, emit }) => {
    slot.append(document.createTextNode("faulty"));
    return { update: () => { throw new RangeError("internal detail"); }, commands: { leak: () => { emit("node", document.body); return null; } }, unmount: () => {} };
  },
});
const rating = webComponentAdapter({ id: "rating", version: 1, tagName: "limen-rating", properties: ["value", "max"], events: { change: "rated" }, commands: { bump: "bump" } });

// --- The scripted engine -------------------------------------------------------
const offer = { id: ADAPTERS_CAPABILITY.id, version: ADAPTERS_CAPABILITY.version, fingerprint: ADAPTERS_CAPABILITY.fingerprint };
const state = { view: { panelOpen: false, clicks: "0" }, queued: [], answers: new Map(), facts: [], waiting: null, sequence: 0, undecodable: 0, pokes: 0 };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: state.view, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    }
    if (message.kind === "CapabilityFact") {
      const decoded = decodeAdaptersFact(message.fact);
      if (decoded.ok) state.facts.push(decoded.value); else state.undecodable += 1;
      return { view: state.view, effects: [], cancellations: [] };
    }
    if (message.kind === "EffectResult") {
      const outcome = message.result.outcome;
      const decoded = outcome.kind === "Completed" ? decodeAdaptersResult(outcome.result) : { ok: false };
      if (!decoded.ok) state.undecodable += 1;
      state.answers.set(message.result.correlationId, decoded.ok ? decoded.value : { kind: "Outcome:" + outcome.kind });
      if (state.waiting !== null && state.waiting.ids.every((id) => state.answers.has(id))) {
        const { ids, resolve } = state.waiting;
        state.waiting = null;
        resolve(ids.map((id) => state.answers.get(id)));
      }
      return { view: state.view, effects: [], cancellations: [] };
    }
    state.pokes += 1;
    state.view = { ...state.view, clicks: String(state.pokes), ...(state.nextView ?? {}) };
    state.nextView = undefined;
    const effects = state.queued.map((request) => {
      state.sequence += 1;
      return { kind: "Capability", correlationId: "ad-" + state.sequence, capability: offer.id, version: 1, request };
    });
    const resolve = state.resolveNext;
    state.waiting = effects.length === 0 ? null : { ids: effects.map((effect) => effect.correlationId), resolve };
    // A projection with no effects has nothing to wait for.
    if (effects.length === 0) setTimeout(() => resolve?.([]), 0);
    state.queued = [];
    return { view: state.view, effects, cancellations: [] };
  },
};

const ask = (requests, view) => new Promise((resolve) => {
  state.queued = requests;
  state.nextView = view;
  state.resolveNext = resolve;
  document.getElementById("poke").click();
});
const trusted = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(50);

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [adaptersCapability({ adapters: [rating, chart, faulty] })], requireHandshake: true }).start();

const [described, wrongVersion] = await ask([{ operation: "describe" }, { operation: "mount", slot: { name: "chart" }, adapter: { id: "chart", version: 2 }, props: { series: [] } }]);
expect("describe lists exactly the adapters the application registered; a version mismatch is refused", described.kind === "Adapters" && described.registered.map((a) => `${a.id}@${a.version}`).join() === "rating@1,chart@3,faulty@1" && wrongVersion.kind === "VersionMismatch" && wrongVersion.registered === 3, { described, wrongVersion });

// --- The Web Component -------------------------------------------------------------
const [ratingMounted] = await ask([{ operation: "mount", slot: { name: "rating" }, adapter: { id: "rating", version: 1 }, props: { value: 2, max: 5 } }]);
const element = document.querySelector("#rating-slot limen-rating");
expect("the Web Component mounts into its slot with the declared properties", ratingMounted.kind === "Mounted" && element?.value === 2 && element.shadowRoot.querySelectorAll("button").length === 5, { ratingMounted, value: element?.value });
await trusted({ kind: "click", selector: "#rating-slot limen-rating >> nth=0" });
await settle();
const rated = state.facts.find((fact) => fact.kind === "AdapterEvent" && fact.name === "rated");
expect("a real click inside its shadow DOM arrives as a JSON fact under the instance id", rated?.instance === ratingMounted.instance && typeof rated.data.value === "number", rated);
const [bumped, refused] = await ask([
  { operation: "command", instance: ratingMounted.instance, name: "bump", args: [1] },
  { operation: "update", instance: ratingMounted.instance, props: { onclick: "alert(1)" } },
]);
expect("a declared command calls the element's method; an undeclared property is refused by name and never written", bumped.kind === "CommandDone" && refused.kind === "Faulted" && refused.reason === "UnknownProperty" && element.onclick === null, { bumped, refused });

// --- The chart widget stub ------------------------------------------------------------
const [chartMounted] = await ask([{ operation: "mount", slot: { name: "chart" }, adapter: { id: "chart", version: 3 }, props: { series: [{ label: "Q1", value: 40 }, { label: "Q2", value: 70 }] } }]);
const [updated, highlighted] = await ask([
  { operation: "update", instance: chartMounted.instance, props: { series: [{ label: "Q1", value: 40 }, { label: "Q2", value: 70 }, { label: "Q3", value: 90 }] } },
  { operation: "command", instance: chartMounted.instance, name: "highlight", args: "Q3" },
]);
document.querySelector("#chart-slot rect[data-label=Q2]").dispatchEvent(new MouseEvent("click", { bubbles: true }));
await settle();
const selected = state.facts.find((fact) => fact.kind === "AdapterEvent" && fact.name === "barSelected");
expect("the chart stub renders, updates, answers a command, and reports a selection as JSON", chartMounted.kind === "Mounted" && updated.kind === "Updated" && document.querySelectorAll("#chart-slot rect").length === 3 && highlighted.kind === "CommandDone" && highlighted.result.highlighted === "Q3" && document.querySelector("#chart-slot rect[data-label=Q3]").getAttribute("fill") === "orange" && selected?.data.label === "Q2", { updated, highlighted, selected });

// --- Fault isolation ---------------------------------------------------------------------
const [faultyMounted] = await ask([{ operation: "mount", slot: { name: "faulty" }, adapter: { id: "faulty", version: 1 }, props: {} }]);
const [exploded, leaked] = await ask([{ operation: "update", instance: faultyMounted.instance, props: {} }, { operation: "command", instance: faultyMounted.instance, name: "leak", args: null }]);
const [stillChart] = await ask([{ operation: "command", instance: chartMounted.instance, name: "highlight", args: "Q1" }]);
expect("a throwing adapter is quarantined by exception name only; the other widgets and the application keep working", exploded.kind === "Faulted" && exploded.reason === "RangeError" && leaked.kind === "Faulted" && stillChart.kind === "CommandDone" && document.getElementById("clicks").textContent === String(state.pokes) && !JSON.stringify(state.facts).includes("internal detail"), { exploded, leaked, stillChart });

// --- A slot removed by a projection -------------------------------------------------------
const [panelMounted] = await ask([{ operation: "mount", slot: { name: "panel" }, adapter: { id: "chart", version: 3 }, props: { series: [{ label: "A", value: 10 }] } }], { panelOpen: true });
await ask([], { panelOpen: false });
await settle();
const removed = state.facts.filter((fact) => fact.kind === "SlotRemoved");
const [afterRemoval] = await ask([{ operation: "update", instance: panelMounted.instance, props: { series: [] } }]);
expect("a projection that removes a slot unmounts its instance: one SlotRemoved, then Stale", panelMounted.kind === "Mounted" && removed.length === 1 && removed[0].instance === panelMounted.instance && afterRemoval.kind === "Stale", { panelMounted, removed, afterRemoval });

const [unmounted] = await ask([{ operation: "unmount", instance: ratingMounted.instance }]);
expect("unmount removes the element and empties its slot", unmounted.kind === "Unmounted" && document.getElementById("rating-slot").childNodes.length === 0, unmounted);
expect("every answer and fact decoded with the generated decoders", state.undecodable === 0, state.undecodable);
window.__limenPackResult = { pack: "limen.adapters", checks };
