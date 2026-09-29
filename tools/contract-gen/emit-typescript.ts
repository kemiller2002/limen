// TypeScript emitter: closed discriminated unions for the host, plus a strict
// generated decoder for every type. The decoder is the only sanctioned way to
// turn untrusted wire JSON into a contract value in handwritten host code.

import { inheritedTags, jsonKindOf, type ContractUnit, type Field, type Inherited, type TypeDecl, type TypeExpr, type Variant } from "./model.ts";

const lines = (...parts: readonly (string | readonly string[])[]): string => parts.flat().join("\n");

const docComment = (doc: string | undefined, indent = ""): readonly string[] =>
  doc === undefined ? [] : [`${indent}/** ${doc.replace(/\*\//g, "*\\/")} */`];

const brandKey = (name: string): string => `__${name.charAt(0).toLowerCase()}${name.slice(1)}`;

const TS_PRIMITIVES: Readonly<Record<Extract<TypeExpr, { kind: "primitive" }>["name"], string>> = {
  string: "string",
  int: "number",
  number: "number",
  bool: "boolean",
  json: "unknown",
};

// Decls lets a reference to an enum be written inline as its literal union,
// which is how the public TypeScript protocol has always spelled a reason:
// `reason: "network" | "aborted" | "invalid-response"`. The named enum type is
// still exported for code that wants to name it.
type Decls = ReadonlyMap<string, TypeDecl>;

export const tsType = (type: TypeExpr, decls: Decls): string => {
  switch (type.kind) {
    case "primitive": return TS_PRIMITIVES[type.name];
    case "ref": return type.name;
    case "list": return `readonly ${wrapUnion(tsType(type.of, decls))}[]`;
    case "map": return `Readonly<Record<string, ${tsType(type.of, decls)}>>`;
    case "nullable": return `${tsType(type.of, decls)} | null`;
    case "literal": return JSON.stringify(type.value);
  }
};

const wrapUnion = (text: string): string => (text.includes("|") ? `(${text})` : text);

// Only a field's own enum reference is inlined; an enum inside a list or map
// keeps its name (`capabilities: readonly Capability[]`).
const fieldType = (type: TypeExpr, decls: Decls): string => {
  const decl = type.kind === "ref" ? decls.get(type.name) : undefined;
  return decl?.kind === "enum" ? decl.values.map((value) => JSON.stringify(value)).join(" | ") : tsType(type, decls);
};

const tsField = (field: Field, decls: Decls): string =>
  `readonly ${field.name}${field.optional ? "?" : ""}: ${fieldType(field.type, decls)}`;

const objectType = (prefix: readonly string[], fields: readonly Field[], decls: Decls): string =>
  `{ ${[...prefix, ...fields.map((field) => tsField(field, decls))].join("; ")} }`;

const inheritedPrefix = (inherited: Inherited | undefined): readonly string[] =>
  inherited === undefined ? [] : [`readonly ${inherited.tag}: ${JSON.stringify(inherited.value)}`];

const variantType = (decl: Extract<TypeDecl, { kind: "union" }>, variant: Variant, inherited: Inherited | undefined, decls: Decls): string =>
  variant.kind === "flatten"
    ? variant.target
    : objectType([...inheritedPrefix(inherited), `readonly ${decl.tag}: ${JSON.stringify(variant.name)}`], variant.fields, decls);

const emitTypeDecl = (decl: TypeDecl, inherited: ReadonlyMap<string, Inherited>, decls: Decls): string => {
  const doc = docComment(decl.doc);
  switch (decl.kind) {
    case "brand":
      return lines(doc, `export type ${decl.name} = ${decl.of === "int" ? "number" : "string"} & { readonly ${brandKey(decl.name)}: unique symbol };`);
    case "enum":
      return lines(doc, `export type ${decl.name} = ${decl.values.map((value) => JSON.stringify(value)).join(" | ")};`);
    case "record":
      return lines(doc, `export type ${decl.name} = ${objectType(inheritedPrefix(inherited.get(decl.name)), decl.fields, decls)};`);
    case "union":
      return lines(doc, `export type ${decl.name} =`, decl.variants.map((variant, index) =>
        `  | ${variantType(decl, variant, inherited.get(decl.name), decls)}${index === decl.variants.length - 1 ? ";" : ""}`));
    case "shape-union":
      return lines(doc, `export type ${decl.name} = ${decl.variants.map((variant) => tsType(variant.type, decls)).join(" | ")};`);
    case "map":
      return lines(doc, `export type ${decl.name} = { readonly [key: string]: ${tsType(decl.of, decls)} };`);
  }
};

