// C# emitter. Unions become abstract records whose only constructor is
// private, so the nested sealed records are the complete, closed set of
// variants. C# cannot prove a `switch` over such a hierarchy exhaustive, so
// every union also gets a generated `Match` whose parameters are one function
// per variant: adding a variant to the contract adds a parameter, and every
// call site stops compiling until it handles it. `#nullable enable` makes
// absence explicit; literal-valued fields do not exist in the types at all.

import { inheritedTags, jsonKindOf, type ContractUnit, type Field, type Inherited, type TypeDecl, type TypeExpr, type Variant } from "./model.ts";
import { camel, pascal, quoted, unitSegments } from "./naming.ts";

type Decls = ReadonlyMap<string, TypeDecl>;

const lines = (...parts: readonly (string | readonly string[])[]): string => parts.flat().join("\n");
const indent = (depth: number, text: string): string => `${"    ".repeat(depth)}${text}`;
const escapeXml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const doc = (text: string | undefined, depth: number): readonly string[] =>
  text === undefined ? [] : [indent(depth, `/// <summary>${escapeXml(text)}</summary>`)];

const CSHARP_KEYWORDS = new Set([
  "abstract", "as", "base", "bool", "break", "byte", "case", "catch", "char", "checked", "class", "const", "continue", "decimal", "default", "delegate",
  "do", "double", "else", "enum", "event", "explicit", "extern", "false", "finally", "fixed", "float", "for", "foreach", "goto", "if", "implicit", "in",
  "int", "interface", "internal", "is", "lock", "long", "namespace", "new", "null", "object", "operator", "out", "override", "params", "private",
  "protected", "public", "readonly", "ref", "return", "sbyte", "sealed", "short", "sizeof", "stackalloc", "static", "string", "struct", "switch",
  "this", "throw", "true", "try", "typeof", "uint", "ulong", "unchecked", "unsafe", "ushort", "using", "virtual", "void", "volatile", "while",
]);
const identifier = (name: string): string => (CSHARP_KEYWORDS.has(name) ? `@${name}` : name);

export const csNamespace = (unit: ContractUnit): string => ["Limen", "Contract", ...unitSegments(unit.unit).slice(1)].join(".");

const isLiteral = (field: Field): boolean => field.type.kind === "literal";
const dataFields = (fields: readonly Field[]): readonly Field[] => fields.filter((field) => !isLiteral(field));

// Every reference is fully qualified: a nested variant record may share a name
// with a top-level type (BrowserToEngineMessage.EffectResult vs EffectResult).
const csType = (type: TypeExpr, decls: Decls, ns: string): string => {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return "string";
        case "int": return "long";
        case "number": return "double";
        case "bool": return "bool";
        case "json": return "global::Limen.Contract.RawJson";
      }
      return "never";
    case "ref": {
      const decl = decls.get(type.name);
      return decl?.kind === "map" ? `global::System.Collections.Generic.IReadOnlyDictionary<string, ${csType(decl.of, decls, ns)}>` : `global::${ns}.${type.name}`;
    }
    case "list": return `global::System.Collections.Generic.IReadOnlyList<${csType(type.of, decls, ns)}>`;
    case "map": return `global::System.Collections.Generic.IReadOnlyDictionary<string, ${csType(type.of, decls, ns)}>`;
    case "nullable": return `${csType(type.of, decls, ns)}?`;
    case "literal": return "never";
  }
};

const fieldType = (field: Field, decls: Decls, ns: string): string =>
  field.optional ? `${csType(field.type, decls, ns)}?` : csType(field.type, decls, ns);

// A C# member cannot share its enclosing type's name, so the one field of
// BrowserToEngineMessage.Event named "event" becomes EventValue. The rule is
// mechanical and applies only to that collision.
const memberName = (owner: string, field: Field): string =>
  pascal(field.name) === owner ? `${pascal(field.name)}Value` : pascal(field.name);

