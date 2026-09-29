// Dependency-direction rules, as pure functions over (path, source) pairs.
//
// The layer map lives in architecture/layers.json. This module never touches
// the filesystem: scripts/check-layers.ts reads the repository and calls
// `checkLayers`; tests call it with in-memory fixtures.

import { dirname, join, normalize } from "node:path";

export type Layer = {
  readonly name: string;
  readonly paths: readonly string[];
  readonly instance: string | undefined;
  readonly mayImport: readonly string[];
};

export type LayerMap = {
  readonly layers: readonly Layer[];
  readonly allowedExternal: readonly string[];
  readonly engineLibraryPaths: readonly string[];
  readonly engineLibraryForbidden: Readonly<Record<string, readonly string[]>>;
  readonly protocolForbiddenTypes: readonly string[];
};

export type SourceFile = { readonly path: string; readonly source: string };

export type Violation = { readonly rule: string; readonly path: string; readonly detail: string; readonly remedy: string };

// --- Globs ------------------------------------------------------------------

// `**` any depth (including none), `*` within one segment. Paths are
// repository-relative and "/"-separated.
export const globToRegExp = (glob: string): RegExp => {
  const tokens = glob.split(/(\*\*\/|\/\*\*$|\*\*|\*)/).filter((token) => token.length > 0);
  const pattern = tokens.map((token) => {
    switch (token) {
      case "**/": return "(?:.*/)?";
      case "/**": return "/.+";
      case "**": return ".*";
      case "*": return "[^/]*";
      default: return token.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }).join("");
  return new RegExp(`^${pattern}$`);
};

export const matches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

// --- Parsing the map ---------------------------------------------------------

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): readonly string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

export const parseLayerMap = (raw: unknown): LayerMap => {
  if (!isRecord(raw) || !Array.isArray(raw.layers)) throw new Error("architecture/layers.json: layers[] is required");
  const layers = raw.layers.map((layer, index): Layer => {
    if (!isRecord(layer) || typeof layer.name !== "string") throw new Error(`architecture/layers.json: layers[${index}] needs a name`);
    return { name: layer.name, paths: strings(layer.paths), instance: typeof layer.instance === "string" ? layer.instance : undefined, mayImport: strings(layer.mayImport) };
  });
  const libraries = isRecord(raw.engineLibraries) ? raw.engineLibraries : {};
  const forbidden = isRecord(libraries.forbidden) ? libraries.forbidden : {};
  return {
    layers,
    allowedExternal: isRecord(raw.externalImports) ? strings(raw.externalImports.allowed) : [],
    engineLibraryPaths: strings(libraries.paths),
    engineLibraryForbidden: Object.fromEntries(Object.entries(forbidden).map(([extension, tokens]) => [extension, strings(tokens)])),
    protocolForbiddenTypes: isRecord(raw.protocolForbiddenTypes) ? strings(raw.protocolForbiddenTypes.names) : [],
  };
};

// --- Classification ----------------------------------------------------------

export type Placement = { readonly layer: Layer; readonly instance: string | undefined };

export const placementOf = (map: LayerMap, path: string): Placement | undefined => {
  const layer = map.layers.find((candidate) => candidate.paths.some((glob) => matches(glob, path)));
  if (layer === undefined) return undefined;
  const instance = layer.instance === undefined
    ? undefined
    : path.split("/").slice(0, layer.instance.split("/").length).join("/");
  return { layer, instance };
};

// --- Import extraction ----------------------------------------------------------

// Comments and string contents are blanked first so an import quoted in prose
// or in a string literal is not mistaken for a real one.
export const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

export type ImportSite = { readonly specifier: string | undefined; readonly line: number };

export const importsOf = (source: string): readonly ImportSite[] => {
  const code = withoutComments(source);
  const lineOf = (index: number): number => code.slice(0, index).split("\n").length;
  const staticImports = Array.from(code.matchAll(/(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/g), (match) => ({ specifier: match[1], line: lineOf(match.index ?? 0) }));
  const dynamicImports = Array.from(code.matchAll(/\bimport\s*\(\s*([^)]*)\)/g), (match) => {
    const literal = /^\s*["']([^"']+)["']\s*$/.exec(match[1] ?? "");
    return { specifier: literal?.[1], line: lineOf(match.index ?? 0) };
  });
  return [...staticImports, ...dynamicImports];
};

// "./engine.js" from "src/engine/transport.ts" → "src/engine/engine.ts"
export const resolveImport = (from: string, specifier: string): string | undefined => {
  if (!specifier.startsWith(".")) return undefined;
  const joined = normalize(join(dirname(from), specifier)).replace(/\\/g, "/");
  return joined.replace(/\.js$/, ".ts");
};

// --- Rules ----------------------------------------------------------------------

