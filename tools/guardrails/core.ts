// The Core boundary (kemiller2002/limen#59, #60), as pure functions over the
// Core manifest (architecture/core.json), the layer map, and the repository's
// runtime files. Nothing here touches the filesystem: scripts/check-architecture.ts
// reads the repository and calls `checkCore`; test/core-boundary.test.ts calls
// it with in-memory fixtures.
//
// Every violation names the rule, the source path (with line where there is
// one), the destination path or layer, and what to do instead.

import { importsOf, matches, placementOf, resolveImport, withoutComments, type LayerMap, type SourceFile, type Violation } from "./layers.ts";

export type CoreFile = { readonly path: string; readonly visibility: "public" | "private"; readonly generated: boolean };

export type ExportFamily = { readonly id: string; readonly concepts: readonly string[]; readonly names: readonly string[] };

export type CoreManifest = {
  readonly architectureVersion: string;
  readonly referenceCommit: string;
  readonly concepts: readonly string[];
  readonly runtimeRoots: readonly string[];
  readonly coreLayers: readonly string[];
  readonly optionalGroups: Readonly<Record<string, readonly string[]>>;
  readonly files: readonly CoreFile[];
  readonly coreEntrypoints: Readonly<Record<string, string>>;
  readonly families: readonly ExportFamily[];
  readonly legacyRootExports: readonly string[];
  readonly bindingPrimitives: readonly string[];
  readonly bindingModifiers: readonly string[];
  readonly capabilityFamilies: readonly string[];
  readonly capabilitySeam: string;
  // The contract file the capability families are read from.
  readonly capabilityContract: string;
  readonly limits: { readonly runtimeDependencies: number; readonly bindingPrimitives: number; readonly capabilityFamilies: number; readonly concepts: number };
};

export type CoreInputs = {
  // Every file under the manifest's runtime roots, with its text.
  readonly files: readonly SourceFile[];
  readonly packageJson: unknown;
  readonly contract: unknown;
};

// --- Parsing ---------------------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const records = (value: unknown): readonly Readonly<Record<string, unknown>>[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const field = (value: unknown, name: string): unknown => (isRecord(value) ? value[name] : undefined);
const text = (value: unknown, name: string): string => {
  const found = field(value, name);
  if (typeof found !== "string" || found === "") throw new Error(`architecture/core.json: ${name} is required`);
  return found;
};
const count = (value: unknown, name: string): number => {
  const found = field(value, name);
  if (typeof found !== "number" || !Number.isInteger(found) || found < 0) throw new Error(`architecture/core.json: limits.${name} must be a whole number`);
  return found;
};

export const parseCoreManifest = (raw: unknown): CoreManifest => {
  const layers = field(raw, "layers");
  const optional = field(layers, "optional");
  const limits = field(raw, "limits");
  const capability = field(raw, "capabilityFamilies");
  const binding = field(raw, "bindingPrimitives");
  const root = field(raw, "rootExports");
  const entrypoints = field(field(raw, "entrypoints"), "core");
  return {
    architectureVersion: text(raw, "architectureVersion"),
    referenceCommit: text(raw, "referenceCommit"),
    concepts: records(field(raw, "concepts")).map((concept) => text(concept, "id")),
    runtimeRoots: strings(field(field(raw, "runtimeRoots"), "paths")),
    coreLayers: strings(field(layers, "core")),
    optionalGroups: isRecord(optional) ? Object.fromEntries(Object.entries(optional).map(([group, names]) => [group, strings(names)])) : {},
    files: records(field(field(raw, "files"), "list")).map((entry) => ({
      path: text(entry, "path"),
      visibility: entry.visibility === "private" ? "private" : "public",
      generated: entry.generated === true,
    })),
    coreEntrypoints: isRecord(entrypoints) ? Object.fromEntries(Object.entries(entrypoints).filter((pair): pair is [string, string] => typeof pair[1] === "string")) : {},
    families: records(field(root, "families")).map((family) => ({ id: text(family, "id"), concepts: strings(family.concepts), names: strings(family.names) })),
    legacyRootExports: strings(field(root, "legacy")),
    bindingPrimitives: strings(field(binding, "primitives")),
    bindingModifiers: strings(field(binding, "modifiers")),
    capabilityFamilies: strings(field(capability, "families")),
    capabilitySeam: text(capability, "seam"),
    capabilityContract: text(capability, "contract"),
    limits: {
      runtimeDependencies: count(limits, "runtimeDependencies"),
      bindingPrimitives: count(limits, "bindingPrimitives"),
      capabilityFamilies: count(limits, "capabilityFamilies"),
      concepts: count(limits, "concepts"),
    },
  };
};