export const emitTypeScriptTypes = (unit: ContractUnit): string => {
  const inherited = inheritedTags(unit.types);
  const decls = new Map(unit.types.map((decl) => [decl.name, decl] as const));
  return lines(
    docComment(unit.doc),
    "",
    unit.constants.map((constant) => lines(docComment(constant.doc), `export const ${constant.name} = ${JSON.stringify(constant.value)} as const;`)).join("\n\n"),
    "",
    "/** The identity of this generated contract unit, exchanged in the handshake. */",
    `export const CONTRACT_IDENTITY = { unit: ${JSON.stringify(unit.unit)}, version: ${unit.version}, fingerprint: ${JSON.stringify(unit.fingerprint)} } as const;`,
    ...(unit.role === "capability" ? [
      "",
      "/** What a host offers, and an engine selects, to use this capability. */",
      `export const CAPABILITY_OFFER = { id: ${JSON.stringify(unit.unit)}, version: ${unit.version}, fingerprint: ${JSON.stringify(unit.fingerprint)} } as const;`,
    ] : []),
    "",
    unit.types.map((decl) => emitTypeDecl(decl, inherited, decls)).join("\n\n"),
    "",
  );
};

// --- Codec ----------------------------------------------------------------

const decoderName = (name: string): string => `decode${name}`;

const decodeExpr = (type: TypeExpr, value: string, path: string): string => {
  switch (type.kind) {
    case "primitive": return `${type.name}Value(${value}, ${path})`;
    case "ref": return `${decoderName(type.name)}(${value}, ${path})`;
    case "list": return `listOf(${value}, ${path}, (item, at) => ${decodeExpr(type.of, "item", "at")})`;
    case "map": return `mapOf(${value}, ${path}, (item, at) => ${decodeExpr(type.of, "item", "at")})`;
    case "nullable": return `${value} === null ? ok(null) : ${decodeExpr(type.of, value, path)}`;
    case "literal": return `literalValue(${value}, ${path}, ${JSON.stringify(type.value)})`;
  }
};

// Decodes an object with a closed key set, one field at a time, returning the
// first error. Generated imperative-looking code, but every binding is const
// and nothing is mutated.
const objectDecoderBody = (typeName: string, constantKeys: readonly Inherited[], fields: readonly Field[], resultPrefix: readonly string[]): readonly string[] => {
  const keys = [...constantKeys.map((constant) => constant.tag), ...fields.map((field) => field.name)];
  return [
    `  const object = objectValue(value, path, ${JSON.stringify(keys)});`,
    "  if (!object.ok) return object;",
    ...constantKeys.flatMap((constant) => [
      `  const ${constant.tag}Tag = literalValue(object.value[${JSON.stringify(constant.tag)}], \`\${path}.${constant.tag}\`, ${JSON.stringify(constant.value)});`,
      `  if (!${constant.tag}Tag.ok) return ${constant.tag}Tag;`,
    ]),
    ...fields.flatMap((field) => {
      const access = `object.value[${JSON.stringify(field.name)}]`;
      const at = `\`\${path}.${field.name}\``;
      const local = `field_${field.name}`;
      return field.optional
        ? [`  const ${local} = ${access} === undefined ? ok(undefined) : ${decodeExpr(field.type, access, at)};`, `  if (!${local}.ok) return ${local};`]
        : [`  const ${local} = ${decodeExpr(field.type, access, at)};`, `  if (!${local}.ok) return ${local};`];
    }),
    `  return ok<${typeName}>({ ${[
      ...resultPrefix,
      ...fields.map((field) => field.optional
        ? `...(field_${field.name}.value !== undefined ? { ${field.name}: field_${field.name}.value } : {})`
        : `${field.name}: field_${field.name}.value`),
    ].join(", ")} });`,
  ];
};