const parameters = (owner: string, fields: readonly Field[], decls: Decls, ns: string): string =>
  dataFields(fields).map((field) => `${fieldType(field, decls, ns)} ${memberName(owner, field)}`).join(", ");

const variantRecord = (union: string, variant: Variant, decls: Decls, ns: string): readonly string[] =>
  variant.kind === "flatten"
    ? [indent(1, `public sealed record ${pascal(variant.name)}(global::${ns}.${variant.target} Value) : ${union};`)]
    : [...doc(variant.doc, 1), indent(1, `public sealed record ${pascal(variant.name)}(${parameters(pascal(variant.name), variant.fields, decls, ns)}) : ${union};`)];

const matchMethod = (union: string, cases: readonly string[]): readonly string[] => [
  "",
  indent(1, "/// <summary>Exhaustive by construction: one handler per variant, so a new variant is a compile error at every call site.</summary>"),
  indent(1, `public TResult Match<TResult>(${cases.map((name) => `global::System.Func<${name}, TResult> ${identifier(camel(name))}`).join(", ")}) => this switch`),
  indent(1, "{"),
  ...cases.map((name) => indent(2, `${name} value => ${identifier(camel(name))}(value),`)),
  indent(2, `_ => throw new global::System.InvalidOperationException("${union} is a closed hierarchy."),`),
  indent(1, "};"),
];

const closedUnion = (name: string, docText: string | undefined, body: readonly string[], cases: readonly string[]): readonly string[] => [
  ...doc(docText, 0),
  "[global::Limen.Contract.ClosedUnion]",
  `public abstract record ${name}`,
  "{",
  indent(1, `private ${name}() { }`),
  "",
  ...body,
  ...matchMethod(name, cases),
  "}",
];

const typeDecl = (decl: TypeDecl, decls: Decls, ns: string): readonly string[] => {
  switch (decl.kind) {
    case "brand":
      return [...doc(decl.doc, 0), `public readonly record struct ${decl.name}(${decl.of === "int" ? "long" : "string"} Value);`];
    case "enum":
      return [
        ...doc(decl.doc, 0),
        "[global::Limen.Contract.ClosedUnion]",
        `public enum ${decl.name}`, "{", ...decl.values.map((value) => indent(1, `${pascal(value)},`)), "}",
        "",
        `/// <summary>Exhaustive handling of ${decl.name}: one handler per value, so a new value is a compile error at every call site.</summary>`,
        `public static class ${decl.name}Match`,
        "{",
        indent(1, `public static TResult Match<TResult>(this ${decl.name} value, ${decl.values.map((wire) => `global::System.Func<TResult> ${identifier(camel(wire))}`).join(", ")}) => value switch`),
        indent(1, "{"),
        ...decl.values.map((wire) => indent(2, `${decl.name}.${pascal(wire)} => ${identifier(camel(wire))}(),`)),
        indent(2, `_ => throw new global::System.ArgumentOutOfRangeException(nameof(value), "Not a ${decl.name} value."),`),
        indent(1, "};"),
        "}",
      ];
    case "record": {
      if (dataFields(decl.fields).length === 0) throw new Error(`C#: record ${decl.name} needs at least one non-literal field`);
      return [...doc(decl.doc, 0), `public sealed record ${decl.name}(${parameters(decl.name, decl.fields, decls, ns)});`];
    }
    case "union":
      return closedUnion(decl.name, decl.doc, decl.variants.flatMap((variant) => variantRecord(decl.name, variant, decls, ns)), decl.variants.map((variant) => pascal(variant.name)));
    case "shape-union":
      return closedUnion(decl.name, decl.doc, decl.variants.map((variant) => indent(1, `public sealed record ${variant.name}(${csType(variant.type, decls, ns)} Value) : ${decl.name};`)), decl.variants.map((variant) => variant.name));
    case "map":
      return [];
  }
};

// --- Codec ----------------------------------------------------------------