const importViolations = (map: LayerMap, file: SourceFile): readonly Violation[] => {
  const from = placementOf(map, file.path);
  if (from === undefined) return [];
  return importsOf(file.source).flatMap((site): readonly Violation[] => {
    const where = `${file.path}:${site.line}`;
    if (site.specifier === undefined) {
      return [{ rule: "unresolvable-import", path: where, detail: `${from.layer.name} code uses a dynamic import whose target is not a string literal`, remedy: "Import a fixed module path so its layer can be checked; load optional capability packs at the composition root, not from Core." }];
    }
    const target = resolveImport(file.path, site.specifier);
    if (target === undefined) {
      return map.allowedExternal.includes(site.specifier)
        ? []
        : [{ rule: "external-dependency", path: where, detail: `${from.layer.name} imports external module "${site.specifier}"`, remedy: "The published package has zero runtime dependencies. Implement it in-repository in the right layer, or justify a dependency under prompts/dependency-minimal-browser-kernel-architecture-policy.md §8 in a separately scoped work item." }];
    }
    const to = placementOf(map, target);
    if (to === undefined) {
      return [{ rule: "unlayered-import", path: where, detail: `${from.layer.name} imports ${target}, which belongs to no declared layer`, remedy: "Move the target into a declared layer, or declare its layer in architecture/layers.json under a guardrail-scoped work item." }];
    }
    const sameInstance = from.instance !== undefined && from.instance === to.instance;
    const allowed = from.layer.mayImport.includes(to.layer.name) || (sameInstance && from.layer.mayImport.includes("same-instance"));
    if (allowed) return [];
    const crossPack = from.layer.name === to.layer.name && from.instance !== to.instance;
    return [{
      rule: crossPack ? "capability-pack-cross-import" : "layer-direction",
      path: where,
      detail: crossPack
        ? `capability pack ${from.instance} imports another pack, ${to.instance} (${target})`
        : `${from.layer.name} must not import ${to.layer.name} (${target})`,
      remedy: remedyFor(from.layer.name, to.layer.name, crossPack),
    }];
  });
};

const remedyFor = (from: string, to: string, crossPack: boolean): string => {
  if (crossPack) return "Capability packs are independent. Compose them in the engine (which requests both) or at the host composition root; a genuine shared need is an architecture decision in its own work item.";
  if (to === "capability-pack") return "Core never imports an optional pack. The host registers packs via new BrowserKernel(…, { capabilities: [pack()] }) at its composition root.";
  if (to === "reference-engine" || to === "package-facade") return "Core must not depend on application code. Move the shared piece into core-contract if it is protocol, or keep it in the application.";
  if (from === "reference-engine" && to === "core-kernel") return "An engine never touches browser mechanism. Request an effect; the kernel performs it.";
  return "Invert the dependency or move the code into the layer that owns the concept (see architecture/layers.json).";
};

const stripStrings = (code: string): string => code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');

const protocolTypeViolations = (map: LayerMap, file: SourceFile): readonly Violation[] => {
  const placement = placementOf(map, file.path);
  if (placement?.layer.name !== "core-contract") return [];
  const code = stripStrings(withoutComments(file.source));
  return map.protocolForbiddenTypes
    .filter((name) => new RegExp(`\\b${name}\\b`).test(code))
    .map((name) => ({ rule: "browser-object-in-protocol", path: file.path, detail: `core-contract code references the browser runtime type ${name}`, remedy: "Browser objects never cross the boundary. Carry serialized values or an opaque handle id, defined in the contract." }));
};

const engineLibraryViolations = (map: LayerMap, file: SourceFile): readonly Violation[] => {
  if (!map.engineLibraryPaths.some((glob) => matches(glob, file.path))) return [];
  const extension = /\.[^.\/]+$/.exec(file.path)?.[0] ?? "";
  const code = withoutComments(file.source);
  return (map.engineLibraryForbidden[extension] ?? [])
    .filter((token) => code.includes(token))
    .map((token) => ({ rule: "engine-library-authority", path: file.path, detail: `engine library acquires host authority via ${token}`, remedy: "An engine library is pure application logic: it requests effects and receives results. Code that needs this authority is a host adapter or a capability provider, not an engine library." }));
};

export const checkLayers = (map: LayerMap, files: readonly SourceFile[]): readonly Violation[] =>
  files.flatMap((file) => [
    ...(file.path.endsWith(".ts") ? importViolations(map, file) : []),
    ...(file.path.endsWith(".ts") ? protocolTypeViolations(map, file) : []),
    ...engineLibraryViolations(map, file),
  ]);

export const describeViolation = (violation: Violation): string =>
  `[${violation.rule}] ${violation.path}: ${violation.detail}\n    → ${violation.remedy}`;
