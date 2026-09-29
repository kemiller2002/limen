// Environment evidence and browser-native formatting (kemiller2002/limen#35,
// LCP-028).
//
// The engine never reads navigator, window or Intl defaults: it asks for the
// user's locale, language preferences, time zone and text direction, and
// hears when a language preference changes. Presentation preferences —
// reduced motion, colour scheme, contrast, forced colours — stay CSS; the
// pack reports one only when the engine names it, because the engine's
// behaviour (not just its styling) depends on it.
//
// format uses the browser's Intl, for the locale and time zone the request
// states — never the machine's defaults — so the text is deterministic for the
// facts the engine supplied, and an engine language without CLDR data does
// not need a second copy of it.
//
// The fact source is injectable: a fake host fixes the environment for a
// test, and the engine cannot tell the difference.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { CAPABILITY_OFFER, type Direction, type Environment, type EnvironmentFact, type EnvironmentRequest, type EnvironmentResult, type FormatItem, type Preference } from "./generated/environment.js";
import { decodeEnvironmentRequest } from "./generated/environment.codec.js";

export { CAPABILITY_OFFER as ENVIRONMENT_CAPABILITY } from "./generated/environment.js";
export type { Direction, Environment, EnvironmentFact, EnvironmentRequest, EnvironmentResult, FormatItem, Preference, PreferenceValue } from "./generated/environment.js";
export { decodeEnvironmentFact, decodeEnvironmentRequest, decodeEnvironmentResult } from "./generated/environment.codec.js";

// Where the facts come from. The browser by default; anything in a test.
export type EnvironmentSource = {
  readonly locale: () => string;
  readonly languages: () => readonly string[];
  readonly timeZone: () => string;
  readonly direction: () => Direction;
  readonly preference: (preference: Preference) => string;
  // Calls onChange whenever a language preference or one of the named
  // preferences changes; returns the unsubscribe.
  readonly subscribe: (preferences: readonly Preference[], onChange: () => void) => () => void;
};

// Each preference's media feature and the values it can match, in order.
const MEDIA: Readonly<Record<Preference, { readonly feature: string; readonly values: readonly string[] }>> = {
  reducedMotion: { feature: "prefers-reduced-motion", values: ["reduce", "no-preference"] },
  colorScheme: { feature: "prefers-color-scheme", values: ["dark", "light"] },
  contrast: { feature: "prefers-contrast", values: ["more", "less", "custom", "no-preference"] },
  forcedColors: { feature: "forced-colors", values: ["active", "none"] },
};

export const browserSource = (document: Document): EnvironmentSource => {
  const view = document.defaultView;
  const query = (text: string): MediaQueryList | undefined => (view !== null && typeof view.matchMedia === "function" ? view.matchMedia(text) : undefined);
  return {
    locale: () => view?.navigator.language ?? "en",
    languages: () => view?.navigator.languages ?? [view?.navigator.language ?? "en"],
    timeZone: () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
    direction: () => {
      const root = document.documentElement;
      const written = root.getAttribute("dir");
      if (written === "rtl" || written === "ltr") return written;
      return view?.getComputedStyle(root).direction === "rtl" ? "rtl" : "ltr";
    },
    preference: (preference) => {
      const { feature, values } = MEDIA[preference];
      return values.find((value) => query(`(${feature}: ${value})`)?.matches === true) ?? "unknown";
    },
    subscribe: (preferences, onChange) => {
      const lists = preferences.flatMap((preference) => MEDIA[preference].values.map((value) => query(`(${MEDIA[preference].feature}: ${value})`)).filter((list): list is MediaQueryList => list !== undefined));
      view?.addEventListener("languagechange", onChange);
      lists.forEach((list) => list.addEventListener("change", onChange));
      return () => {
        view?.removeEventListener("languagechange", onChange);
        lists.forEach((list) => list.removeEventListener("change", onChange));
      };
    },
  };
};

