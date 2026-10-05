// The engine-authority boundary, as pure functions over (path, source) pairs.
//
// The rules are data: architecture/boundary-rules.json. This module is one of
// exactly two implementations of the matching algorithm described there; the
// other is cli/Limen.Core/Boundary.fs, which is what consumers run as
// `limen verify`. Both are held to the same fixtures
// (test/fixtures/boundary-rules/cases.json), so the repository can never apply
// a stricter boundary to itself than it ships to the repositories that depend
// on it, or the reverse, without a test failing.
//
// Nothing here touches the filesystem: scripts/check-architecture.ts reads the
// repository and calls `checkBoundaryFile`; tests call it with fixtures.

export type Language = "typescript" | "fsharp" | "csharp" | "rust";

export type Side = "engine" | "kernel";

export type BoundaryRuleId = "engine-authority" | "engine-module" | "engine-dynamic-type" | "escape-hatch";

export type BoundaryFinding = { readonly rule: BoundaryRuleId; readonly path: string; readonly token: string };

type PerLanguage = Readonly<Partial<Record<Language, readonly string[]>>>;

export type BoundaryRules = {
  readonly schemaVersion: number;
  readonly languages: Readonly<Record<Language, readonly string[]>>;
  readonly neverWalked: readonly string[];
  readonly authority: PerLanguage;
  readonly moduleSpecifierPrefixes: PerLanguage;
  readonly dynamicTypes: PerLanguage;
  readonly escapeHatches: readonly string[];
};

export const LANGUAGES: readonly Language[] = ["typescript", "fsharp", "csharp", "rust"];

// --- Parsing the rule set ------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown, where: string): readonly string[] => {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string" && item.length > 0)) {
    throw new Error(`architecture/boundary-rules.json: ${where} must be an array of non-empty strings`);
  }
  return value;
};

const perLanguage = (value: unknown, where: string): PerLanguage => {
  if (!isRecord(value)) throw new Error(`architecture/boundary-rules.json: ${where} must be an object`);
  const unknownKeys = Object.keys(value).filter((key) => key !== "doc" && !(LANGUAGES as readonly string[]).includes(key));
  if (unknownKeys.length > 0) throw new Error(`architecture/boundary-rules.json: ${where} names unknown language(s) ${unknownKeys.join(", ")}`);
  return Object.fromEntries(LANGUAGES.filter((language) => language in value).map((language) => [language, strings(value[language], `${where}.${language}`)]));
};

export const parseBoundaryRules = (raw: unknown): BoundaryRules => {
  if (!isRecord(raw) || raw.schemaVersion !== 1) throw new Error("architecture/boundary-rules.json: schemaVersion 1 is required");
  const languages = raw.languages;
  const engine = raw.engine;
  const everywhere = raw.everywhere;
  if (!isRecord(languages) || !isRecord(engine) || !isRecord(everywhere)) throw new Error("architecture/boundary-rules.json: languages, engine and everywhere are required");
  return {
    schemaVersion: 1,
    languages: Object.fromEntries(LANGUAGES.map((language) => [language, strings(languages[language], `languages.${language}`)])) as Record<Language, readonly string[]>,
    neverWalked: strings(raw.neverWalked, "neverWalked"),
    authority: perLanguage(engine.authority, "engine.authority"),
    moduleSpecifierPrefixes: perLanguage(engine.moduleSpecifierPrefixes, "engine.moduleSpecifierPrefixes"),
    dynamicTypes: perLanguage(engine.dynamicTypes, "engine.dynamicTypes"),
    escapeHatches: strings(everywhere.escapeHatches, "everywhere.escapeHatches"),
  };
};

export const languageOf = (rules: BoundaryRules, path: string): Language | undefined => {
  const extension = (/\.[^./]+$/.exec(path)?.[0] ?? "").toLowerCase();
  return LANGUAGES.find((language) => rules.languages[language].includes(extension));
};

// --- Lexical normalization -------------------------------------------------------

const blank = (character: string): string => (character === "\n" ? "\n" : " ");