const emitDecoder = (decl: TypeDecl, inherited: ReadonlyMap<string, Inherited>, decls: ReadonlyMap<string, TypeDecl>): string => {
  const header = `export const ${decoderName(decl.name)} = (value: unknown, path = "$"): Decoded<${decl.name}> =>`;
  const parent = inherited.get(decl.name);
  const parentConstant = parent === undefined ? [] : [parent];
  const parentPrefix = parent === undefined ? [] : [`${parent.tag}: ${JSON.stringify(parent.value)}`];
  switch (decl.kind) {
    case "brand":
      return `${header} brand<${decl.name}>(${decl.of}Value(value, path));`;
    case "enum":
      return `${header} enumValue(value, path, ${JSON.stringify(decl.values)} as const);`;
    case "map":
      return `${header} mapOf(value, path, (item, at) => ${decodeExpr(decl.of, "item", "at")});`;
    case "shape-union":
      return lines(
        `${header} {`,
        "  switch (jsonKind(value)) {",
        decl.variants.map((variant) => `    case ${JSON.stringify(jsonKindOf(variant.type, decls))}: return ${decodeExpr(variant.type, "value", "path")};`),
        `    default: return mismatch(path, ${JSON.stringify(decl.variants.map((variant) => jsonKindOf(variant.type, decls)).join(" | "))}, value);`,
        "  }",
        "};",
      );
    case "record":
      return lines(`${header} {`, objectDecoderBody(decl.name, parentConstant, decl.fields, parentPrefix), "};");
    case "union":
      return lines(
        `${header} {`,
        "  const object = objectValue(value, path, null);",
        "  if (!object.ok) return object;",
        `  const tag = object.value[${JSON.stringify(decl.tag)}];`,
        "  switch (tag) {",
        decl.variants.map((variant) => variant.kind === "flatten"
          ? `    case ${JSON.stringify(variant.name)}: return ${decoderName(variant.target)}(value, path);`
          : `    case ${JSON.stringify(variant.name)}: return ${decoderName(decl.name)}_${safe(variant.name)}(value, path);`),
        `    default: return unknownVariant(\`\${path}.${decl.tag}\`, ${JSON.stringify(decl.variants.map((variant) => variant.name))}, tag);`,
        "  }",
        "};",
        ...decl.variants.flatMap((variant) => variant.kind === "flatten" ? [] : [
          "",
          `const ${decoderName(decl.name)}_${safe(variant.name)} = (value: unknown, path: string): Decoded<${decl.name}> => {`,
          ...objectDecoderBody(decl.name, [...parentConstant, { tag: decl.tag, value: variant.name }], variant.fields, [...parentPrefix, `${decl.tag}: ${JSON.stringify(variant.name)}`]),
          "};",
        ]),
      );
  }
};

const safe = (name: string): string => name.replace(/[^A-Za-z0-9]/g, "_");

