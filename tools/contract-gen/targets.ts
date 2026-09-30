// contract/targets.json: which units exist and which bindings they produce.

export const OUTPUT_KINDS = ["typescript-types", "typescript-codec", "fsharp-runtime", "fsharp-unit", "csharp-runtime", "csharp-unit", "rust-runtime", "rust-unit"] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

// A runtime is the per-language wire plumbing shared by every unit; it is
// produced by the generator itself, not from any one contract unit.
export const RUNTIME_KINDS: readonly OutputKind[] = ["fsharp-runtime", "csharp-runtime", "rust-runtime"];

// A typescript-codec target may be split (CA-0003): `roots` emits only the
// decoders reachable from those types; `shared` imports those decoders and
// the codec runtime from another codec module and re-exports them.
export type SharedCodec = { readonly module: string; readonly roots: readonly string[] };

export type Target = {
  readonly unit: string | undefined;
  readonly kind: OutputKind;
  readonly path: string;
  readonly typesModule: string | undefined;
  readonly roots?: readonly string[];
  readonly shared?: SharedCodec;
};

export type Targets = { readonly units: readonly string[]; readonly outputs: readonly Target[] };

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNames = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === "string");

const isOutputKind = (value: unknown): value is OutputKind =>
  OUTPUT_KINDS.some((kind) => kind === value);

const parseTarget = (raw: unknown, index: number): Parsed<Target> => {
  const at = `outputs[${index}]`;
  if (!isRecord(raw)) return { ok: false, errors: [`${at}: must be an object`] };
  const errors = [
    ...(RUNTIME_KINDS.some((kind) => kind === raw.kind)
      ? (raw.unit === undefined ? [] : [`${at}: a runtime target names no unit`])
      : (typeof raw.unit === "string" ? [] : [`${at}: unit is required`])),
    ...(isOutputKind(raw.kind) ? [] : [`${at}: kind must be one of ${OUTPUT_KINDS.join(", ")}`]),
    ...(typeof raw.path === "string" && !raw.path.startsWith("/") && !raw.path.includes("..") ? [] : [`${at}: path must be repository-relative`]),
    ...(raw.typesModule === undefined || typeof raw.typesModule === "string" ? [] : [`${at}: typesModule must be a string`]),
    ...(raw.roots === undefined || isNames(raw.roots) ? [] : [`${at}: roots must be a non-empty array of type names`]),
    ...(raw.shared === undefined || (isRecord(raw.shared) && typeof raw.shared.module === "string" && isNames(raw.shared.roots)) ? [] : [`${at}: shared must be { module, roots }`]),
    ...((raw.roots !== undefined || raw.shared !== undefined) && raw.kind !== "typescript-codec" ? [`${at}: roots and shared apply to typescript-codec targets only`] : []),
    ...(raw.roots !== undefined && raw.shared !== undefined ? [`${at}: a codec target is either split out (roots) or shares one (shared), not both`] : []),
  ];
  return errors.length > 0 || !isOutputKind(raw.kind) || typeof raw.path !== "string"
    ? { ok: false, errors }
    : { ok: true, value: {
      unit: typeof raw.unit === "string" ? raw.unit : undefined, kind: raw.kind, path: raw.path, typesModule: typeof raw.typesModule === "string" ? raw.typesModule : undefined,
      ...(isNames(raw.roots) ? { roots: raw.roots } : {}),
      ...(isRecord(raw.shared) && typeof raw.shared.module === "string" && isNames(raw.shared.roots) ? { shared: { module: raw.shared.module, roots: raw.shared.roots } } : {}),
    } };
};

export const parseTargets = (raw: unknown): Parsed<Targets> => {
  if (!isRecord(raw) || !Array.isArray(raw.units) || !Array.isArray(raw.outputs)) return { ok: false, errors: ["targets must have units[] and outputs[]"] };
  const units = raw.units.filter((unit): unit is string => typeof unit === "string");
  const outputs = raw.outputs.map(parseTarget);
  const errors = [
    ...(units.length === raw.units.length ? [] : ["units must be paths"]),
    ...outputs.flatMap((output) => (output.ok ? [] : output.errors)),
  ];
  const paths = outputs.flatMap((output) => (output.ok ? [output.value.path] : []));
  const duplicates = paths.filter((path, index) => paths.indexOf(path) !== index).map((path) => `duplicate output path ${path}`);
  return errors.length + duplicates.length > 0
    ? { ok: false, errors: [...errors, ...duplicates] }
    : { ok: true, value: { units, outputs: outputs.flatMap((output) => (output.ok ? [output.value] : [])) } };
};
