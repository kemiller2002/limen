// The environment pack in Chromium: real navigator facts, the document's RTL
// direction, a real media preference, Chromium's Intl for a stated locale and
// time zone, and a real languagechange event.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { environmentCapability, ENVIRONMENT_CAPABILITY, decodeEnvironmentResult, decodeEnvironmentFact } from "../../../../dist/capabilities/environment/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: ENVIRONMENT_CAPABILITY.id, version: ENVIRONMENT_CAPABILITY.version, fingerprint: ENVIRONMENT_CAPABILITY.fingerprint };
const state = { queued: [], waiting: null, answers: new Map(), facts: [], sequence: 0, undecodable: 0 };
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 3 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
    if (message.kind === "CapabilityFact") { const decoded = decodeEnvironmentFact(message.fact); if (decoded.ok) state.facts.push(decoded.value); else state.undecodable += 1; return { view: {}, effects: [], cancellations: [] }; }
    if (message.kind === "EffectResult") {
      const decoded = message.result.outcome.kind === "Completed" ? decodeEnvironmentResult(message.result.outcome.result) : { ok: false };
      if (!decoded.ok) state.undecodable += 1;
      state.answers.set(message.result.correlationId, decoded.ok ? decoded.value : { kind: "Undecodable" });
      if (state.waiting !== null && state.waiting.ids.every((id) => state.answers.has(id))) { const { ids, resolve } = state.waiting; state.waiting = null; resolve(ids.map((id) => state.answers.get(id))); }
      return { view: {}, effects: [], cancellations: [] };
    }
    const effects = state.queued.map((request) => { state.sequence += 1; return { kind: "Capability", correlationId: "env-" + state.sequence, capability: offer.id, version: 1, request }; });
    state.waiting = { ids: effects.map((effect) => effect.correlationId), resolve: state.resolveNext };
    state.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};
const ask = (requests) => new Promise((resolve) => { state.queued = requests; state.resolveNext = resolve; document.getElementById("poke").click(); });
const plain = (text) => text.replace(/[  ]/g, " ");
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [environmentCapability()], requireHandshake: true }).start();

const [described] = await ask([{ operation: "describe", preferences: ["reducedMotion", "colorScheme"] }]);
const environment = described.environment;
const motion = matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference";
expect("the real environment: navigator's locale and languages, Intl's time zone, the document's RTL direction", described.kind === "Described" && environment.locale === navigator.language && environment.languages.join() === navigator.languages.join() && environment.timeZone === Intl.DateTimeFormat().resolvedOptions().timeZone && environment.direction === "rtl", environment);
expect("named preferences only, with the value the media query matches", environment.preferences.length === 2 && environment.preferences[0].preference === "reducedMotion" && environment.preferences[0].value === motion && ["dark", "light"].includes(environment.preferences[1].value), environment.preferences);

const instant = Date.UTC(2026, 8, 21, 2, 0);
const items = [{ kind: "number", value: 1234.5, style: "currency", currency: "EUR" }, { kind: "date", epochMs: instant, dateStyle: "full" }, { kind: "list", items: ["a", "b", "c"], type: "disjunction" }, { kind: "plural", value: 3, ordinal: true }];
const [english, italian, arabic] = await ask([
  { operation: "format", locale: "en-US", timeZone: "America/Los_Angeles", items },
  { operation: "format", locale: "it-IT", timeZone: "Europe/Rome", items },
  { operation: "format", locale: "ar-EG", timeZone: "Africa/Cairo", items: [{ kind: "number", value: 12, style: "decimal" }] },
]);
expect("Chromium's Intl, for the stated locale and time zone: en-US in Los Angeles", english.kind === "Formatted" && plain(english.texts.join(" | ")) === "€1,234.50 | Sunday, September 20, 2026 | a, b, or c | few", english);
// Chromium's CLDR groups four-digit Italian amounts; Node's ICU does not
// (docs/46): formatting is deterministic per browser version, not across them.
expect("the same items for it-IT in Rome: a different format and a different day", italian.kind === "Formatted" && plain(italian.texts[0]) === "1.234,50 €" && italian.texts[1].startsWith("lunedì 21 settembre 2026") && italian.texts[2] === "a, b o c" && italian.texts[3] === "other", italian);
expect("Arabic digits for ar-EG", arabic.kind === "Formatted" && arabic.texts[0] === "١٢", arabic);

await ask([{ operation: "watch", preferences: [] }]);
window.dispatchEvent(new Event("languagechange"));
window.dispatchEvent(new Event("languagechange"));
await new Promise((resolve) => setTimeout(resolve, 50));
expect("a real languagechange with no actual change is not reported", state.facts.length === 0, state.facts);
const [unwatched] = await ask([{ operation: "unwatch" }]);
expect("unwatch ends the subscription", unwatched.kind === "Unwatched", unwatched);
expect("every answer and fact decoded with the generated decoders", state.undecodable === 0, state.undecodable);
window.__limenPackResult = { pack: "limen.environment", checks };
