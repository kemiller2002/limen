// The Limen contract language: a small, language-neutral algebraic model.
//
// A contract unit is plain JSON. This module turns that JSON into a validated,
// immutable model, or into a list of precise errors — never into a partially
// trusted value. Every emitter consumes only the validated model.

import { createHash } from "node:crypto";

export type Primitive = "string" | "int" | "number" | "bool" | "json";

export type TypeExpr =
  | { readonly kind: "primitive"; readonly name: Primitive }
  | { readonly kind: "ref"; readonly name: string }
  | { readonly kind: "list"; readonly of: TypeExpr }
  | { readonly kind: "map"; readonly of: TypeExpr }
  | { readonly kind: "nullable"; readonly of: TypeExpr }
  | { readonly kind: "literal"; readonly value: string | number };

export type Field = {
  readonly name: string;
  readonly type: TypeExpr;
  readonly optional: boolean;
  readonly doc: string | undefined;
};

export type Variant =
  | { readonly kind: "inline"; readonly name: string; readonly fields: readonly Field[]; readonly doc: string | undefined }
  | { readonly kind: "flatten"; readonly name: string; readonly target: string; readonly doc: string | undefined };

export type ShapeVariant = { readonly name: string; readonly type: TypeExpr };

export type TypeDecl =
  | { readonly kind: "brand"; readonly name: string; readonly of: Primitive; readonly doc: string | undefined }
  | { readonly kind: "enum"; readonly name: string; readonly values: readonly string[]; readonly doc: string | undefined }
  | { readonly kind: "record"; readonly name: string; readonly fields: readonly Field[]; readonly doc: string | undefined }
  | { readonly kind: "union"; readonly name: string; readonly tag: string; readonly variants: readonly Variant[]; readonly doc: string | undefined }
  | { readonly kind: "shape-union"; readonly name: string; readonly variants: readonly ShapeVariant[]; readonly doc: string | undefined }
  | { readonly kind: "map"; readonly name: string; readonly of: TypeExpr; readonly doc: string | undefined };

export type Constant = { readonly name: string; readonly type: "int" | "string"; readonly value: number | string; readonly doc: string | undefined };

// A core unit defines the envelope. A capability unit defines one optional
// pack's request/result/fact types; its identity is the capability's identity.
export type UnitRole = "core" | "capability";

export type ContractUnit = {
  readonly unit: string;
  readonly role: UnitRole;
  readonly version: number;
  readonly doc: string | undefined;
  readonly constants: readonly Constant[];
  readonly types: readonly TypeDecl[];
  readonly source: string;
  readonly fingerprint: string;
};

// A flattened type inherits its parent's tag as a constant field. This is
// derived once from the model so emitters never have to rediscover it.
export type Inherited = { readonly tag: string; readonly value: string };

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

const PRIMITIVES: readonly Primitive[] = ["string", "int", "number", "bool", "json"];
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*$/;
const WIRE_NAME = /^[a-z][A-Za-z0-9-]*$|^[A-Z][A-Za-z0-9]*$/;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const docOf = (value: Readonly<Record<string, unknown>>): string | undefined =>
  typeof value.doc === "string" ? value.doc : undefined;

const fail = <T>(...errors: string[]): Parsed<T> => ({ ok: false, errors });
const succeed = <T>(value: T): Parsed<T> => ({ ok: true, value });

const collect = <T>(results: readonly Parsed<T>[]): Parsed<readonly T[]> => {
  const errors = results.flatMap((result) => (result.ok ? [] : result.errors));
  return errors.length > 0 ? fail(...errors) : succeed(results.flatMap((result) => (result.ok ? [result.value] : [])));
};

export const parseTypeExpr = (raw: unknown, at: string): Parsed<TypeExpr> => {
  if (typeof raw === "string") {
    return (PRIMITIVES as readonly string[]).includes(raw)
      ? succeed({ kind: "primitive", name: raw as Primitive })
      : IDENTIFIER.test(raw) ? succeed({ kind: "ref", name: raw }) : fail(`${at}: "${raw}" is neither a primitive nor a type name`);
  }
  if (!isRecord(raw)) return fail(`${at}: a type must be a string or an object`);
  const keys = Object.keys(raw);
  if (keys.length !== 1) return fail(`${at}: a composite type has exactly one key, found ${JSON.stringify(keys)}`);
  const [key] = keys;
  const inner = raw[key as string];
  switch (key) {
    case "list":
    case "map":
    case "nullable": {
      const parsed = parseTypeExpr(inner, `${at}.${key}`);
      return parsed.ok ? succeed({ kind: key, of: parsed.value }) : parsed;
    }
    case "literal":
      return typeof inner === "string" || (typeof inner === "number" && Number.isInteger(inner))
        ? succeed({ kind: "literal", value: inner })
        : fail(`${at}: a literal is a string or an integer`);
    default:
      return fail(`${at}: unknown composite type "${key}"`);
  }
};