const snapshot = (source: EnvironmentSource, preferences: readonly Preference[]): Environment => {
  const locale = source.locale();
  const languages = source.languages();
  return {
    locale,
    languages: languages.length > 0 ? [...languages] : [locale],
    timeZone: source.timeZone(),
    direction: source.direction(),
    preferences: [...new Set(preferences)].map((preference) => ({ preference, value: source.preference(preference) })),
  };
};

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "invalid";

// One item's text, in the stated locale and time zone.
const formatItem = (locale: string, timeZone: string, item: FormatItem): string => {
  switch (item.kind) {
    case "number":
      if (item.style === "currency" && item.currency === undefined) throw new RangeError("a currency amount needs its currency code");
      return new Intl.NumberFormat(locale, {
        style: item.style,
        ...(item.currency !== undefined ? { currency: item.currency } : {}),
        ...(item.maximumFractionDigits !== undefined ? { maximumFractionDigits: item.maximumFractionDigits } : {}),
      }).format(item.value);
    case "date":
      return new Intl.DateTimeFormat(locale, {
        timeZone,
        ...(item.dateStyle !== undefined ? { dateStyle: item.dateStyle } : {}),
        ...(item.timeStyle !== undefined ? { timeStyle: item.timeStyle } : {}),
      }).format(item.epochMs);
    case "relative":
      return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(item.value, item.unit);
    case "list":
      return new Intl.ListFormat(locale, { type: item.type }).format(item.items);
    case "plural":
      return new Intl.PluralRules(locale, { type: item.ordinal ? "ordinal" : "cardinal" }).select(item.value);
  }
};

const format = (locale: string, timeZone: string, items: readonly FormatItem[]): EnvironmentResult => {
  if (typeof Intl.RelativeTimeFormat !== "function" || typeof Intl.ListFormat !== "function" || typeof Intl.PluralRules !== "function") return { kind: "Unsupported" };
  try {
    Intl.getCanonicalLocales(locale);
    new Intl.DateTimeFormat(locale, { timeZone });
  } catch (error) {
    return { kind: "InvalidRequest", problem: nameOf(error) };
  }
  const results = items.map((item, index) => {
    try {
      return { ok: true as const, text: formatItem(locale, timeZone, item) };
    } catch (error) {
      return { ok: false as const, index, problem: nameOf(error) };
    }
  });
  const failed = results.find((result) => !result.ok);
  if (failed !== undefined && !failed.ok) return { kind: "InvalidRequest", problem: failed.problem, item: failed.index };
  return { kind: "Formatted", texts: results.flatMap((result) => (result.ok ? [result.text] : [])) };
};

export const environmentCapability = (options: { readonly source?: (document: Document) => EnvironmentSource } = {}): CapabilityProvider => {
  const wiring: { host?: CapabilityHost<EnvironmentFact>; unsubscribe?: (() => void) | undefined } = {};
  const sourceFor = (document: Document): EnvironmentSource => (options.source ?? browserSource)(document);

  const execute = async (request: EnvironmentRequest, context: CapabilityRequestContext): Promise<EnvironmentResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    const source = sourceFor(context.document);
    switch (request.operation) {
      case "describe":
        return { kind: "Described", environment: snapshot(source, request.preferences) };
      case "watch": {
        wiring.unsubscribe?.();
        const preferences = request.preferences;
        // Report only a real change: the same environment twice is one fact.
        const initial = snapshot(source, preferences);
        const last = { value: JSON.stringify(initial) };
        wiring.unsubscribe = source.subscribe(preferences, () => {
          const environment = snapshot(source, preferences);
          const text = JSON.stringify(environment);
          if (text === last.value) return;
          last.value = text;
          wiring.host?.emitFact({ kind: "EnvironmentChanged", environment });
        });
        return { kind: "Watching", environment: initial };
      }
      case "unwatch":
        wiring.unsubscribe?.();
        wiring.unsubscribe = undefined;
        return { kind: "Unwatched" };
      case "format":
        return format(request.locale, request.timeZone, request.items);
    }
  };

  return defineCapability<EnvironmentRequest, EnvironmentResult, EnvironmentFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeEnvironmentRequest, execute, activate: (host) => { wiring.host = host; } });
};
