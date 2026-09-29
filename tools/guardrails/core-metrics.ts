// The Core complexity report and its budget gate (kemiller2002/limen#62).
//
// Pure: every input is passed in. scripts/check-core-budget.ts reads the
// repository (or a Git revision of it), builds the report with `coreReport`,
// and judges it against the approved baseline with `judge`;
// test/core-budget.test.ts calls both with fixtures.
//
// Anti-gaming, by construction:
//   - Handwritten and generated Core are reported apart; only handwritten
//     lines are a line budget.
//   - Size is also measured as normalizedBytes: comments removed and every
//     run of whitespace collapsed, so reformatting or joining lines does not
//     change it. A line budget can be "met" by code golf; this one cannot.
//   - Counts of concepts, root export families, binding primitives,
//     capability families and runtime dependencies are hard gates judged on
//     their own. Shrinking lines never offsets any of them.
//   - Tests, docs, examples and optional layers are not Core and are not
//     measured as Core.

import { gzipSync } from "node:zlib";
import { contractFamilies, dataAttributesOf, emittedPath, exportedNames, isCoreLayer, moduleClosure, runtimeDependencies, type CoreFile, type CoreManifest } from "./core.ts";
import { importsOf, placementOf, resolveImport, withoutComments, type LayerMap, type SourceFile } from "./layers.ts";

// --- The report ------------------------------------------------------------------

export type Size = {
  readonly files: number;
  // Every line, blank and comment included: `wc -l`, plus a final line that
  // lacks a trailing newline. (The #59 review's 487/176/15 for the reference
  // also counted the empty string after each file's final newline; measured
  // this way the reference is 486/175/14, 675 in all.)
  readonly rawLines: number;
  // Non-blank lines that are not only comment.
  readonly lines: number;
  readonly bytes: number;
  // Comments removed, whitespace runs collapsed: insensitive to formatting.
  readonly normalizedBytes: number;
};

export type FileSize = Size & { readonly path: string; readonly generated: boolean };

export type EmittedSize = { readonly files: number; readonly bytes: number; readonly normalizedBytes: number; readonly gzipBytes: number };

export type OptionalModule = { readonly group: string; readonly layers: readonly string[]; readonly present: boolean; readonly inMinimalGraph: boolean };

export type CoreReport = {
  readonly architectureVersion: string;
  readonly core: {
    readonly handwritten: Size;
    readonly generated: Size;
    readonly perFile: readonly FileSize[];
    // null when the emitted JavaScript was not supplied (not built).
    readonly emitted: EmittedSize | null;
  };
  readonly rootExports: { readonly total: number; readonly families: readonly { readonly id: string; readonly names: number }[]; readonly unassigned: readonly string[] };
  // false for a revision that predates contract/core.contract.json: protocol
  // and capability-family counts are then not measurable from the contract.
  readonly contractPresent: boolean;
  readonly protocol: { readonly unions: readonly { readonly name: string; readonly variants: number }[]; readonly totalVariants: number; readonly browserToEngineMessages: number; readonly effectRequests: number; readonly effectResults: number };
  readonly bindingPrimitives: { readonly count: number; readonly names: readonly string[] };
  readonly capabilityFamilies: { readonly count: number; readonly names: readonly string[] };
  readonly runtimeDependencies: { readonly count: number; readonly names: readonly string[] };
  readonly concepts: { readonly count: number; readonly ids: readonly string[] };
  readonly coreImportsOptional: readonly string[];
  readonly minimalGraph: Readonly<Record<string, readonly string[]>>;
  readonly optionalModules: readonly OptionalModule[];
  // The minimal root consumer's payload, measured by bench/size.ts (#19) so the
  // two reports share one measure; null when not built.
  readonly minimalConsumer: { readonly modules: number; readonly rawBytes: number; readonly gzipBytesBundled: number } | null;
};

export type ReportInputs = {
  readonly manifest: CoreManifest;
  readonly map: LayerMap;
  // Every runtime source file (src/**).
  readonly sources: readonly SourceFile[];
  // The Core files to measure: the manifest's list, or — for a revision that
  // predates the manifest — every file in a Core layer at that revision.
  readonly coreFiles: readonly CoreFile[];
  // Emitted JavaScript by dist/ path; empty when not built.
  readonly emitted: ReadonlyMap<string, string>;
  readonly packageJson: unknown;
  // undefined when the revision has no contract file.
  readonly contract: unknown;
  readonly minimalConsumer: CoreReport["minimalConsumer"];
};

