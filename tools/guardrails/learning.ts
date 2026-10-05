// The minimal-agent learning contract (kemiller2002/limen#63), as pure
// functions over documents. scripts/check-docs.ts reads the repository and
// calls `checkLearning`; test/learning-contract.test.ts calls it with fixtures.
//
// What it protects: an ordinary application agent needs exactly seven Core
// concepts and four documents. Optional systems may add documents, never
// concepts, and never required reading.

import type { CoreManifest } from "./core.ts";

export type Learning = {
  readonly canonical: string;
  readonly path: readonly string[];
  readonly requiredReading: { readonly file: string; readonly start: string; readonly end: string };
  readonly quickStarts: readonly string[];
  // Which documents are optional subsystem documents: a pattern, so a new one
  // is covered without editing the manifest.
  readonly optionalDocs: { readonly pattern: RegExp; readonly except: readonly string[] };
};

export const isOptionalDoc = (learning: Learning, path: string): boolean =>
  learning.optionalDocs.pattern.test(path) && !learning.optionalDocs.except.includes(path);

export type Document = { readonly path: string; readonly text: string };

export type LearningViolation = { readonly rule: string; readonly path: string; readonly detail: string; readonly remedy: string };

const PACKAGE = "@echelon-foundry/limen";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export const parseLearning = (rawManifest: unknown): Learning => {
  const learning = isRecord(rawManifest) && isRecord(rawManifest.learning) ? rawManifest.learning : {};
  const reading = isRecord(learning.requiredReading) ? learning.requiredReading : {};
  const text = (value: unknown, name: string): string => {
    if (typeof value !== "string" || value === "") throw new Error(`architecture/core.json: learning.${name} is required`);
    return value;
  };
  return {
    canonical: text(learning.canonical, "canonical"),
    path: strings(learning.path),
    requiredReading: { file: text(reading.file, "requiredReading.file"), start: text(reading.start, "requiredReading.start"), end: text(reading.end, "requiredReading.end") },
    quickStarts: strings(learning.quickStarts),
    optionalDocs: (() => {
      const optional = isRecord(learning.optionalDocs) ? learning.optionalDocs : {};
      return { pattern: new RegExp(text(optional.pattern, "optionalDocs.pattern")), except: strings(optional.except) };
    })(),
  };
};

// "1. **Statement.** `concept-id`" — the canonical document's concept list.
export const conceptsIn = (text: string): readonly string[] =>
  Array.from(text.matchAll(/^\d+\.\s+\*\*[^*]+\*\*\s+`([a-z][a-z-]*)`\s*$/gm), (match) => match[1] ?? "");

// Link targets in a Markdown span, as repository paths: absolute repository
// links and relative ones are both accepted, anchors dropped.
export const linksIn = (text: string, from: string): readonly string[] =>
  Array.from(text.matchAll(/\]\(([^)\s]+)\)/g), (match) => match[1] ?? "")
    .map((target) => target.split("#")[0] ?? "")
    .filter((target) => target !== "")
    .map((target) => {
      const repository = /^https:\/\/github\.com\/kemiller2002\/limen\/(?:blob|tree)\/main\/(.+)$/.exec(target);
      if (repository !== null) return repository[1] ?? "";
      if (/^[a-z]+:/.test(target)) return target;
      const base = from.split("/").slice(0, -1);
      return [...base, ...target.split("/")].reduce<readonly string[]>((parts, part) => (part === "." || part === "" ? parts : part === ".." ? parts.slice(0, -1) : [...parts, part]), []).join("/");
    });

// Every `import { … } from "<package>…"` in a text: the specifier and names.
export const packageImports = (text: string): readonly { readonly specifier: string; readonly names: readonly string[] }[] =>
  Array.from(text.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g), (match) => ({
    specifier: match[2] ?? "",
    names: (match[1] ?? "").split(",").map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "").filter((name) => name !== ""),
  })).filter((site) => site.specifier === PACKAGE || site.specifier.startsWith(`${PACKAGE}/`));

const BANNER_LINES = 12;