const declType = (decl: TypeDecl, decls: Decls, ns: string): string =>
  decl.kind === "map" ? csType({ kind: "map", of: decl.of }, decls, ns) : `global::${ns}.${decl.name}`;

// Readers are built as expressions over an element and a path expression;
// where a delegate is needed, the expression is wrapped in a lambda whose
// parameter names are unique by nesting depth.
const readExpr = (type: TypeExpr, decls: Decls, ns: string, element: string, path: string, depth: number): string => {
  const e = `e${depth}`;
  const p = `p${depth}`;
  const lambda = (inner: TypeExpr): string => `(${e}, ${p}) => ${readExpr(inner, decls, ns, e, p, depth + 1)}`;
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return `Wire.String(${element}, ${path})`;
        case "int": return `Wire.Int(${element}, ${path})`;
        case "number": return `Wire.Number(${element}, ${path})`;
        case "bool": return `Wire.Boolean(${element}, ${path})`;
        case "json": return `Wire.Json(${element}, ${path})`;
      }
      return "never";
    case "ref": return `Read${type.name}(${element}, ${path})`;
    case "list": return `Wire.List(${element}, ${path}, ${lambda(type.of)})`;
    case "map": return `Wire.Map(${element}, ${path}, ${lambda(type.of)})`;
    case "nullable":
      return isValueType(type.of, decls)
        ? `Wire.NullableValue<${csType(type.of, decls, ns)}>(${element}, ${path}, ${lambda(type.of)})`
        : `Wire.NullableReference<${csType(type.of, decls, ns)}>(${element}, ${path}, ${lambda(type.of)})`;
    case "literal":
      return typeof type.value === "string" ? `Wire.LiteralString(${element}, ${path}, ${quoted(type.value)})` : `Wire.LiteralInt(${element}, ${path}, ${type.value})`;
  }
};

const readLambda = (type: TypeExpr, decls: Decls, ns: string): string => `(e0, p0) => ${readExpr(type, decls, ns, "e0", "p0", 1)}`;

// Value types (long, double, bool, RawJson, enums, brands) take Nullable<T>;
// reference types take T?.
const isValueType = (type: TypeExpr, decls: Decls): boolean => {
  if (type.kind === "primitive") return type.name !== "string";
  if (type.kind !== "ref") return false;
  const decl = decls.get(type.name);
  return decl?.kind === "enum" || decl?.kind === "brand";
};

const local = (field: Field): string => `f_${field.name}`;

const objectRead = (keys: readonly string[], constants: readonly Inherited[], fields: readonly Field[], decls: Decls, ns: string, build: string, depth: number): readonly string[] => [
  indent(depth, `var props = Wire.Closed(Wire.Properties(element, path), path, ${keys.map(quoted).join(", ")});`),
  ...constants.map((constant) => indent(depth, `Wire.Required(props, path, ${quoted(constant.tag)}, (e0, p0) => Wire.LiteralString(e0, p0, ${quoted(constant.value)}));`)),
  ...fields.map((field) => {
    if (isLiteral(field)) return indent(depth, `Wire.Required(props, path, ${quoted(field.name)}, ${readLambda(field.type, decls, ns)});`);
    if (!field.optional) return indent(depth, `var ${local(field)} = Wire.Required(props, path, ${quoted(field.name)}, ${readLambda(field.type, decls, ns)});`);
    const helper = isValueType(field.type, decls) ? "OptionalValue" : "OptionalReference";
    return indent(depth, `var ${local(field)} = Wire.${helper}<${csType(field.type, decls, ns)}>(props, path, ${quoted(field.name)}, ${readLambda(field.type, decls, ns)});`);
  }),
  indent(depth, `return ${build};`),
];