// Remove comments, and string literals unless `keepStrings`, preserving length
// and line structure. Template-literal substitutions (`${…}`) stay code: an
// expression inside a template can reach the browser as easily as one outside.
// F# and C# triple-quoted strings are strings; a single quote is a string in
// TypeScript and only a character literal ('x', '\n') elsewhere, because F#
// type parameters ('T) and Rust lifetimes ('a) are code.
export const stripCode = (language: Language, source: string, keepStrings: boolean): string => {
  const output: string[] = [];
  const braces: number[] = [];
  const length = source.length;
  const at = (index: number): string => (index < length ? source.charAt(index) : "\u0000");
  const copy = (from: number, to: number, asCode: boolean): void => {
    for (let index = from; index < to && index < length; index += 1) output.push(asCode ? source.charAt(index) : blank(source.charAt(index)));
  };
  let index = 0;
  let inTemplate = false;

  while (index < length) {
    const current = source.charAt(index);
    if (inTemplate) {
      if (current === "\\") { copy(index, index + 2, keepStrings); index += 2; }
      else if (current === "`") { copy(index, index + 1, keepStrings); index += 1; inTemplate = false; }
      else if (current === "$" && at(index + 1) === "{") { copy(index, index + 2, true); index += 2; braces.push(0); inTemplate = false; }
      else { copy(index, index + 1, keepStrings); index += 1; }
    } else if (current === "/" && at(index + 1) === "/") {
      const end = source.indexOf("\n", index);
      const stop = end < 0 ? length : end;
      copy(index, stop, false);
      index = stop;
    } else if (current === "/" && at(index + 1) === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end < 0 ? length : end + 2;
      copy(index, stop, false);
      index = stop;
    } else if (language === "fsharp" && current === "(" && at(index + 1) === "*" && at(index + 2) !== ")") {
      const end = source.indexOf("*)", index + 2);
      const stop = end < 0 ? length : end + 2;
      copy(index, stop, false);
      index = stop;
    } else if (current === "\"" && (language === "fsharp" || language === "csharp") && at(index + 1) === "\"" && at(index + 2) === "\"") {
      const end = source.indexOf("\"\"\"", index + 3);
      const stop = end < 0 ? length : end + 3;
      copy(index, stop, keepStrings);
      index = stop;
    } else if (current === "\"" || (current === "'" && language === "typescript")) {
      let cursor = index + 1;
      while (cursor < length && source.charAt(cursor) !== current) cursor += source.charAt(cursor) === "\\" ? 2 : 1;
      const stop = Math.min(cursor + 1, length);
      copy(index, stop, keepStrings);
      index = stop;
    } else if (current === "'") {
      const close = at(index + 1) === "\\" ? source.indexOf("'", index + 2) : (at(index + 2) === "'" ? index + 2 : -1);
      if (close > index && close - index <= 10) { copy(index, close + 1, keepStrings); index = close + 1; }
      else { copy(index, index + 1, true); index += 1; }
    } else if (current === "`" && language === "typescript") {
      copy(index, index + 1, keepStrings);
      index += 1;
      inTemplate = true;
    } else {
      const depth = braces.length - 1;
      if (depth >= 0 && current === "{") braces[depth] = (braces[depth] ?? 0) + 1;
      if (depth >= 0 && current === "}") {
        if ((braces[depth] ?? 0) === 0) { braces.pop(); inTemplate = true; }
        else braces[depth] = (braces[depth] ?? 0) - 1;
      }
      copy(index, index + 1, true);
      index += 1;
    }
  }
  return output.join("");
};

// --- Token matching ----------------------------------------------------------------

const isWordCharacter = (character: string): boolean => /^[\p{L}\p{Nd}_$]$/u.test(character);
const isSpace = (character: string): boolean => character === " " || character === "\t" || character === "\n" || character === "\r";

// Whole-word containment. A token ending in `(` is a call: the word, then
// optional whitespace, then the parenthesis, so `fetch (url)` is `fetch(`.
export const containsToken = (token: string, code: string): boolean => {
  const call = token.endsWith("(");
  const word = call ? token.slice(0, -1) : token;
  const wordEndsInWordCharacter = isWordCharacter(word.charAt(word.length - 1));
  const leftOk = (index: number): boolean => index === 0 || !isWordCharacter(code.charAt(index - 1));
  const rightOk = (index: number): boolean => {
    if (call) {
      let cursor = index;
      while (cursor < code.length && isSpace(code.charAt(cursor))) cursor += 1;
      return code.charAt(cursor) === "(";
    }
    return index >= code.length || !wordEndsInWordCharacter || !isWordCharacter(code.charAt(index));
  };
  const search = (from: number): boolean => {
    const index = code.indexOf(word, from);
    if (index < 0) return false;
    return (leftOk(index) && rightOk(index + word.length)) || search(index + 1);
  };
  return search(0);
};