export const checkLearning = (manifest: CoreManifest, learning: Learning, documents: readonly Document[]): readonly LearningViolation[] => {
  const textOf = new Map(documents.map((document) => [document.path, document.text] as const));
  const violation = (rule: string, path: string, detail: string, remedy: string): LearningViolation => ({ rule, path, detail, remedy });
  const ADMISSION = "Changing the mandatory Core model is a Core Admission (docs/core-admission.md).";

  // 1. The canonical document teaches exactly the manifest's concepts.
  const canonical = textOf.get(learning.canonical);
  const taught = canonical === undefined ? [] : conceptsIn(canonical);
  const conceptViolations = canonical === undefined
    ? [violation("canonical-missing", learning.canonical, "the canonical Core mental-model document does not exist", "Restore it; it is the first thing an agent reads.")]
    : taught.join(",") === manifest.concepts.join(",")
      ? []
      : [violation("canonical-concepts", learning.canonical, `teaches ${taught.length} concepts (${taught.join(", ")}); the Core manifest has ${manifest.concepts.length} (${manifest.concepts.join(", ")})`, `The canonical model is exactly the manifest's concepts, in order. Optional systems compose beneath them and never become concept ${manifest.concepts.length + 1}. ${ADMISSION}`)];

  // 2. Required reading is exactly the learning path.
  const readingFile = textOf.get(learning.requiredReading.file) ?? "";
  const start = readingFile.indexOf(learning.requiredReading.start);
  const end = readingFile.indexOf(learning.requiredReading.end);
  const block = start === -1 || end <= start ? undefined : readingFile.slice(start, end);
  const required = block === undefined ? [] : [...new Set(linksIn(block, learning.requiredReading.file))];
  const readingViolations = block === undefined
    ? [violation("required-reading-missing", learning.requiredReading.file, `no required-reading block between ${learning.requiredReading.start} and ${learning.requiredReading.end}`, "Keep the marked block; it is what an agent reads first.")]
    : [
      ...required.filter((path) => !learning.path.includes(path)).map((path) => violation("optional-in-required-reading", learning.requiredReading.file, `required reading links ${path}, which is not on the Core learning path`, `Optional documents are read when a task needs them, never first. Link it outside the required block. ${ADMISSION}`)),
      ...learning.path.filter((path) => !required.includes(path)).map((path) => violation("learning-path-incomplete", learning.requiredReading.file, `required reading omits ${path}`, "Required reading is exactly the Core learning path in architecture/core.json.")),
      ...(required.filter((path) => learning.path.includes(path)).join(",") === learning.path.filter((path) => required.includes(path)).join(",") ? [] : [violation("learning-path-order", learning.requiredReading.file, "required reading is not in the learning path's order", "Keep the order of architecture/core.json learning.path.")]),
    ];

  // 3. The learning path holds no optional document, and every path entry exists.
  const pathViolations = [
    ...learning.path.filter((path) => isOptionalDoc(learning, path)).map((path) => violation("optional-in-learning-path", "architecture/core.json", `${path} is both on the Core learning path and an optional document`, ADMISSION)),
    ...learning.path.filter((path) => !textOf.has(path)).map((path) => violation("learning-path-missing", path, "on the Core learning path but does not exist", "Restore it, or change the path under Core Admission.")),
  ];

  // 4. Each optional document opens by naming the Core concept it composes with.
  const bannerViolations = documents.filter((document) => isOptionalDoc(learning, document.path)).flatMap(({ path, text }) => {
    const banner = text.split("\n").slice(0, BANNER_LINES).find((line) => /^>\s*\*\*Optional\b/.test(line));
    const bannerText = text.split("\n").slice(0, BANNER_LINES + 4).join(" ");
    const named = Array.from(bannerText.matchAll(/`([a-z][a-z-]*)`/g), (match) => match[1] ?? "").filter((id) => manifest.concepts.includes(id));
    return banner === undefined || !/composes with/i.test(bannerText) || named.length === 0
      ? [violation("optional-doc-banner", path, `does not open (within ${BANNER_LINES} lines) with an "> **Optional …** … composes with \`<concept>\`" banner naming a canonical Core concept`, "Say first that this is optional and which of the seven Core concepts it composes with, instead of redefining the architecture.")]
      : [];
  });

  // 5. Quick starts import Core entrypoints only.
  const coreSpecifiers = new Set(Object.keys(manifest.coreEntrypoints).map((subpath) => (subpath === "." ? PACKAGE : `${PACKAGE}${subpath.slice(1)}`)));
  const quickStartViolations = learning.quickStarts.flatMap((path) =>
    packageImports(textOf.get(path) ?? "").filter((site) => !coreSpecifiers.has(site.specifier))
      .map((site) => violation("quick-start-optional-import", path, `the quick start imports ${site.specifier}, which is not a Core entrypoint`, "A quick start teaches Core only. Show optional surfaces in their own documents.")));

  // 6. Nobody imports an optional name from the root.
  const approved = new Set(manifest.families.flatMap((family) => family.names));
  const rootViolations = documents.flatMap((document) =>
    packageImports(document.text).filter((site) => site.specifier === PACKAGE).flatMap((site) => site.names.filter((name) => !approved.has(name))
      .map((name) => violation("optional-import-from-root", document.path, `imports ${name} from the package root, which exports Core only`, "Import an optional surface from its explicit subpath (…/federation, …/reference-engine, …/capabilities/<name>)."))));

  return [...conceptViolations, ...readingViolations, ...pathViolations, ...bannerViolations, ...quickStartViolations, ...rootViolations];
};