const parseField = (raw: unknown, at: string): Parsed<Field> => {
  if (!isRecord(raw)) return fail(`${at}: a field must be an object`);
  if (typeof raw.name !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(raw.name)) return fail(`${at}: field name must be camelCase`);
  const type = parseTypeExpr(raw.type, `${at}.${raw.name}`);
  if (!type.ok) return type;
  if (raw.optional !== undefined && typeof raw.optional !== "boolean") return fail(`${at}.${raw.name}: optional must be a boolean`);
  // "absent" and "null" are different wire facts; a field that could be both
  // would need two layers of option in every guest language.
  if (raw.optional === true && type.value.kind === "nullable") return fail(`${at}.${raw.name}: a field cannot be both optional and nullable`);
  return succeed({ name: raw.name, type: type.value, optional: raw.optional === true, doc: docOf(raw) });
};

const parseFields = (raw: unknown, at: string): Parsed<readonly Field[]> =>
  Array.isArray(raw) ? collect(raw.map((field, index) => parseField(field, `${at}[${index}]`))) : fail(`${at}: fields must be an array`);

const parseVariant = (raw: unknown, at: string): Parsed<Variant> => {
  if (!isRecord(raw) || typeof raw.name !== "string" || !WIRE_NAME.test(raw.name)) return fail(`${at}: a variant needs a name`);
  if (typeof raw.flatten === "string") return succeed({ kind: "flatten", name: raw.name, target: raw.flatten, doc: docOf(raw) });
  const fields = parseFields(raw.fields, `${at}.${raw.name}.fields`);
  return fields.ok ? succeed({ kind: "inline", name: raw.name, fields: fields.value, doc: docOf(raw) }) : fields;
};

const parseShapeVariant = (raw: unknown, at: string): Parsed<ShapeVariant> => {
  if (!isRecord(raw) || typeof raw.name !== "string" || !IDENTIFIER.test(raw.name)) return fail(`${at}: a shape variant needs a PascalCase name`);
  const type = parseTypeExpr(raw.type, `${at}.${raw.name}`);
  return type.ok ? succeed({ name: raw.name, type: type.value }) : type;
};

const parseDecl = (raw: unknown, at: string): Parsed<TypeDecl> => {
  if (!isRecord(raw) || typeof raw.name !== "string" || !/^[A-Z][A-Za-z0-9]*$/.test(raw.name)) return fail(`${at}: a type needs a PascalCase name`);
  const name = raw.name;
  const doc = docOf(raw);
  const here = `${at}(${name})`;
  switch (raw.kind) {
    case "brand":
      return typeof raw.of === "string" && (["string", "int"] as readonly string[]).includes(raw.of)
        ? succeed({ kind: "brand", name, of: raw.of as Primitive, doc })
        : fail(`${here}: a brand wraps string or int`);
    case "enum":
      return Array.isArray(raw.values) && raw.values.length > 0 && raw.values.every((value) => typeof value === "string" && WIRE_NAME.test(value))
        ? new Set(raw.values).size === raw.values.length
          ? succeed({ kind: "enum", name, values: raw.values as string[], doc })
          : fail(`${here}: duplicate enum value`)
        : fail(`${here}: an enum needs a non-empty list of wire names`);
    case "record": {
      const fields = parseFields(raw.fields, `${here}.fields`);
      return fields.ok ? succeed({ kind: "record", name, fields: fields.value, doc }) : fields;
    }
    case "union": {
      if (typeof raw.tag !== "string" || !/^[a-z][A-Za-z0-9]*$/.test(raw.tag)) return fail(`${here}: a union needs a camelCase tag field`);
      if (!Array.isArray(raw.variants) || raw.variants.length === 0) return fail(`${here}: a union needs variants`);
      const variants = collect(raw.variants.map((variant, index) => parseVariant(variant, `${here}.variants[${index}]`)));
      return variants.ok ? succeed({ kind: "union", name, tag: raw.tag, variants: variants.value, doc }) : variants;
    }
    case "shape-union": {
      if (!Array.isArray(raw.variants) || raw.variants.length === 0) return fail(`${here}: a shape-union needs variants`);
      const variants = collect(raw.variants.map((variant, index) => parseShapeVariant(variant, `${here}.variants[${index}]`)));
      return variants.ok ? succeed({ kind: "shape-union", name, variants: variants.value, doc }) : variants;
    }
    case "map": {
      const of = parseTypeExpr(raw.of, `${here}.of`);
      return of.ok ? succeed({ kind: "map", name, of: of.value, doc }) : of;
    }
    default:
      return fail(`${here}: unknown type kind ${JSON.stringify(raw.kind)}`);
  }
};