const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");
const normalized = (text: string): string => withoutComments(text).replace(/\s+/g, " ").trim();
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const sizeOf = (source: string): Omit<Size, "files"> => ({
  rawLines: (source.match(/\n/g) ?? []).length + (source === "" || source.endsWith("\n") ? 0 : 1),
  lines: withoutComments(source).split("\n").filter((line) => line.trim() !== "").length,
  bytes: utf8(source),
  normalizedBytes: utf8(normalized(source)),
});

const total = (files: readonly FileSize[]): Size => ({
  files: files.length,
  rawLines: sum(files.map((file) => file.rawLines)),
  lines: sum(files.map((file) => file.lines)),
  bytes: sum(files.map((file) => file.bytes)),
  normalizedBytes: sum(files.map((file) => file.normalizedBytes)),
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const unions = (contract: unknown): readonly { readonly name: string; readonly variants: number }[] => {
  const types = isRecord(contract) && Array.isArray(contract.types) ? contract.types.filter(isRecord) : [];
  return types
    .filter((type) => type.kind === "union" && Array.isArray(type.variants))
    .map((type) => ({ name: String(type.name), variants: Array.isArray(type.variants) ? type.variants.length : 0 }))
    .sort((a, b) => byName(a.name, b.name));
};

export const coreReport = (inputs: ReportInputs): CoreReport => {
  const { manifest, map } = inputs;
  const sources = new Map(inputs.sources.map((file) => [file.path, file.source] as const));
  const perFile: readonly FileSize[] = inputs.coreFiles
    .flatMap((file) => {
      const source = sources.get(file.path);
      return source === undefined ? [] : [{ path: file.path, generated: file.generated, files: 1, ...sizeOf(source) }];
    })
    .sort((a, b) => byName(a.path, b.path));
  const emittedTexts = inputs.coreFiles.map((file) => inputs.emitted.get(emittedPath(file.path)));
  const emitted = inputs.emitted.size === 0 || emittedTexts.some((text) => text === undefined)
    ? null
    : (() => {
      const texts = inputs.coreFiles.map((file) => [emittedPath(file.path), inputs.emitted.get(emittedPath(file.path)) ?? ""] as const).sort((a, b) => byName(a[0], b[0])).map(([, text]) => text);
      return { files: texts.length, bytes: sum(texts.map(utf8)), normalizedBytes: sum(texts.map((text) => utf8(normalized(text)))), gzipBytes: gzipSync(texts.join("\n"), { level: 9 }).length };
    })();

  const rootPath = manifest.coreEntrypoints["."] ?? "src/index.ts";
  const rootNames = exportedNames(sources.get(rootPath) ?? "");
  const familyOf = new Map(manifest.families.flatMap((family) => family.names.map((name) => [name, family.id] as const)));

  const coreLayerFiles = inputs.sources.filter((file) => {
    const placement = placementOf(map, file.path);
    return placement !== undefined && isCoreLayer(manifest, placement.layer.name);
  });
  const coreImportsOptional = coreLayerFiles.filter((file) => file.path.endsWith(".ts")).flatMap((file) =>
    importsOf(file.source).flatMap((site) => {
      const target = site.specifier === undefined ? undefined : resolveImport(file.path, site.specifier);
      if (target === undefined) return [];
      const to = placementOf(map, target);
      return to !== undefined && isCoreLayer(manifest, to.layer.name) ? [] : [`${file.path} -> ${target}`];
    })).sort(byName);

  const coreKernelSources = coreLayerFiles.filter((file) => placementOf(map, file.path)?.layer.name === "core-kernel");
  const observedPrimitives = [...new Set(coreKernelSources.flatMap((file) => dataAttributesOf(file.source)))].filter((name) => !manifest.bindingModifiers.includes(name)).sort(byName);
  const families = contractFamilies(inputs.contract, manifest.capabilitySeam);
  const dependencies = runtimeDependencies(inputs.packageJson);

  const minimalGraph = Object.fromEntries(Object.entries(manifest.coreEntrypoints).sort((a, b) => byName(a[0], b[0])).map(([subpath, entry]) =>
    [subpath, moduleClosure([entry], (path) => sources.get(path), resolveImport)] as const));
  // The entrypoint modules themselves (the root facade) are the graph's roots,
  // not something it loads.
  const entryFiles = new Set(Object.values(manifest.coreEntrypoints));
  const graphFiles = new Set(Object.values(minimalGraph).flat().filter((path) => !entryFiles.has(path)));
  const optionalModules = Object.entries(manifest.optionalGroups).sort((a, b) => byName(a[0], b[0])).map(([group, layers]) => {
    const inGroup = (path: string): boolean => layers.includes(placementOf(map, path)?.layer.name ?? "");
    return { group, layers: [...layers].sort(byName), present: inputs.sources.some((file) => inGroup(file.path)), inMinimalGraph: [...graphFiles].some(inGroup) };
  });
  const protocolUnions = unions(inputs.contract);
  const variantsOf = (name: string): number => protocolUnions.find((union) => union.name === name)?.variants ?? 0;

  return {
    architectureVersion: manifest.architectureVersion,
    core: {
      handwritten: total(perFile.filter((file) => !file.generated)),
      generated: total(perFile.filter((file) => file.generated)),
      perFile,
      emitted,
    },
    rootExports: {
      total: rootNames.length,
      families: manifest.families.map((family) => ({ id: family.id, names: rootNames.filter((name) => familyOf.get(name) === family.id).length })).filter((family) => family.names > 0).sort((a, b) => byName(a.id, b.id)),
      unassigned: rootNames.filter((name) => !familyOf.has(name)),
    },
    contractPresent: inputs.contract !== undefined,
    protocol: {
      unions: protocolUnions,
      totalVariants: sum(protocolUnions.map((union) => union.variants)),
      browserToEngineMessages: variantsOf("BrowserToEngineMessage"),
      effectRequests: variantsOf("EffectRequest"),
      effectResults: variantsOf("EffectResult"),
    },
    bindingPrimitives: { count: observedPrimitives.length, names: observedPrimitives },
    capabilityFamilies: { count: families.variants.length, names: [...families.variants].sort(byName) },
    runtimeDependencies: { count: dependencies.length, names: dependencies },
    concepts: { count: manifest.concepts.length, ids: manifest.concepts },
    coreImportsOptional,
    minimalGraph,
    optionalModules,
    minimalConsumer: inputs.minimalConsumer,
  };
};

// --- The gate ------------------------------------------------------------------------

export type Finding = {
  readonly kind: "hard-gate" | "review-trigger";
  readonly dimension: string;
  readonly approved: string;
  readonly current: string;
  readonly detail: string;
};

export type Limits = CoreManifest["limits"];

// Growth that needs an explicit architecture decision: more than 10% over the
// approved baseline.
export const GROWTH_TRIGGER = 0.10;

const grew = (approved: number, current: number): boolean => current > approved * (1 + GROWTH_TRIGGER);
const percent = (approved: number, current: number): string => (approved === 0 ? (current === 0 ? "+0.0%" : "new") : `${current >= approved ? "+" : ""}${(((current - approved) / approved) * 100).toFixed(1)}%`);

const ADMISSION = "This needs an approved Core Admission record (docs/core-admission.md); only its guardrail work item may then raise the approved baseline in architecture/core-baseline.json.";

export const judge = (approved: CoreReport, current: CoreReport, limits: Limits): readonly Finding[] => {
  const hard = (dimension: string, was: string, now: string, detail: string): Finding => ({ kind: "hard-gate", dimension, approved: was, current: now, detail: `${detail} ${ADMISSION}` });
  const approvedFamilies = new Set(approved.rootExports.families.map((family) => family.id));
  const hardGates: readonly (Finding | undefined)[] = [
    current.runtimeDependencies.count > limits.runtimeDependencies ? hard("runtime dependencies", String(limits.runtimeDependencies), `${current.runtimeDependencies.count} (${current.runtimeDependencies.names.join(", ")})`, "The published package has zero runtime dependencies.") : undefined,
    current.bindingPrimitives.count > limits.bindingPrimitives ? hard("binding primitives", String(limits.bindingPrimitives), `${current.bindingPrimitives.count} (${current.bindingPrimitives.names.join(", ")})`, "The six DOM binding primitives are frozen.") : undefined,
    current.capabilityFamilies.count > limits.capabilityFamilies ? hard("built-in capability families", String(limits.capabilityFamilies), `${current.capabilityFamilies.count} (${current.capabilityFamilies.names.join(", ")})`, "A new browser capability is an optional pack, not a fifth built-in family.") : undefined,
    current.concepts.count > limits.concepts ? hard("canonical concepts", String(limits.concepts), String(current.concepts.count), "Optional systems compose beneath the seven concepts.") : undefined,
    current.optionalModules.some((module) => module.inMinimalGraph) ? hard("optional modules in the minimal graph", "none", current.optionalModules.filter((module) => module.inMinimalGraph).map((module) => module.group).join(", "), "A minimal Core consumer loads Core only.") : undefined,
    current.coreImportsOptional.length > 0 ? hard("Core imports of optional layers", "none", current.coreImportsOptional.join("; "), "Core never depends on an optional layer.") : undefined,
    current.rootExports.unassigned.length > 0 ? hard("root exports outside every approved family", "none", current.rootExports.unassigned.join(", "), "Every root export belongs to an approved Core export family.") : undefined,
    ...current.rootExports.families.filter((family) => !approvedFamilies.has(family.id)).map((family) => hard("root export families", [...approvedFamilies].sort(byName).join(", "), `new family ${family.id}`, "A new root export family is a new Core concept surface.")),
  ];
  const trigger = (dimension: string, was: number, now: number): Finding | undefined => grew(was, now)
    ? { kind: "review-trigger", dimension, approved: String(was), current: `${now} (${percent(was, now)})`, detail: `Core grew more than ${GROWTH_TRIGGER * 100}% over the approved baseline. A threshold breach is a review gate, not proof the change is wrong. ${ADMISSION}` }
    : undefined;
  const triggers: readonly (Finding | undefined)[] = [
    trigger("handwritten Core lines", approved.core.handwritten.lines, current.core.handwritten.lines),
    trigger("handwritten Core normalized bytes", approved.core.handwritten.normalizedBytes, current.core.handwritten.normalizedBytes),
    approved.core.emitted !== null && current.core.emitted !== null ? trigger("emitted Core gzip bytes", approved.core.emitted.gzipBytes, current.core.emitted.gzipBytes) : undefined,
    approved.core.emitted !== null && current.core.emitted !== null ? trigger("emitted Core normalized bytes", approved.core.emitted.normalizedBytes, current.core.emitted.normalizedBytes) : undefined,
    trigger("root exports", approved.rootExports.total, current.rootExports.total),
  ];
  return [...hardGates, ...triggers].filter((finding): finding is Finding => finding !== undefined);
};

// One line per dimension, reference -> approved -> current, for CI logs.
export const comparisonTable = (reference: CoreReport | undefined, approved: CoreReport, current: CoreReport): string => {
  const row = (label: string, pick: (report: CoreReport) => number | undefined): string => {
    const [r, a, c] = [reference === undefined ? undefined : pick(reference), pick(approved), pick(current)];
    const cell = (value: number | undefined): string => (value === undefined ? "—" : String(value));
    return `  ${label.padEnd(36)} ${cell(r).padStart(9)} ${cell(a).padStart(9)} ${cell(c).padStart(9)}   ${a === undefined || c === undefined ? "" : percent(a, c)}`;
  };
  return [
    `  ${"dimension".padEnd(36)} ${"reference".padStart(9)} ${"approved".padStart(9)} ${"current".padStart(9)}   vs approved`,
    row("handwritten Core files", (report) => report.core.handwritten.files),
    row("handwritten Core lines", (report) => report.core.handwritten.lines),
    row("handwritten Core raw lines", (report) => report.core.handwritten.rawLines),
    row("handwritten Core bytes", (report) => report.core.handwritten.bytes),
    row("handwritten Core normalized bytes", (report) => report.core.handwritten.normalizedBytes),
    row("generated Core lines", (report) => report.core.generated.lines),
    row("generated Core bytes", (report) => report.core.generated.bytes),
    row("emitted Core bytes", (report) => report.core.emitted?.bytes),
    row("emitted Core normalized bytes", (report) => report.core.emitted?.normalizedBytes),
    row("emitted Core gzip bytes", (report) => report.core.emitted?.gzipBytes),
    row("root exports", (report) => report.rootExports.total),
    row("root export families", (report) => report.rootExports.families.length),
    row("protocol union variants", (report) => (report.contractPresent ? report.protocol.totalVariants : undefined)),
    row("binding primitives", (report) => report.bindingPrimitives.count),
    row("built-in capability families", (report) => (report.contractPresent ? report.capabilityFamilies.count : undefined)),
    row("runtime dependencies", (report) => report.runtimeDependencies.count),
    row("canonical concepts", (report) => report.concepts.count),
    row("minimal graph modules (root)", (report) => report.minimalGraph["."]?.length),
    row("minimal consumer gzip bytes (#19)", (report) => report.minimalConsumer?.gzipBytesBundled),
  ].join("\n");
};