const readerDecl = (decl: TypeDecl, decls: Decls, ns: string, inherited: ReadonlyMap<string, Inherited>): readonly string[] => {
  const type = declType(decl, decls, ns);
  const head = indent(1, `internal static ${type} Read${decl.name}(global::System.Text.Json.JsonElement element, string path)`);
  const parent = inherited.get(decl.name);
  const parentConstants = parent === undefined ? [] : [parent];
  switch (decl.kind) {
    case "brand":
      return [`${head} =>`, indent(2, `new ${type}(${decl.of === "int" ? "Wire.Int" : "Wire.String"}(element, path));`)];
    case "enum":
      return [`${head} =>`, indent(2, `Wire.Enumeration(element, path, ${decl.values.map((value) => `(${quoted(value)}, ${type}.${pascal(value)})`).join(", ")});`)];
    case "map":
      return [`${head} =>`, indent(2, `Wire.Map(element, path, ${readLambda(decl.of, decls, ns)});`)];
    case "shape-union":
      return [
        `${head} =>`,
        indent(2, "Wire.KindOf(element) switch"),
        indent(2, "{"),
        ...decl.variants.map((variant) => indent(3, `${quoted(jsonKindOf(variant.type, decls))} => new ${type}.${variant.name}(${readExpr(variant.type, decls, ns, "element", "path", 0)}),`)),
        indent(3, `_ => throw Wire.Mismatch(${quoted(decl.variants.map((variant) => jsonKindOf(variant.type, decls)).join(" | "))}, path, element),`),
        indent(2, "};"),
      ];
    case "record": {
      const keys = [...parentConstants.map((constant) => constant.tag), ...decl.fields.map((field) => field.name)];
      const build = `new ${type}(${dataFields(decl.fields).map(local).join(", ")})`;
      return [head, indent(1, "{"), ...objectRead(keys, parentConstants, decl.fields, decls, ns, build, 2), indent(1, "}")];
    }
    case "union":
      return [
        head,
        indent(1, "{"),
        indent(2, `switch (Wire.Tag(element, path, ${quoted(decl.tag)}))`),
        indent(2, "{"),
        ...decl.variants.flatMap((variant) => {
          if (variant.kind === "flatten") return [indent(3, `case ${quoted(variant.name)}:`), indent(4, `return new ${type}.${pascal(variant.name)}(Read${variant.target}(element, path));`)];
          const constants = [...parentConstants, { tag: decl.tag, value: variant.name }];
          const keys = [...constants.map((constant) => constant.tag), ...variant.fields.map((field) => field.name)];
          const build = `new ${type}.${pascal(variant.name)}(${dataFields(variant.fields).map(local).join(", ")})`;
          return [indent(3, `case ${quoted(variant.name)}:`), indent(3, "{"), ...objectRead(keys, constants, variant.fields, decls, ns, build, 4), indent(3, "}")];
        }),
        indent(3, "case var other:"),
        indent(4, `throw Wire.UnknownVariant(path + ${quoted(`.${decl.tag}`)}, other);`),
        indent(2, "}"),
        indent(1, "}"),
      ];
  }
};

const writeExpr = (type: TypeExpr, decls: Decls, ns: string, value: string, depth: number): string => {
  const x = `x${depth}`;
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return `Wire.OfString(${value})`;
        case "int": return `Wire.OfInt(${value})`;
        case "number": return `Wire.OfNumber(${value})`;
        case "bool": return `Wire.OfBool(${value})`;
        case "json": return `Wire.OfJson(${value})`;
      }
      return "never";
    case "ref": return `Encode${type.name}(${value})`;
    case "list": return `Wire.OfList(${value}, ${x} => ${writeExpr(type.of, decls, ns, x, depth + 1)})`;
    case "map": return `Wire.OfMap(${value}, ${x} => ${writeExpr(type.of, decls, ns, x, depth + 1)})`;
    case "nullable":
      return isValueType(type.of, decls)
        ? `(${value}.HasValue ? ${writeExpr(type.of, decls, ns, `${value}.Value`, depth + 1)} : null)`
        : `(${value} is null ? null : ${writeExpr(type.of, decls, ns, value, depth + 1)})`;
    case "literal": return "never";
  }
};

