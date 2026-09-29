// Environment evidence and browser-native formatting (kemiller2002/limen#35,
// LCP-028), against the issue's reference tests: en-US vs it-IT, RTL, a
// time-zone-sensitive date, a fake host with a fixed locale and time zone,
// and a locale-change event — plus preferences only when asked. Formatting is
// Node's full ICU here and Chromium's in test/browser/packs/environment/.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import {
  ENVIRONMENT_CAPABILITY, decodeEnvironmentFact, decodeEnvironmentResult, environmentCapability, browserSource,
  type EnvironmentFact, type EnvironmentRequest, type EnvironmentResult, type EnvironmentSource, type Preference,
} from "../dist/capabilities/environment/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineTransport } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

// ICU separates some parts with no-break spaces; compare text, not spacing.
const plain = (texts: readonly string[]): readonly string[] => texts.map((text) => text.replace(/[  ]/g, " "));

// A fake host's environment: fixed facts, changed only when the test says so.
const fixed = (initial: { locale: string; languages?: readonly string[]; timeZone: string; direction?: "ltr" | "rtl"; motion?: string }) => {
  const state = { ...initial, listeners: [] as (() => void)[] };
  const source: EnvironmentSource = {
    locale: () => state.locale,
    languages: () => state.languages ?? [state.locale],
    timeZone: () => state.timeZone,
    direction: () => state.direction ?? "ltr",
    preference: (preference: Preference) => (preference === "reducedMotion" ? state.motion ?? "no-preference" : "unknown"),
    subscribe: (_preferences, onChange) => { state.listeners.push(onChange); return () => { state.listeners = state.listeners.filter((listener) => listener !== onChange); }; },
  };
  const change = (next: Partial<typeof initial>): void => { Object.assign(state, next); state.listeners.forEach((listener) => listener()); };
  return { source, change, listening: () => state.listeners.length };
};

type Harness = { readonly ask: (request: EnvironmentRequest) => Promise<EnvironmentResult>; readonly facts: EnvironmentFact[] };

const withPack = async (source: ((document: Document) => EnvironmentSource) | undefined, act: (harness: Harness, document: Document) => Promise<void>, body = "<p></p>"): Promise<void> => {
  await withDom(body, async (document) => {
    const facts: EnvironmentFact[] = [];
    const provider = environmentCapability(source === undefined ? {} : { source });
    provider.activate({ document, emitFact: (fact) => { const decoded = decodeEnvironmentFact(fact); assert.ok(decoded.ok); facts.push(decoded.value); } });
    const ask = async (request: EnvironmentRequest): Promise<EnvironmentResult> => {
      const answer = await provider.execute(request, { correlationId: "e" as CorrelationId, signal: new AbortController().signal, document });
      const decoded = answer.kind === "Completed" ? decodeEnvironmentResult(answer.result) : undefined;
      assert.ok(decoded?.ok === true, JSON.stringify(answer));
      return decoded.value;
    };
    await act({ ask, facts }, document);
  });
};

const texts = (result: EnvironmentResult): readonly string[] => (result.kind === "Formatted" ? plain(result.texts) : [JSON.stringify(result)]);

test("en-US vs it-IT: the same items, formatted for the locale the engine states", async () => {
  await withPack(undefined, async ({ ask }) => {
    const items = [
      { kind: "number", value: 1234.5, style: "currency", currency: "EUR" },
      { kind: "number", value: 12345.678, style: "decimal", maximumFractionDigits: 2 },
      { kind: "relative", value: -1, unit: "day" },
      { kind: "list", items: ["tea", "coffee", "juice"], type: "conjunction" },
      { kind: "plural", value: 2, ordinal: false },
    ] as const;
    assert.deepEqual(texts(await ask({ operation: "format", locale: "en-US", timeZone: "UTC", items: [...items] })), ["€1,234.50", "12,345.68", "yesterday", "tea, coffee, and juice", "other"]);
    assert.deepEqual(texts(await ask({ operation: "format", locale: "it-IT", timeZone: "UTC", items: [...items] })), ["1234,50 €", "12.345,68", "ieri", "tea, coffee e juice", "other"]);
  });
});

test("a time-zone-sensitive date: the same instant is a different day in Los Angeles and Tokyo", async () => {
  await withPack(undefined, async ({ ask }) => {
    const instant = Date.UTC(2026, 8, 21, 2, 0);
    const item = { kind: "date", epochMs: instant, dateStyle: "full" } as const;
    const [losAngeles, tokyo] = await Promise.all(["America/Los_Angeles", "Asia/Tokyo"].map(async (timeZone) => texts(await ask({ operation: "format", locale: "en-US", timeZone, items: [item] }))[0]));
    assert.equal(losAngeles, "Sunday, September 20, 2026");
    assert.equal(tokyo, "Monday, September 21, 2026");
  });
});

test("unknown locales, time zones and currencies are refused, and the failing item is named", async () => {
  await withPack(undefined, async ({ ask }) => {
    assert.equal((await ask({ operation: "format", locale: "not a locale!", timeZone: "UTC", items: [] })).kind, "InvalidRequest");
    assert.equal((await ask({ operation: "format", locale: "en", timeZone: "Mars/Olympus", items: [] })).kind, "InvalidRequest");
    const badCurrency = await ask({ operation: "format", locale: "en", timeZone: "UTC", items: [{ kind: "number", value: 1, style: "decimal" }, { kind: "number", value: 1, style: "currency" }] });
    assert.deepEqual(badCurrency, { kind: "InvalidRequest", problem: "a currency amount needs its currency code", item: 1 });
  });
});