const SPECIFIER = /\b(?:from|import)\s*\(?\s*(["'`])([^"'`\r\n]*)\1/g;

export const moduleSpecifiers = (codeWithStrings: string): readonly string[] =>
  [...codeWithStrings.matchAll(SPECIFIER)].map((match) => match[2] ?? "");

// --- The check --------------------------------------------------------------------

export const checkBoundaryFile = (rules: BoundaryRules, side: Side, path: string, source: string): readonly BoundaryFinding[] => {
  const language = languageOf(rules, path);
  if (language === undefined) return [];
  const code = stripCode(language, source, false);
  const found = (rule: BoundaryRuleId, tokens: readonly string[] | undefined): readonly BoundaryFinding[] =>
    (tokens ?? []).filter((token) => containsToken(token, code)).map((token) => ({ rule, path, token }));
  const specifiers = side === "engine" && (rules.moduleSpecifierPrefixes[language] ?? []).length > 0
    ? moduleSpecifiers(stripCode(language, source, true))
    : [];
  const modules = (rules.moduleSpecifierPrefixes[language] ?? [])
    .filter((prefix) => specifiers.some((specifier) => specifier.startsWith(prefix)))
    .map((token): BoundaryFinding => ({ rule: "engine-module", path, token }));
  return [
    ...(side === "engine" ? found("engine-authority", rules.authority[language]) : []),
    ...modules,
    ...(side === "engine" ? found("engine-dynamic-type", rules.dynamicTypes[language]) : []),
    ...found("escape-hatch", rules.escapeHatches),
  ];
};

const DETAIL: Readonly<Record<BoundaryRuleId, (token: string) => string>> = {
  "engine-authority": (token) => `engine code references the browser or host capability '${token}'`,
  "engine-module": (token) => `engine code imports a host module ('${token}…')`,
  "engine-dynamic-type": (token) => `engine code uses the dynamic type escape '${token}'`,
  "escape-hatch": (token) => `code uses the escape hatch '${token}'`,
};

// The same sentence the CLI prints for the same finding (Boundary.describe).
export const describeBoundaryFinding = (finding: BoundaryFinding): string => DETAIL[finding.rule](finding.token);

// --- The repository's own declaration (limen.config.json) -----------------------

export type BoundaryDeclaration =
  | { readonly kind: "declared"; readonly engine: readonly string[]; readonly kernel: readonly string[] }
  | { readonly kind: "not-applicable"; readonly rationale: string };

// Mirrors Configuration.parse in cli/Limen.Core/Configuration.fs, so the
// repository reads its own limen.config.json exactly as a consumer's is read.
export const parseBoundaryDeclaration = (raw: unknown): BoundaryDeclaration => {
  const boundary = isRecord(raw) && isRecord(raw.boundary) ? raw.boundary : {};
  const list = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [])
    .map((path) => path.replace(/\\/g, "/").replace(/^\/+/, ""));
  const engine = list(boundary.engine);
  const kernel = list(boundary.kernel);
  if (!isRecord(boundary.notApplicable)) return { kind: "declared", engine, kernel };
  const rationale = typeof boundary.notApplicable.rationale === "string" ? boundary.notApplicable.rationale.trim() : "";
  if (rationale.length === 0) throw new Error("limen.config.json: boundary.notApplicable needs a non-empty rationale");
  if (engine.length + kernel.length > 0) throw new Error("limen.config.json: boundary.notApplicable cannot be combined with engine or kernel paths");
  return { kind: "not-applicable", rationale };
};

// Whether `path` is one of `roots` or inside one.
export const coveredBy = (roots: readonly string[], path: string): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));

// --- .NET WebAssembly host shims (repository-only; architecture/wasm-hosts.json) ---

export type HostShim = { readonly path: string; readonly engine: string; readonly applicationConcepts: readonly string[] };

export type HostShimManifest = { readonly forbidden: readonly string[]; readonly controlFlow: readonly string[]; readonly hosts: readonly HostShim[] };

export const parseHostShims = (raw: unknown): HostShimManifest => {
  if (!isRecord(raw) || !Array.isArray(raw.hosts)) throw new Error("architecture/wasm-hosts.json: hosts[] is required");
  return {
    forbidden: strings(raw.forbidden, "forbidden"),
    controlFlow: strings(raw.controlFlow, "controlFlow"),
    hosts: raw.hosts.map((host, index): HostShim => {
      if (!isRecord(host) || typeof host.path !== "string" || typeof host.engine !== "string") throw new Error(`architecture/wasm-hosts.json: hosts[${index}] needs path and engine`);
      return { path: host.path, engine: host.engine, applicationConcepts: Array.isArray(host.applicationConcepts) ? strings(host.applicationConcepts, `hosts[${index}].applicationConcepts`) : [] };
    }),
  };
};

export const checkHostShim = (manifest: HostShimManifest, host: HostShim, source: string): readonly string[] => {
  const code = stripCode("csharp", source, false);
  return [
    ...(code.includes(host.engine) ? [] : [`${host.path}: WASM host no longer forwards to its engine (${host.engine})`]),
    ...manifest.controlFlow.filter((keyword) => containsToken(keyword, code)).map((keyword) => `${host.path}: marshalling shim contains control flow (${keyword}); decisions belong in the engine`),
    ...[...manifest.forbidden, ...host.applicationConcepts].filter((token) => containsToken(token, code)).map((token) => `${host.path}: marshalling shim contains application/browser concept ${token}`),
  ];
};