const literalNode = (value: string | number): string => (typeof value === "string" ? `Wire.OfString(${quoted(value)})` : `Wire.OfInt(${value})`);

type Entry = string;
const ENTRY = "((string, global::System.Text.Json.Nodes.JsonNode?)?)";

const entries = (constants: readonly Inherited[], fields: readonly Field[], decls: Decls, ns: string, access: (field: Field) => string): string => [
  ...constants.map((constant): Entry => `${ENTRY}(${quoted(constant.tag)}, Wire.OfString(${quoted(constant.value)}))`),
  ...fields.map((field): Entry => {
    if (field.type.kind === "literal") return `${ENTRY}(${quoted(field.name)}, ${literalNode(field.type.value)})`;
    if (!field.optional) return `${ENTRY}(${quoted(field.name)}, ${writeExpr(field.type, decls, ns, access(field), 0)})`;
    return isValueType(field.type, decls)
      ? `(${access(field)}.HasValue ? ${ENTRY}(${quoted(field.name)}, ${writeExpr(field.type, decls, ns, `${access(field)}.Value`, 0)}) : null)`
      : `(${access(field)} is null ? null : ${ENTRY}(${quoted(field.name)}, ${writeExpr(field.type, decls, ns, access(field), 0)}))`;
  }),
].join(", ");

const encoderDecl = (decl: TypeDecl, decls: Decls, ns: string, inherited: ReadonlyMap<string, Inherited>): readonly string[] => {
  const type = declType(decl, decls, ns);
  const head = indent(1, `public static global::System.Text.Json.Nodes.JsonNode? Encode${decl.name}(${type} value) =>`);
  const parent = inherited.get(decl.name);
  const parentConstants = parent === undefined ? [] : [parent];
  switch (decl.kind) {
    case "brand":
      return [head, indent(2, `${decl.of === "int" ? "Wire.OfInt" : "Wire.OfString"}(value.Value);`)];
    case "enum":
      return [head, indent(2, "value switch"), indent(2, "{"), ...decl.values.map((wire) => indent(3, `${type}.${pascal(wire)} => Wire.OfString(${quoted(wire)}),`)), indent(3, `_ => throw new global::System.ArgumentOutOfRangeException(nameof(value), "Not a ${decl.name} value."),`), indent(2, "};")];
    case "map":
      return [head, indent(2, `Wire.OfMap(value, x0 => ${writeExpr(decl.of, decls, ns, "x0", 1)});`)];
    case "shape-union":
      return [head, indent(2, "value.Match("), ...decl.variants.map((variant, index) => indent(3, `v => ${writeExpr(variant.type, decls, ns, "v.Value", 0)}${index === decl.variants.length - 1 ? ");" : ","}`))];
    case "record":
      return [head, indent(2, `Wire.OfObject(${entries(parentConstants, decl.fields, decls, ns, (field) => `value.${memberName(decl.name, field)}`)});`)];
    case "union":
      return [
        head,
        indent(2, "value.Match("),
        ...decl.variants.map((variant, index) => {
          const end = index === decl.variants.length - 1 ? ");" : ",";
          if (variant.kind === "flatten") return indent(3, `v => Encode${variant.target}(v.Value)${end}`);
          return indent(3, `v => Wire.OfObject(${entries([...parentConstants, { tag: decl.tag, value: variant.name }], variant.fields, decls, ns, (field) => `v.${memberName(pascal(variant.name), field)}`)})${end}`);
        }),
      ];
  }
};