const parseConstant = (raw: unknown, at: string): Parsed<Constant> => {
  if (!isRecord(raw) || typeof raw.name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(raw.name)) return fail(`${at}: a constant needs an UPPER_SNAKE name`);
  if (raw.type === "int" && typeof raw.value === "number" && Number.isInteger(raw.value)) return succeed({ name: raw.name, type: "int", value: raw.value, doc: docOf(raw) });
  if (raw.type === "string" && typeof raw.value === "string") return succeed({ name: raw.name, type: "string", value: raw.value, doc: docOf(raw) });
  return fail(`${at}(${raw.name}): constant value does not match its type`);
};

// --- Well-formedness ------------------------------------------------------

// JSON value kinds a shape-union can dispatch on. Two variants with the same
// JSON kind would make decoding ambiguous, so they are rejected up front.
export const jsonKindOf = (type: TypeExpr, decls: ReadonlyMap<string, TypeDecl>): string => {
  switch (type.kind) {
    case "primitive": return type.name === "int" ? "number" : type.name === "bool" ? "boolean" : type.name === "json" ? "any" : type.name;
    case "list": return "array";
    case "map": return "object";
    case "nullable": return "any";
    case "literal": return typeof type.value;
    case "ref": {
      const decl = decls.get(type.name);
      if (decl === undefined) return "any";
      switch (decl.kind) {
        case "brand": return decl.of === "int" ? "number" : "string";
        case "enum": return "string";
        default: return "object";
      }
    }
  }
};

const referencedNames = (type: TypeExpr): readonly string[] => {
  switch (type.kind) {
    case "ref": return [type.name];
    case "list": case "map": case "nullable": return referencedNames(type.of);
    default: return [];
  }
};

const declReferences = (decl: TypeDecl): readonly string[] => {
  switch (decl.kind) {
    case "record": return decl.fields.flatMap((field) => referencedNames(field.type));
    case "union": return decl.variants.flatMap((variant) => variant.kind === "flatten" ? [variant.target] : variant.fields.flatMap((field) => referencedNames(field.type)));
    case "shape-union": return decl.variants.flatMap((variant) => referencedNames(variant.type));
    case "map": return referencedNames(decl.of);
    default: return [];
  }
};

export const inheritedTags = (types: readonly TypeDecl[]): ReadonlyMap<string, Inherited> =>
  new Map(types.flatMap((decl) =>
    decl.kind === "union"
      ? decl.variants.flatMap((variant) => variant.kind === "flatten" ? [[variant.target, { tag: decl.tag, value: variant.name }] as const] : [])
      : []));

const fieldNamesOf = (decl: TypeDecl, variant: Variant | undefined): readonly string[] =>
  variant?.kind === "inline" ? variant.fields.map((field) => field.name)
    : decl.kind === "record" ? decl.fields.map((field) => field.name)
      : [];