const CODEC_RUNTIME = `/** Where decoding stopped, and what the contract expected there. */
export type DecodeError = { readonly path: string; readonly expected: string; readonly found: string };
export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DecodeError };

const ok = <T>(value: T): Decoded<T> => ({ ok: true, value });

const jsonKind = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const mismatch = <T>(path: string, expected: string, value: unknown): Decoded<T> =>
  ({ ok: false, error: { path, expected, found: jsonKind(value) } });

const unknownVariant = <T>(path: string, variants: readonly string[], found: unknown): Decoded<T> =>
  ({ ok: false, error: { path, expected: \`one of \${variants.join(" | ")}\`, found: typeof found === "string" ? JSON.stringify(found) : jsonKind(found) } });

const stringValue = (value: unknown, path: string): Decoded<string> =>
  typeof value === "string" ? ok(value) : mismatch(path, "string", value);

const intValue = (value: unknown, path: string): Decoded<number> =>
  typeof value === "number" && Number.isSafeInteger(value) ? ok(value) : mismatch(path, "integer", value);

const numberValue = (value: unknown, path: string): Decoded<number> =>
  typeof value === "number" && Number.isFinite(value) ? ok(value) : mismatch(path, "finite number", value);

const boolValue = (value: unknown, path: string): Decoded<boolean> =>
  typeof value === "boolean" ? ok(value) : mismatch(path, "boolean", value);

const jsonValue = (value: unknown, path: string): Decoded<unknown> =>
  value === undefined ? mismatch(path, "a JSON value", value) : ok(value);

const literalValue = <T extends string | number>(value: unknown, path: string, expected: T): Decoded<T> =>
  value === expected ? ok(expected) : mismatch(path, JSON.stringify(expected), value);

const enumValue = <T extends string>(value: unknown, path: string, values: readonly T[]): Decoded<T> => {
  const found = values.find((candidate) => candidate === value);
  return found === undefined ? unknownVariant(path, values, value) : ok(found);
};

// The one sanctioned assertion: a decoded primitive becomes its brand.
const brand = <B>(decoded: Decoded<string> | Decoded<number>): Decoded<B> =>
  decoded.ok ? ok(decoded.value as unknown as B) : decoded;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A closed key set: an unexpected field is corrupted or mismatched wire data,
// never silently ignored. \`null\` means the caller dispatches on a tag first.
const objectValue = (value: unknown, path: string, keys: readonly string[] | null): Decoded<Readonly<Record<string, unknown>>> => {
  if (!isPlainObject(value)) return mismatch(path, "object", value);
  // Sorted, so every language reports the same first unexpected field.
  const unexpected = keys === null ? undefined : Object.keys(value).sort().find((key) => !keys.includes(key));
  return unexpected === undefined ? ok(value) : { ok: false, error: { path: \`\${path}.\${unexpected}\`, expected: "no such field", found: "unexpected field" } };
};

const listOf = <T>(value: unknown, path: string, item: (value: unknown, path: string) => Decoded<T>): Decoded<readonly T[]> => {
  if (!Array.isArray(value)) return mismatch(path, "array", value);
  const decoded = value.map((entry, index) => item(entry, \`\${path}[\${index}]\`));
  const failed = decoded.find((entry) => !entry.ok);
  return failed !== undefined && !failed.ok ? failed : ok(decoded.flatMap((entry) => (entry.ok ? [entry.value] : [])));
};

const mapOf = <T>(value: unknown, path: string, item: (value: unknown, path: string) => Decoded<T>): Decoded<Readonly<Record<string, T>>> => {
  if (!isPlainObject(value)) return mismatch(path, "object", value);
  // Sorted, so every language reports the same first failing entry.
  const decoded = Object.keys(value).sort().map((key) => [key, item(value[key], \`\${path}[\${JSON.stringify(key)}]\`)] as const);
  const failed = decoded.find(([, entry]) => !entry.ok);
  return failed !== undefined && !failed[1].ok ? failed[1] : ok(Object.fromEntries(decoded.flatMap(([key, entry]) => (entry.ok ? [[key, entry.value] as const] : []))));
};`;

export const emitTypeScriptCodec = (unit: ContractUnit, typesModule: string): string => {
  const inherited = inheritedTags(unit.types);
  const decls = new Map(unit.types.map((decl) => [decl.name, decl] as const));
  return lines(
    `import type { ${unit.types.map((decl) => decl.name).join(", ")} } from ${JSON.stringify(typesModule)};`,
    "",
    CODEC_RUNTIME,
    "",
    unit.types.map((decl) => emitDecoder(decl, inherited, decls)).join("\n\n"),
    "",
  );
};
