// The presentation pack in Chromium: idempotent resource hints (including one
// the HTML already has) and a real view transition around the engine's next
// projection, with its label, its timeout path and Busy.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { presentationCapability, PRESENTATION_CAPABILITY, decodePresentationResult, decodePresentationFact } from "../../../../dist/capabilities/presentation/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

// The pack must never decide motion: count any preference reads.
const reads = { matchMedia: 0 };
const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query) => { reads.matchMedia += 1; return matchMedia(query); };

const offer = { id: PRESENTATION_CAPABILITY.id, version: PRESENTATION_CAPABILITY.version, fingerprint: PRESENTATION_CAPABILITY.fingerprint };
const state = { slowMs: 0, view: { screen: "list" }, queued: [], nextView: undefined, waiting: null, answers: new Map(), facts: [], sequence: 0, undecodable: 0, duringTransition: [] };

const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: state.view, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 3 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    if (message.kind === "CapabilityFact") {
      const decoded = decodePresentationFact(message.fact);
      if (decoded.ok) state.facts.push(decoded.value); else state.undecodable += 1;
      return { view: state.view, effects: [], cancellations: [] };
    }
    if (message.kind === "EffectResult") {
      // A slow engine: its answer to this result arrives after the timeout.
      if (state.slowMs > 0) await sleep(state.slowMs);
      const decoded = message.result.outcome.kind === "Completed" ? decodePresentationResult(message.result.outcome.result) : { ok: false };
      if (!decoded.ok) state.undecodable += 1;
      const answer = decoded.ok ? decoded.value : { kind: "Undecodable" };
      state.answers.set(message.result.correlationId, answer);
      // The engine reacts to Ready by projecting the new view.
      if (answer.kind === "Ready" && state.nextView !== undefined) {
        state.duringTransition.push(document.documentElement.getAttribute("data-view-transition"));
        state.view = state.nextView;
        state.nextView = undefined;
      }
      if (state.waiting !== null && state.waiting.ids.every((id) => state.answers.has(id))) {
        const { ids, resolve } = state.waiting;
        state.waiting = null;
        resolve(ids.map((id) => state.answers.get(id)));
      }
      return { view: state.view, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => { state.sequence += 1; return { kind: "Capability", correlationId: "pr-" + state.sequence, capability: offer.id, version: 1, request }; });
    state.waiting = effects.length === 0 ? null : { ids: effects.map((effect) => effect.correlationId), resolve: state.resolveNext };
    state.queued = [];
    return { view: state.view, effects, cancellations: [] };
  },
};

const ask = (requests, nextView) => new Promise((resolve) => {
  state.queued = requests;
  state.nextView = nextView;
  state.resolveNext = resolve;
  document.getElementById("poke").click();
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (condition) => { const deadline = Date.now() + 5000; while (!condition() && Date.now() < deadline) await sleep(20); return condition(); };
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const links = (rel) => Array.from(document.querySelectorAll(`link[rel="${rel}"]`)).map((link) => new URL(link.href).pathname);

await new BrowserKernel(engine, document, undefined, { capabilities: [presentationCapability()], requireHandshake: true }).start();

// --- Hints ----------------------------------------------------------------------
const base = "/test/browser/packs/presentation/";
const [inHtml, preload, again, module, prefetch, badScheme, noAs] = await ask([
  { operation: "hint", kind: "preconnect", href: "/already-in-html", crossOrigin: false },
  { operation: "hint", kind: "preload", href: "./page.css", as: "style", crossOrigin: false },
  { operation: "hint", kind: "preload", href: base + "page.css", as: "style", crossOrigin: false },
  { operation: "hint", kind: "modulepreload", href: "./extra.js", crossOrigin: false },
  { operation: "hint", kind: "prefetch", href: "./index.view.json", crossOrigin: false },
  { operation: "hint", kind: "preconnect", href: "javascript:alert(1)", crossOrigin: false },
  { operation: "hint", kind: "preload", href: "./page.css", crossOrigin: false },
]);
expect("a hint the static HTML already has is AlreadyPresent, and nothing is duplicated", inHtml.kind === "AlreadyPresent" && links("preconnect").length === 1, { inHtml, preconnect: links("preconnect") });
expect("preload, modulepreload and prefetch are added once; the same URL written differently is AlreadyPresent", preload.kind === "Added" && again.kind === "AlreadyPresent" && module.kind === "Added" && prefetch.kind === "Added" && links("preload").join() === base + "page.css" && links("modulepreload").join() === base + "extra.js", { preload, again, module, prefetch, preloads: links("preload") });
expect("a non-network URL is refused by scheme; preload without as is refused", badScheme.kind === "InvalidUrl" && badScheme.scheme === "javascript" && noAs.kind === "InvalidRequest", { badScheme, noAs });

// --- View transitions -------------------------------------------------------------
const supported = typeof document.startViewTransition === "function";
const [ready] = await ask([{ operation: "prepareTransition", label: "open-detail", timeoutMs: 3000 }], { screen: "detail" });
await until(() => state.facts.length >= 1);
const [finished] = state.facts.splice(0);
expect("Chromium supports view transitions", supported, supported);
expect("prepareTransition captures the old view (Ready), the engine's next projection is the new one, and the transition finishes under its label", ready.kind === "Ready" && document.getElementById("screen").textContent === "detail" && finished?.kind === "TransitionFinished" && finished.label === "open-detail" && finished.outcome === "finished" && state.duringTransition.join() === "open-detail", { ready, finished, during: state.duringTransition, screen: document.getElementById("screen").textContent });
expect("the label is removed from the root once the transition ends", document.documentElement.getAttribute("data-view-transition") === null, document.documentElement.getAttribute("data-view-transition"));

state.slowMs = 400;
const [first, second] = await ask([{ operation: "prepareTransition", label: "slow", timeoutMs: 150 }, { operation: "prepareTransition", label: "second", timeoutMs: 150 }]);
await until(() => state.facts.length >= 1);
state.slowMs = 0;
const [timedOut] = state.facts.splice(0);
expect("a second transition while one waits is Busy; an engine slower than timeoutMs ends the first as timedOut, and the page is not held", first.kind === "Ready" && second.kind === "Busy" && timedOut?.label === "slow" && timedOut.outcome === "timedOut" && document.documentElement.getAttribute("data-view-transition") === null, { first, second, timedOut });

const [invalid] = await ask([{ operation: "prepareTransition", label: "Not A Label", timeoutMs: 100 }]);
expect("a label that is not a CSS identifier is refused", invalid.kind === "InvalidRequest", invalid);
expect("the pack never read a motion or colour preference: those stay CSS's", reads.matchMedia === 0, reads);
expect("every answer and fact decoded with the generated decoders", state.undecodable === 0, state.undecodable);
window.__limenPackResult = { pack: "limen.presentation", checks };