const wellFormednessErrors = (types: readonly TypeDecl[]): readonly string[] => {
  const decls = new Map(types.map((decl) => [decl.name, decl] as const));
  const duplicateNames = types.filter((decl, index) => types.findIndex((other) => other.name === decl.name) !== index).map((decl) => `duplicate type ${decl.name}`);
  const unresolved = types.flatMap((decl) => declReferences(decl).filter((name) => !decls.has(name)).map((name) => `${decl.name}: unresolved reference ${name}`));
  const flattenCounts = types.flatMap((decl) => decl.kind === "union" ? decl.variants.flatMap((variant) => variant.kind === "flatten" ? [variant.target] : []) : []);
  const flattenErrors = [
    ...flattenCounts.filter((name, index) => flattenCounts.indexOf(name) !== index).map((name) => `${name}: may be flattened into at most one union`),
    ...types.flatMap((decl) => decl.kind !== "union" ? [] : decl.variants.flatMap((variant) => {
      if (variant.kind !== "flatten") return [];
      const target = decls.get(variant.target);
      if (target === undefined) return [];
      if (target.kind !== "record" && target.kind !== "union") return [`${decl.name}.${variant.name}: only a record or union can be flattened`];
      if (target.kind === "union" && target.tag === decl.tag) return [`${decl.name}.${variant.name}: flattened union must use a different tag than "${decl.tag}"`];
      const clashes = target.kind === "record"
        ? target.fields.some((field) => field.name === decl.tag)
        : target.variants.some((inner) => fieldNamesOf(target, inner).includes(decl.tag));
      return clashes ? [`${decl.name}.${variant.name}: flattened type already declares field "${decl.tag}"`] : [];
    })),
  ];
  const tagErrors = types.flatMap((decl) => decl.kind !== "union" ? [] : [
    ...decl.variants.filter((variant, index) => decl.variants.findIndex((other) => other.name === variant.name) !== index).map((variant) => `${decl.name}: duplicate variant ${variant.name}`),
    ...decl.variants.flatMap((variant) => fieldNamesOf(decl, variant).includes(decl.tag) ? [`${decl.name}.${variant.name}: field shadows tag "${decl.tag}"`] : []),
  ]);
  const shapeErrors = types.flatMap((decl) => {
    if (decl.kind !== "shape-union") return [];
    const kinds = decl.variants.map((variant) => jsonKindOf(variant.type, decls));
    return [
      ...(kinds.includes("any") ? [`${decl.name}: shape-union variants must have a definite JSON kind`] : []),
      ...kinds.filter((kind, index) => kinds.indexOf(kind) !== index).map((kind) => `${decl.name}: two variants share JSON kind ${kind}`),
    ];
  });
  const recordFieldErrors = types.flatMap((decl) => {
    const lists = decl.kind === "record" ? [decl.fields] : decl.kind === "union" ? decl.variants.flatMap((variant) => variant.kind === "inline" ? [variant.fields] : []) : [];
    return lists.flatMap((fields) => fields.filter((field, index) => fields.findIndex((other) => other.name === field.name) !== index).map((field) => `${decl.name}: duplicate field ${field.name}`));
  });
  return [...duplicateNames, ...unresolved, ...flattenErrors, ...tagErrors, ...shapeErrors, ...recordFieldErrors];
};

// --- Canonical form and fingerprint --------------------------------------

// Canonical JSON: object keys sorted, documentation removed, no whitespace.
// Documentation is excluded on purpose: rewording a comment must not make two
// otherwise identical contracts incompatible.
export const canonicalize = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value).filter((key) => key !== "doc").sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

export const sha256 = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

export const fingerprintOf = (raw: unknown): string => sha256(canonicalize(raw));

export const parseUnit = (raw: unknown, source: string): Parsed<ContractUnit> => {
  if (!isRecord(raw)) return fail(`${source}: a contract unit must be a JSON object`);
  if (typeof raw.unit !== "string" || !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/.test(raw.unit)) return fail(`${source}: unit must be a dotted lower-case identity such as limen.core`);
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return fail(`${source}: version must be a positive integer`);
  if (raw.role !== "core" && raw.role !== "capability") return fail(`${source}: role must be "core" or "capability"`);
  const role: UnitRole = raw.role;
  const constants = Array.isArray(raw.constants ?? []) ? collect(((raw.constants ?? []) as unknown[]).map((constant, index) => parseConstant(constant, `${source}.constants[${index}]`))) : fail<readonly Constant[]>(`${source}: constants must be an array`);
  const types = Array.isArray(raw.types) ? collect(raw.types.map((decl, index) => parseDecl(decl, `${source}.types[${index}]`))) : fail<readonly TypeDecl[]>(`${source}: types must be an array`);
  if (!constants.ok || !types.ok) return fail(...(constants.ok ? [] : constants.errors), ...(types.ok ? [] : types.errors));
  const errors = wellFormednessErrors(types.value);
  return errors.length > 0
    ? fail(...errors.map((error) => `${source}: ${error}`))
    : succeed({ unit: raw.unit, role, version: raw.version, doc: docOf(raw), constants: constants.value, types: types.value, source, fingerprint: fingerprintOf(raw) });
};