export const emitCSharpUnit = (unit: ContractUnit): string => {
  const ns = csNamespace(unit);
  const decls: Decls = new Map(unit.types.map((decl) => [decl.name, decl] as const));
  const inherited = inheritedTags(unit.types);
  return lines(
    "#nullable enable",
    "",
    "using Limen.Contract;",
    "",
    `namespace ${ns};`,
    "",
    "/// <summary>The identity of this generated contract unit, exchanged in the handshake.</summary>",
    "public static class Contract",
    "{",
    indent(1, `public const string Unit = ${quoted(unit.unit)};`),
    indent(1, `public const long Version = ${unit.version};`),
    indent(1, `public const string Fingerprint = ${quoted(unit.fingerprint)};`),
    ...unit.constants.map((constant) => indent(1, `public const ${constant.type === "int" ? "long" : "string"} ${pascal(constant.name.toLowerCase())} = ${constant.type === "int" ? constant.value : quoted(String(constant.value))};`)),
    "}",
    "",
    unit.types.flatMap((decl) => {
      const body = typeDecl(decl, decls, ns);
      return body.length === 0 ? [] : [...body, ""];
    }),
    "/// <summary>Strict decoders (untrusted JSON → contract values) and encoders.</summary>",
    "public static class Codec",
    "{",
    ...unit.types.flatMap((decl) => [
      indent(1, `public static Decoded<${declType(decl, decls, ns)}> Decode${decl.name}(global::System.Text.Json.JsonElement element, string path = "$") => Wire.Run(() => Read${decl.name}(element, path));`),
      indent(1, `public static Decoded<${declType(decl, decls, ns)}> Parse${decl.name}(string json) => Wire.Parse(json, Read${decl.name});`),
      indent(1, `public static string Serialize${decl.name}(${declType(decl, decls, ns)} value) => Wire.Serialize(Encode${decl.name}(value));`),
      "",
    ]),
    ...unit.types.flatMap((decl) => [...readerDecl(decl, decls, ns, inherited), ""]),
    ...unit.types.flatMap((decl) => [...encoderDecl(decl, decls, ns, inherited), ""]),
    "}",
    "",
    "/// <summary>Decode-then-encode by type name. Used only by the shared conformance runner.</summary>",
    "public static class Conformance",
    "{",
    indent(1, "public static global::System.Collections.Generic.IReadOnlyDictionary<string, global::System.Func<global::System.Text.Json.JsonElement, Decoded<global::System.Text.Json.Nodes.JsonNode?>>> RoundTrips { get; } ="),
    indent(2, "new global::System.Collections.Generic.Dictionary<string, global::System.Func<global::System.Text.Json.JsonElement, Decoded<global::System.Text.Json.Nodes.JsonNode?>>>"),
    indent(2, "{"),
    ...unit.types.map((decl) => indent(3, `[${quoted(decl.name)}] = element => Wire.Run(() => Codec.Encode${decl.name}(Codec.Read${decl.name}(element, "$"))),`)),
    indent(2, "};"),
    "}",
    "",
  );
};