// --- Facts the checks and the complexity report share ----------------------------

export const isCoreLayer = (manifest: CoreManifest, layer: string): boolean => manifest.coreLayers.includes(layer);

export const coreFileOf = (manifest: CoreManifest, path: string): CoreFile | undefined => manifest.files.find((file) => file.path === path);

// The names a module exports, from `export { … } from`, `export type { … }`,
// and `export const|function|class|type|interface` declarations.
export const exportedNames = (source: string): readonly string[] => {
  const code = withoutComments(source);
  const listed = Array.from(code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g), (match) => match[1] ?? "")
    .flatMap((list) => list.split(","))
    .map((item) => item.trim().replace(/^type\s+/, ""))
    .filter((item) => item !== "")
    .map((item) => item.split(/\s+as\s+/).pop() ?? item);
  const declared = Array.from(code.matchAll(/\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|function\*?|async\s+function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g), (match) => match[1] ?? "");
  return [...new Set([...listed, ...declared])].sort();
};

// data-* attribute names a Core source reads, as string literals. A literal
// ending in "-" is a prefix family (data-bind-): it is reported as "data-bind-*".
export const dataAttributesOf = (source: string): readonly string[] =>
  [...new Set(Array.from(withoutComments(source).matchAll(/["'`\[](data-[a-z][a-z0-9-]*)/g), (match) => {
    const name = match[1] ?? "";
    return name.endsWith("-") ? `${name}*` : name;
  }))].sort();

// The capability families the contract declares: EffectRequest variants other
// than the seam, and the Capability enum's values. Both must agree.
export const contractFamilies = (contract: unknown, seam: string): { readonly variants: readonly string[]; readonly announced: readonly string[] } => {
  const types = records(field(contract, "types"));
  const named = (name: string): Readonly<Record<string, unknown>> | undefined => types.find((type) => type.name === name);
  return {
    variants: records(field(named("EffectRequest"), "variants")).map((variant) => String(variant.name)).filter((name) => name !== seam),
    announced: strings(field(named("Capability"), "values")),
  };
};

export const runtimeDependencies = (packageJson: unknown): readonly string[] =>
  ["dependencies", "peerDependencies", "optionalDependencies", "bundleDependencies", "bundledDependencies"]
    .flatMap((key) => {
      const value = field(packageJson, key);
      return Array.isArray(value) ? strings(value) : isRecord(value) ? Object.keys(value) : [];
    })
    .sort();

// --- Rules -------------------------------------------------------------------------

const violation = (rule: string, path: string, detail: string, remedy: string): Violation => ({ rule, path, detail, remedy });

const ADMISSION = "Enlarging Core needs an approved Core Admission record (docs/core-admission.md) under its own guardrail work item; feature work cannot approve its own admission.";

// Every layer is Core or in exactly one optional group; every group layer exists.
const layerClassification = (manifest: CoreManifest, map: LayerMap): readonly Violation[] => {
  const declared = [...manifest.coreLayers.map((layer) => [layer, "core"] as const), ...Object.entries(manifest.optionalGroups).flatMap(([group, layers]) => layers.map((layer) => [layer, group] as const))];
  const unknown = declared.filter(([layer]) => !map.layers.some((candidate) => candidate.name === layer))
    .map(([layer, group]) => violation("manifest-unknown-layer", "architecture/core.json", `group ${group} names layer ${layer}, which architecture/layers.json does not declare`, "Name only layers that exist in architecture/layers.json."));
  const classification = map.layers.flatMap((layer) => {
    const groups = declared.filter(([name]) => name === layer.name).map(([, group]) => group);
    return groups.length === 1 ? [] : [violation(groups.length === 0 ? "layer-unclassified" : "layer-ambiguous", "architecture/core.json", `layer ${layer.name} is ${groups.length === 0 ? "neither Core nor in any optional group" : `in ${groups.length} groups (${groups.join(", ")})`}`, "Classify every layer exactly once: Core, or one optional group.")];
  });
  return [...unknown, ...classification];
};

// Every runtime file belongs to exactly one layer.
const pathClassification = (map: LayerMap, files: readonly SourceFile[]): readonly Violation[] =>
  files.flatMap((file) => {
    const owners = map.layers.filter((layer) => layer.paths.some((glob) => matches(glob, file.path)));
    if (owners.length === 1) return [];
    return [owners.length === 0
      ? violation("unclassified-path", file.path, "this runtime file belongs to no layer in architecture/layers.json", "Place it under a declared layer's paths (docs/where-code-goes.md). Adding a layer is a guardrail work item.")
      : violation("ambiguous-path", file.path, `this runtime file matches ${owners.length} layers (${owners.map((layer) => layer.name).join(", ")})`, "Layer paths must not overlap; narrow the globs in architecture/layers.json under a guardrail work item.")];
  });

// Core files are exactly the manifest's list.
const coreMembership = (manifest: CoreManifest, map: LayerMap, files: readonly SourceFile[]): readonly Violation[] => {
  const present = new Set(files.map((file) => file.path));
  const inCore = files.filter((file) => {
    const placement = placementOf(map, file.path);
    return placement !== undefined && isCoreLayer(manifest, placement.layer.name);
  });
  const undeclared = inCore.filter((file) => coreFileOf(manifest, file.path) === undefined)
    .map((file) => violation("core-file-undeclared", file.path, `a new file in Core layer ${placementOf(map, file.path)?.layer.name ?? "?"} is not listed in architecture/core.json files`, `Core does not grow by adding a path. Put the code in an optional layer, or ${ADMISSION}`));
  const missing = manifest.files.filter((file) => !present.has(file.path))
    .map((file) => violation("core-file-missing", file.path, "architecture/core.json lists this Core file, but it does not exist", "Update the manifest in the same guardrail work item that moves or removes the file."));
  const misplaced = manifest.files.filter((file) => present.has(file.path)).flatMap((file) => {
    const placement = placementOf(map, file.path);
    return placement !== undefined && isCoreLayer(manifest, placement.layer.name) ? [] : [violation("core-file-outside-core", file.path, `listed as Core but placed in layer ${placement?.layer.name ?? "(none)"}`, "Core files live in Core layers only.")];
  });
  return [...undeclared, ...missing, ...misplaced];
};

// Core imports only Core; nothing else imports a private Core file.
const importDirection = (manifest: CoreManifest, map: LayerMap, files: readonly SourceFile[]): readonly Violation[] =>
  files.filter((file) => file.path.endsWith(".ts")).flatMap((file) => {
    const from = placementOf(map, file.path);
    if (from === undefined) return [];
    const fromCore = isCoreLayer(manifest, from.layer.name);
    return importsOf(file.source).flatMap((site): readonly Violation[] => {
      const target = site.specifier === undefined ? undefined : resolveImport(file.path, site.specifier);
      if (target === undefined) return [];
      const to = placementOf(map, target);
      const where = `${file.path}:${site.line}`;
      if (fromCore && (to === undefined || !isCoreLayer(manifest, to.layer.name))) {
        const group = to === undefined ? "(no layer)" : Object.entries(manifest.optionalGroups).find(([, layers]) => layers.includes(to.layer.name))?.[0] ?? to.layer.name;
        return [violation("core-imports-optional", where, `Core (${from.layer.name}) imports ${target}, in ${to?.layer.name ?? "no layer"} [optional group: ${group}]`, "Core never depends on an optional layer. Invert it: the optional layer imports a public Core extension point, and the host composes the two at its composition root.")];
      }
      const core = coreFileOf(manifest, target);
      if (!fromCore && core !== undefined && core.visibility === "private") {
        return [violation("private-core-import", where, `${from.layer.name} imports ${target}, a private Core file`, "Optional layers depend only on Core's public extension points (visibility: public in architecture/core.json). Making a file public is a Core Admission decision.")];
      }
      return [];
    });
  });

// Binding primitives: the manifest stays within its limit, and Core reads no
// data-* attribute the manifest does not declare.
const bindingPrimitives = (manifest: CoreManifest, map: LayerMap, files: readonly SourceFile[]): readonly Violation[] => {
  const over = manifest.bindingPrimitives.length > manifest.limits.bindingPrimitives
    ? [violation("binding-primitive-limit", "architecture/core.json", `${manifest.bindingPrimitives.length} binding primitives declared; the frozen limit is ${manifest.limits.bindingPrimitives}`, ADMISSION)]
    : [];
  const known = new Set([...manifest.bindingPrimitives, ...manifest.bindingModifiers]);
  const undeclared = files
    .filter((file) => {
      const placement = placementOf(map, file.path);
      return placement !== undefined && placement.layer.name === "core-kernel" && file.path.endsWith(".ts");
    })
    .flatMap((file) => dataAttributesOf(file.source).filter((name) => !known.has(name))
      .map((name) => violation("binding-primitive-undeclared", file.path, `Core reads the DOM attribute ${name}, which is not one of the ${manifest.bindingPrimitives.length} binding primitives (${manifest.bindingPrimitives.join(", ")})`, `The six primitives are frozen. Express it with an existing primitive, as projection the engine computes, or as an optional capability; otherwise ${ADMISSION}`)));
  return [...over, ...undeclared];
};

// Built-in capability families: the contract matches the manifest, within its limit.
const capabilityFamilies = (manifest: CoreManifest, contract: unknown): readonly Violation[] => {
  const found = contractFamilies(contract, manifest.capabilitySeam);
  const over = manifest.capabilityFamilies.length > manifest.limits.capabilityFamilies
    ? [violation("capability-family-limit", "architecture/core.json", `${manifest.capabilityFamilies.length} built-in capability families declared; the frozen limit is ${manifest.limits.capabilityFamilies}`, ADMISSION)]
    : [];
  const compare = (source: readonly string[], where: string): readonly Violation[] => [
    ...source.filter((name) => !manifest.capabilityFamilies.includes(name)).map((name) => violation("capability-family-added", "contract/core.contract.json", `${where} adds built-in capability family ${name}; the frozen families are ${manifest.capabilityFamilies.join(", ")}`, "A new browser capability is an optional capability pack reached through the Capability seam (docs/24-contract-and-capabilities.md), never a fifth built-in family.")),
    ...manifest.capabilityFamilies.filter((name) => !source.includes(name)).map((name) => violation("capability-family-missing", "contract/core.contract.json", `${where} no longer declares built-in family ${name}`, "Removing a grandfathered family is a breaking architecture change: a new architecture version under Core Admission.")),
  ];
  return [...over, ...compare(found.variants, "EffectRequest"), ...compare(found.announced, "the Capability enum")];
};

const dependencies = (manifest: CoreManifest, packageJson: unknown): readonly Violation[] => {
  const names = runtimeDependencies(packageJson);
  return names.length > manifest.limits.runtimeDependencies
    ? [violation("runtime-dependency", "package.json", `${names.length} runtime dependencies (${names.join(", ")}); the limit is ${manifest.limits.runtimeDependencies}`, "The published package has zero runtime dependencies. A devDependency is fine; a runtime one is an architecture decision under prompts/dependency-minimal-browser-kernel-architecture-policy.md §8 and Core Admission.")]
    : [];
};

const concepts = (manifest: CoreManifest): readonly Violation[] => [
  ...(manifest.concepts.length > manifest.limits.concepts ? [violation("concept-limit", "architecture/core.json", `${manifest.concepts.length} canonical Core concepts; the frozen number is ${manifest.limits.concepts}`, `Optional systems compose beneath the seven concepts; they never become an eighth. ${ADMISSION}`)] : []),
  ...manifest.families.flatMap((family) => family.concepts.filter((concept) => !manifest.concepts.includes(concept))
    .map((concept) => violation("export-family-unknown-concept", "architecture/core.json", `root export family ${family.id} names concept ${concept}, which is not canonical`, "Map every export family to one of the canonical concept ids."))),
];

// The root entrypoint exports only names in approved families (or the
// not-yet-removed legacy list), and no name twice.
const rootExports = (manifest: CoreManifest, files: readonly SourceFile[]): readonly Violation[] => {
  const rootPath = manifest.coreEntrypoints["."];
  const root = files.find((file) => file.path === rootPath);
  if (rootPath === undefined || root === undefined) return [violation("root-entrypoint-missing", rootPath ?? "architecture/core.json", "the root entrypoint named by the manifest does not exist", "Declare the root entrypoint in entrypoints.core[\".\"].")];
  const approved = new Map(manifest.families.flatMap((family) => family.names.map((name) => [name, family.id] as const)));
  const duplicates = manifest.families.flatMap((family) => family.names).filter((name, index, all) => all.indexOf(name) !== index);
  return [
    ...exportedNames(root.source).filter((name) => !approved.has(name) && !manifest.legacyRootExports.includes(name))
      .map((name) => violation("root-export-unapproved", rootPath, `the root entrypoint exports ${name}, which is in no approved Core export family`, `Export optional surfaces from their own subpath (./federation, ./reference-engine, ./capabilities/<name>). A new root export family is Core growth: ${ADMISSION}`)),
    ...[...new Set(duplicates)].map((name) => violation("export-family-overlap", "architecture/core.json", `${name} is listed in more than one export family`, "Each root export belongs to exactly one family.")),
  ];
};

export const checkCore = (manifest: CoreManifest, map: LayerMap, inputs: CoreInputs): readonly Violation[] => [
  ...layerClassification(manifest, map),
  ...pathClassification(map, inputs.files),
  ...coreMembership(manifest, map, inputs.files),
  ...importDirection(manifest, map, inputs.files),
  ...bindingPrimitives(manifest, map, inputs.files),
  ...capabilityFamilies(manifest, inputs.contract),
  ...dependencies(manifest, inputs.packageJson),
  ...concepts(manifest),
  ...rootExports(manifest, inputs.files),
];