test("RTL is explicit: the document's direction is reported, from dir or from CSS", async () => {
  await withPack(undefined, async ({ ask }, document) => {
    document.documentElement.setAttribute("dir", "rtl");
    const described = await ask({ operation: "describe", preferences: [] });
    assert.equal(described.kind === "Described" && described.environment.direction, "rtl");
    document.documentElement.setAttribute("dir", "ltr");
    const again = await ask({ operation: "describe", preferences: [] });
    assert.equal(again.kind === "Described" && again.environment.direction, "ltr");
  }, "<p></p>");
  await withDom("<p></p>", async (document) => {
    document.documentElement.setAttribute("dir", "rtl");
    assert.equal(browserSource(document).direction(), "rtl");
  });
});

test("a fake host fixes the environment; preferences are reported only when named", async () => {
  const host = fixed({ locale: "it-IT", languages: ["it-IT", "en"], timeZone: "Europe/Rome", direction: "ltr", motion: "reduce" });
  await withPack(() => host.source, async ({ ask }) => {
    assert.deepEqual(await ask({ operation: "describe", preferences: [] }), { kind: "Described", environment: { locale: "it-IT", languages: ["it-IT", "en"], timeZone: "Europe/Rome", direction: "ltr", preferences: [] } });
    const withMotion = await ask({ operation: "describe", preferences: ["reducedMotion", "reducedMotion"] });
    assert.deepEqual(withMotion.kind === "Described" && withMotion.environment.preferences, [{ preference: "reducedMotion", value: "reduce" }]);
  });
});

test("locale change is evidence: one fact per real change, nothing after unwatch", async () => {
  const host = fixed({ locale: "en-US", timeZone: "America/New_York" });
  await withPack(() => host.source, async ({ ask, facts }) => {
    const watching = await ask({ operation: "watch", preferences: [] });
    assert.equal(watching.kind === "Watching" && watching.environment.locale, "en-US");
    host.change({ locale: "it-IT", languages: ["it-IT"] });
    host.change({ locale: "it-IT", languages: ["it-IT"] });
    assert.deepEqual(facts.map((fact) => fact.environment.locale), ["it-IT"], "the same environment twice is one fact");
    assert.deepEqual(await ask({ operation: "unwatch" }), { kind: "Unwatched" });
    assert.equal(host.listening(), 0);
    host.change({ locale: "fr-FR" });
    assert.equal(facts.length, 1);
  });
});

test("the browser source hears a real languagechange event", async () => {
  await withPack(undefined, async ({ ask, facts }, document) => {
    const view = document.defaultView;
    assert.ok(view !== null);
    await ask({ operation: "watch", preferences: [] });
    Object.defineProperty(view.navigator, "language", { value: "de-DE", configurable: true });
    Object.defineProperty(view.navigator, "languages", { value: ["de-DE"], configurable: true });
    view.dispatchEvent(new view.Event("languagechange"));
    assert.deepEqual(facts.map((fact) => fact.environment.locale), ["de-DE"]);
  });
});

test("through the kernel, with a fake host: the engine formats deterministically for the facts it received", async () => {
  const offer = { id: ENVIRONMENT_CAPABILITY.id as CapabilityId, version: ENVIRONMENT_CAPABILITY.version, fingerprint: ENVIRONMENT_CAPABILITY.fingerprint };
  const host = fixed({ locale: "it-IT", timeZone: "Europe/Rome" });
  const shown: string[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      const answer = message.kind === "EffectResult" && message.result.kind === "CapabilityResult" && message.result.outcome.kind === "Completed" ? decodeEnvironmentResult(message.result.outcome.result) : undefined;
      const effect = (request: EnvironmentRequest) => ({ kind: "Capability" as const, correlationId: `env-${shown.length}` as CorrelationId, capability: offer.id, version: 1, request });
      if (message.kind === "Initialize") return { view: { price: "…" }, cancellations: [], effects: [effect({ operation: "describe", preferences: [] })], handshake: { kind: "Accepted", protocol: { major: 1, minor: 3 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } };
      if (answer?.ok === true && answer.value.kind === "Described") {
        shown.push(answer.value.environment.locale);
        return { view: { price: "…" }, cancellations: [], effects: [effect({ operation: "format", locale: answer.value.environment.locale, timeZone: answer.value.environment.timeZone, items: [{ kind: "number", value: 9.5, style: "currency", currency: "EUR" }] })] };
      }
      if (answer?.ok === true && answer.value.kind === "Formatted") return { view: { price: answer.value.texts[0] ?? "" }, effects: [], cancellations: [] };
      return { view: { price: "…" }, effects: [], cancellations: [] };
    },
  };
  await withDom(`<p id="price" data-text="price"></p>`, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [environmentCapability({ source: () => host.source })] }).start();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.deepEqual(plain([document.getElementById("price")?.textContent ?? ""]), ["9,50 €"]);
    assert.deepEqual(shown, ["it-IT"]);
  });
});

test("the environment pack passes the shared provider conformance suite", async () => {
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await runProviderConformance(environmentCapability(), {
      document,
      decodeResult: decodeEnvironmentResult,
      valid: [{ name: "describe", payload: { operation: "describe", preferences: [] } }, { name: "format", payload: { operation: "format", locale: "en", timeZone: "UTC", items: [] } }],
      malformed: [
        { name: "unknown preference", payload: { operation: "describe", preferences: ["battery"] } },
        { name: "unknown item", payload: { operation: "format", locale: "en", timeZone: "UTC", items: [{ kind: "emoji", value: 1 }] } },
      ],
      cancellable: { name: "describe", payload: { operation: "describe", preferences: [] } },
    }), []);
  });
});