export const CSHARP_RUNTIME = `#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Limen.Contract;

/// <summary>Marks a generated closed union or enum. Handle it with its generated Match, never a switch: the Limen analyzer (LIMEN001) enforces this, because C# cannot prove a switch over it exhaustive.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Enum, Inherited = false)]
public sealed class ClosedUnionAttribute : Attribute
{
}

/// <summary>An opaque JSON value, filled and read only by another generated binding (a capability payload) or by the engine's own decoder (an Http body).</summary>
public readonly record struct RawJson(string Text);

/// <summary>Where decoding stopped, and what the contract expected there.</summary>
public sealed record DecodeError(string Path, string Expected, string Found);

/// <summary>The result of decoding untrusted JSON: a contract value, or where and why it failed.</summary>
public abstract record Decoded<T>
{
    private Decoded() { }

    public sealed record Ok(T Value) : Decoded<T>;
    public sealed record Failed(DecodeError Error) : Decoded<T>;

    public TResult Match<TResult>(Func<Ok, TResult> ok, Func<Failed, TResult> failed) => this switch
    {
        Ok value => ok(value),
        Failed value => failed(value),
        _ => throw new InvalidOperationException("Decoded is a closed hierarchy."),
    };
}

/// <summary>Raised inside generated readers only; never escapes a public Decode/Parse call.</summary>
public sealed class DecodeException(DecodeError error) : Exception(error.Path + ": expected " + error.Expected + ", found " + error.Found)
{
    public DecodeError Error { get; } = error;
}

/// <summary>Wire plumbing shared by every generated unit. Generic JSON appears only here.</summary>
public static class Wire
{
    private const double MaxSafeInteger = 9007199254740991.0;

    public static string KindOf(JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.Null => "null",
        JsonValueKind.Array => "array",
        JsonValueKind.Object => "object",
        JsonValueKind.String => "string",
        JsonValueKind.Number => "number",
        JsonValueKind.True or JsonValueKind.False => "boolean",
        _ => "undefined",
    };

    public static DecodeException Mismatch(string expected, string path, JsonElement element) => new(new DecodeError(path, expected, KindOf(element)));

    public static DecodeException Missing(string path) => new(new DecodeError(path, "a value", "undefined"));

    public static DecodeException UnknownVariant(string path, string found) => new(new DecodeError(path, "a known variant", JsonSerializer.Serialize(found)));

    public static Decoded<T> Run<T>(Func<T> read)
    {
        try
        {
            return new Decoded<T>.Ok(read());
        }
        catch (DecodeException failure)
        {
            return new Decoded<T>.Failed(failure.Error);
        }
    }

    public static Decoded<T> Parse<T>(string json, Func<JsonElement, string, T> read)
    {
        try
        {
            using var document = JsonDocument.Parse(json);
            return Run(() => read(document.RootElement, "$"));
        }
        catch (JsonException)
        {
            return new Decoded<T>.Failed(new DecodeError("$", "JSON text", "unparseable"));
        }
    }

    public static string String(JsonElement element, string path) =>
        element.ValueKind == JsonValueKind.String ? element.GetString()! : throw Mismatch("string", path, element);

    public static long Int(JsonElement element, string path) =>
        element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out var number) && double.IsFinite(number) && Math.Floor(number) == number && Math.Abs(number) <= MaxSafeInteger
            ? (long)number
            : throw Mismatch("integer", path, element);

    public static double Number(JsonElement element, string path) =>
        element.ValueKind == JsonValueKind.Number && element.TryGetDouble(out var number) && double.IsFinite(number)
            ? number
            : throw Mismatch("finite number", path, element);

    public static bool Boolean(JsonElement element, string path) => element.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => throw Mismatch("boolean", path, element),
    };

    public static RawJson Json(JsonElement element, string path) => new(element.GetRawText());

    public static bool LiteralString(JsonElement element, string path, string expected) =>
        element.ValueKind == JsonValueKind.String && element.GetString() == expected ? true : throw Mismatch(JsonSerializer.Serialize(expected), path, element);

    public static bool LiteralInt(JsonElement element, string path, long expected) =>
        Int(element, path) == expected ? true : throw Mismatch(expected.ToString(System.Globalization.CultureInfo.InvariantCulture), path, element);

    public static T Enumeration<T>(JsonElement element, string path, params (string Wire, T Value)[] cases) where T : struct, Enum
    {
        if (element.ValueKind != JsonValueKind.String) throw Mismatch("a known variant", path, element);
        var text = element.GetString()!;
        foreach (var (wire, value) in cases)
        {
            if (wire == text) return value;
        }
        throw UnknownVariant(path, text);
    }

    public static T? NullableReference<T>(JsonElement element, string path, Func<JsonElement, string, T> read) where T : class =>
        element.ValueKind == JsonValueKind.Null ? null : read(element, path);

    public static T? NullableValue<T>(JsonElement element, string path, Func<JsonElement, string, T> read) where T : struct =>
        element.ValueKind == JsonValueKind.Null ? null : read(element, path);

    public static IReadOnlyList<T> List<T>(JsonElement element, string path, Func<JsonElement, string, T> read) =>
        element.ValueKind == JsonValueKind.Array
            ? element.EnumerateArray().Select((item, index) => read(item, path + "[" + index.ToString(System.Globalization.CultureInfo.InvariantCulture) + "]")).ToArray()
            : throw Mismatch("array", path, element);

    public static IReadOnlyDictionary<string, JsonElement> Properties(JsonElement element, string path)
    {
        if (element.ValueKind != JsonValueKind.Object) throw Mismatch("object", path, element);
        var properties = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (var property in element.EnumerateObject()) properties[property.Name] = property.Value;
        return properties;
    }

    public static IReadOnlyDictionary<string, T> Map<T>(JsonElement element, string path, Func<JsonElement, string, T> read)
    {
        var properties = Properties(element, path);
        return properties.Keys
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToDictionary(key => key, key => read(properties[key], path + "[" + JsonSerializer.Serialize(key) + "]"), StringComparer.Ordinal);
    }

    // A closed key set: an unexpected field is corrupted or mismatched wire
    // data, never silently ignored. Reported in ordinal key order so every
    // language names the same field.
    public static IReadOnlyDictionary<string, JsonElement> Closed(IReadOnlyDictionary<string, JsonElement> properties, string path, params string[] keys)
    {
        var unexpected = properties.Keys.OrderBy(key => key, StringComparer.Ordinal).FirstOrDefault(key => !keys.Contains(key));
        return unexpected is null ? properties : throw new DecodeException(new DecodeError(path + "." + unexpected, "no such field", "unexpected field"));
    }

    public static T Required<T>(IReadOnlyDictionary<string, JsonElement> properties, string path, string name, Func<JsonElement, string, T> read) =>
        properties.TryGetValue(name, out var element) ? read(element, path + "." + name) : throw Missing(path + "." + name);

    public static T? OptionalReference<T>(IReadOnlyDictionary<string, JsonElement> properties, string path, string name, Func<JsonElement, string, T> read) where T : class =>
        properties.TryGetValue(name, out var element) ? read(element, path + "." + name) : null;

    public static T? OptionalValue<T>(IReadOnlyDictionary<string, JsonElement> properties, string path, string name, Func<JsonElement, string, T> read) where T : struct =>
        properties.TryGetValue(name, out var element) ? read(element, path + "." + name) : null;

    public static string Tag(JsonElement element, string path, string name)
    {
        if (element.ValueKind != JsonValueKind.Object) throw Mismatch("object", path, element);
        if (!element.TryGetProperty(name, out var tag)) throw Missing(path + "." + name);
        return tag.ValueKind == JsonValueKind.String ? tag.GetString()! : throw Mismatch("a known variant", path + "." + name, tag);
    }

    public static JsonNode? OfString(string value) => JsonValue.Create(value);
    public static JsonNode? OfInt(long value) => JsonValue.Create(value);
    public static JsonNode? OfNumber(double value) => JsonValue.Create(value);
    public static JsonNode? OfBool(bool value) => JsonValue.Create(value);
    public static JsonNode? OfJson(RawJson value) => JsonNode.Parse(value.Text);

    public static JsonNode? OfList<T>(IReadOnlyList<T> values, Func<T, JsonNode?> write) => new JsonArray(values.Select(write).ToArray());

    public static JsonNode? OfMap<T>(IReadOnlyDictionary<string, T> values, Func<T, JsonNode?> write) =>
        new JsonObject(values.OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => new KeyValuePair<string, JsonNode?>(pair.Key, write(pair.Value))));

    public static JsonNode? OfObject(params (string Key, JsonNode? Value)?[] fields) =>
        new JsonObject(fields.Where(field => field.HasValue).Select(field => new KeyValuePair<string, JsonNode?>(field!.Value.Key, field.Value.Value)));

    public static string Serialize(JsonNode? node) => node is null ? "null" : node.ToJsonString();
}
`;
