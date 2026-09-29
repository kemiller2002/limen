// F# emitter: records, [<RequireQualifiedAccess>] discriminated unions, option,
// Map and list; a strict decoder over System.Text.Json and an encoder to
// JsonNode. Literal-valued fields do not appear in F# types at all — the value
// is fixed by the contract, so there is nothing for code to get wrong — and are
// checked on decode and written on encode.

import { inheritedTags, jsonKindOf, type ContractUnit, type Field, type Inherited, type TypeDecl, type TypeExpr, type Variant } from "./model.ts";
import { pascal, quoted, unitSegments } from "./naming.ts";

type Decls = ReadonlyMap<string, TypeDecl>;
type Union = Extract<TypeDecl, { kind: "union" }>;

const lines = (...parts: readonly (string | readonly string[])[]): string => parts.flat().join("\n");
const indent = (depth: number, text: string): string => `${"    ".repeat(depth)}${text}`;
const doc = (text: string | undefined, depth: number): readonly string[] =>
  text === undefined ? [] : [indent(depth, `/// ${text}`)];

export const fsNamespace = (unit: ContractUnit): string => ["Limen", "Contract", ...unitSegments(unit.unit).slice(1)].join(".");

const isLiteral = (field: Field): boolean => field.type.kind === "literal";
const dataFields = (fields: readonly Field[]): readonly Field[] => fields.filter((field) => !isLiteral(field));

// A reference to a named map is written structurally inside the recursive
// type group (F# abbreviations cannot participate in one); the abbreviation is
// still emitted after the group for readers.
export const fsType = (type: TypeExpr, decls: Decls): string => {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return "string";
        case "int": return "int64";
        case "number": return "float";
        case "bool": return "bool";
        case "json": return "RawJson";
      }
      return "never";
    case "ref": {
      const decl = decls.get(type.name);
      return decl?.kind === "map" ? `Map<string, ${fsType(decl.of, decls)}>` : type.name;
    }
    case "list": return `${fsType(type.of, decls)} list`;
    case "map": return `Map<string, ${fsType(type.of, decls)}>`;
    case "nullable": return `${fsType(type.of, decls)} option`;
    case "literal": return "unit";
  }
};

const fieldType = (field: Field, decls: Decls): string =>
  field.optional ? `${fsType(field.type, decls)} option` : fsType(field.type, decls);

const recordBody = (fields: readonly Field[], decls: Decls, depth: number): readonly string[] => {
  const data = dataFields(fields);
  if (data.length === 0) throw new Error("F#: a record needs at least one non-literal field");
  return [
    indent(depth, "{"),
    ...data.flatMap((field) => [...doc(field.doc, depth + 1), indent(depth + 1, `${pascal(field.name)}: ${fieldType(field, decls)}`)]),
    indent(depth, "}"),
  ];
};

const caseDecl = (variant: Variant, decls: Decls): string => {
  if (variant.kind === "flatten") return `| ${pascal(variant.name)} of ${variant.target}`;
  const data = dataFields(variant.fields);
  return data.length === 0
    ? `| ${pascal(variant.name)}`
    : `| ${pascal(variant.name)} of ${data.map((field) => `${pascal(field.name)}: ${fieldType(field, decls)}`).join(" * ")}`;
};

const typeDecl = (decl: TypeDecl, decls: Decls, first: boolean): readonly string[] => {
  const keyword = first ? "type" : "and";
  // `and [<Attr>] X` is the form for later members of a recursive group; the
  // first member takes its attribute on the line above.
  const qualified = (name: string): readonly string[] =>
    first ? [indent(1, "[<RequireQualifiedAccess>]"), indent(1, `type ${name} =`)] : [indent(1, `and [<RequireQualifiedAccess>] ${name} =`)];
  switch (decl.kind) {
    case "brand":
      return [...doc(decl.doc, 1), indent(1, `${keyword} ${decl.name} = ${decl.name} of ${decl.of === "int" ? "int64" : "string"}`)];
    case "enum":
      return [...doc(decl.doc, 1), ...qualified(decl.name), ...decl.values.map((value) => indent(2, `| ${pascal(value)}`))];
    case "record":
      return [...doc(decl.doc, 1), indent(1, `${keyword} ${decl.name} =`), ...recordBody(decl.fields, decls, 2)];
    case "union":
      return [...doc(decl.doc, 1), ...qualified(decl.name), ...decl.variants.flatMap((variant) => [...doc(variant.doc, 2), indent(2, caseDecl(variant, decls))])];
    case "shape-union":
      return [...doc(decl.doc, 1), ...qualified(decl.name), ...decl.variants.map((variant) => indent(2, `| ${variant.name} of ${fsType(variant.type, decls)}`))];
    case "map":
      return [];
  }
};

// --- Decoder --------------------------------------------------------------

const decoderRef = (name: string): string => `decode${name}`;

const decodeFn = (type: TypeExpr, decls: Decls): string => {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return "Wire.string";
        case "int": return "Wire.int";
        case "number": return "Wire.number";
        case "bool": return "Wire.boolean";
        case "json": return "Wire.json";
      }
      return "never";
    case "ref": return decoderRef(type.name);
    case "list": return `(Wire.list ${decodeFn(type.of, decls)})`;
    case "map": return `(Wire.map ${decodeFn(type.of, decls)})`;
    case "nullable": return `(Wire.nullable ${decodeFn(type.of, decls)})`;
    case "literal": return typeof type.value === "string" ? `(Wire.literalString ${quoted(type.value)})` : `(Wire.literalInt ${type.value}L)`;
  }
};

const local = (field: Field): string => `f_${field.name}`;

// Decodes an object's closed key set: constants first (inherited tag, own tag),
// then fields in declaration order. Returns F# lines ending in `return <expr>`.
const objectDecode = (keys: readonly string[], constants: readonly Inherited[], fields: readonly Field[], decls: Decls, build: string, depth: number): readonly string[] => [
  indent(depth, `let! props = Wire.properties path element`),
  indent(depth, `let! props = Wire.closed [ ${keys.map(quoted).join("; ")} ] path props`),
  ...constants.map((constant) => indent(depth, `let! () = Wire.required ${quoted(constant.tag)} (Wire.literalString ${quoted(constant.value)}) path props`)),
  ...fields.map((field) => isLiteral(field)
    ? indent(depth, `let! () = Wire.required ${quoted(field.name)} ${decodeFn(field.type, decls)} path props`)
    : indent(depth, `let! ${local(field)} = Wire.${field.optional ? "optional" : "required"} ${quoted(field.name)} ${decodeFn(field.type, decls)} path props`)),
  indent(depth, `return ${build}`),
];

const recordBuild = (fields: readonly Field[]): string =>
  `{ ${dataFields(fields).map((field) => `${pascal(field.name)} = ${local(field)}`).join("; ")} }`;

const caseBuild = (union: string, variant: Extract<Variant, { kind: "inline" }>): string => {
  const data = dataFields(variant.fields);
  return data.length === 0 ? `${union}.${pascal(variant.name)}` : `${union}.${pascal(variant.name)}(${data.map(local).join(", ")})`;
};

const decoderDecl = (decl: TypeDecl, decls: Decls, inherited: ReadonlyMap<string, Inherited>, first: boolean): readonly string[] => {
  const keyword = first ? "let rec" : "and";
  const head = indent(1, `${keyword} ${decoderRef(decl.name)} (path: string) (element: JsonElement) : Result<${fsDeclType(decl, decls)}, DecodeError> =`);
  const parent = inherited.get(decl.name);
  const parentConstants = parent === undefined ? [] : [parent];
  switch (decl.kind) {
    case "brand":
      return [head, indent(2, `${decl.of === "int" ? "Wire.int" : "Wire.string"} path element |> Result.map ${decl.name}`)];
    case "enum":
      return [head, indent(2, `Wire.enumeration [ ${decl.values.map((value) => `${quoted(value)}, ${decl.name}.${pascal(value)}`).join("; ")} ] path element`)];
    case "map":
      return [head, indent(2, `Wire.map ${decodeFn(decl.of, decls)} path element`)];
    case "shape-union":
      return [
        head,
        indent(2, "match Wire.kindOf element with"),
        ...decl.variants.map((variant) => indent(2, `| ${quoted(jsonKindOf(variant.type, decls))} -> ${decodeFn(variant.type, decls)} path element |> Result.map ${decl.name}.${variant.name}`)),
        indent(2, `| _ -> Wire.mismatch ${quoted(decl.variants.map((variant) => jsonKindOf(variant.type, decls)).join(" | "))} path element`),
      ];
    case "record": {
      const keys = [...parentConstants.map((constant) => constant.tag), ...decl.fields.map((field) => field.name)];
      return [head, indent(2, "Wire.decode {"), ...objectDecode(keys, parentConstants, decl.fields, decls, recordBuild(decl.fields), 3), indent(2, "}")];
    }
    case "union":
      return [
        head,
        indent(2, "Wire.decode {"),
        indent(3, `let! tag = Wire.tag ${quoted(decl.tag)} path element`),
        indent(3, "match tag with"),
        ...decl.variants.flatMap((variant) => {
          if (variant.kind === "flatten") {
            return [indent(3, `| ${quoted(variant.name)} ->`), indent(4, `let! inner = ${decoderRef(variant.target)} path element`), indent(4, `return ${decl.name}.${pascal(variant.name)} inner`)];
          }
          const constants = [...parentConstants, { tag: decl.tag, value: variant.name }];
          const keys = [...constants.map((constant) => constant.tag), ...variant.fields.map((field) => field.name)];
          return [indent(3, `| ${quoted(variant.name)} ->`), ...objectDecode(keys, constants, variant.fields, decls, caseBuild(decl.name, variant), 4)];
        }),
        indent(3, `| other -> return! Wire.unknownVariant (path + ${quoted(`.${decl.tag}`)}) other`),
        indent(2, "}"),
      ];
  }
};

const fsDeclType = (decl: TypeDecl, decls: Decls): string =>
  decl.kind === "map" ? fsType({ kind: "map", of: decl.of }, decls) : decl.name;

// --- Encoder --------------------------------------------------------------

const encodeFn = (type: TypeExpr, decls: Decls): string => {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return "Wire.ofString";
        case "int": return "Wire.ofInt";
        case "number": return "Wire.ofNumber";
        case "bool": return "Wire.ofBool";
        case "json": return "Wire.ofJson";
      }
      return "never";
    case "ref": return `encode${type.name}`;
    case "list": return `(Wire.ofList ${encodeFn(type.of, decls)})`;
    case "map": return `(Wire.ofMap ${encodeFn(type.of, decls)})`;
    case "nullable": return `(Wire.ofNullable ${encodeFn(type.of, decls)})`;
    case "literal": return "never";
  }
};

const literalNode = (value: string | number): string =>
  typeof value === "string" ? `Wire.ofString ${quoted(value)}` : `Wire.ofInt ${value}L`;

const fieldEntries = (fields: readonly Field[], decls: Decls, access: (field: Field) => string): readonly string[] =>
  fields.map((field) => {
    if (field.type.kind === "literal") return `Some(${quoted(field.name)}, ${literalNode(field.type.value)})`;
    return field.optional
      ? `${access(field)} |> Option.map (fun value -> ${quoted(field.name)}, ${encodeFn(field.type, decls)} value)`
      : `Some(${quoted(field.name)}, ${encodeFn(field.type, decls)} ${access(field)})`;
  });

const constantEntries = (constants: readonly Inherited[]): readonly string[] =>
  constants.map((constant) => `Some(${quoted(constant.tag)}, Wire.ofString ${quoted(constant.value)})`);

const encoderDecl = (decl: TypeDecl, decls: Decls, inherited: ReadonlyMap<string, Inherited>): readonly string[] => {
  const head = indent(1, `and encode${decl.name} (value: ${fsDeclType(decl, decls)}) : JsonNode =`);
  const parent = inherited.get(decl.name);
  const parentConstants = parent === undefined ? [] : [parent];
  switch (decl.kind) {
    case "brand":
      return [head, indent(2, `let (${decl.name} inner) = value`), indent(2, `${decl.of === "int" ? "Wire.ofInt" : "Wire.ofString"} inner`)];
    case "enum":
      return [head, indent(2, "match value with"), ...decl.values.map((wire) => indent(2, `| ${decl.name}.${pascal(wire)} -> Wire.ofString ${quoted(wire)}`))];
    case "map":
      return [head, indent(2, `Wire.ofMap ${encodeFn(decl.of, decls)} value`)];
    case "shape-union":
      return [head, indent(2, "match value with"), ...decl.variants.map((variant) => indent(2, `| ${decl.name}.${variant.name} inner -> ${encodeFn(variant.type, decls)} inner`))];
    case "record":
      return [head, indent(2, `Wire.ofObject [ ${[...constantEntries(parentConstants), ...fieldEntries(decl.fields, decls, (field) => `value.${pascal(field.name)}`)].join("; ")} ]`)];
    case "union":
      return [
        head,
        indent(2, "match value with"),
        ...decl.variants.map((variant) => {
          if (variant.kind === "flatten") return indent(2, `| ${decl.name}.${pascal(variant.name)} inner -> encode${variant.target} inner`);
          const data = dataFields(variant.fields);
          const pattern = data.length === 0 ? `${decl.name}.${pascal(variant.name)}` : `${decl.name}.${pascal(variant.name)}(${data.map(local).join(", ")})`;
          const entries = [...constantEntries([...parentConstants, { tag: decl.tag, value: variant.name }]), ...fieldEntries(variant.fields, decls, local)];
          return indent(2, `| ${pattern} -> Wire.ofObject [ ${entries.join("; ")} ]`);
        }),
      ];
  }
};

export const emitFSharpUnit = (unit: ContractUnit): string => {
  const decls: Decls = new Map(unit.types.map((decl) => [decl.name, decl] as const));
  const inherited = inheritedTags(unit.types);
  const declared = unit.types.filter((decl) => decl.kind !== "map");
  const maps = unit.types.filter((decl): decl is Extract<TypeDecl, { kind: "map" }> => decl.kind === "map");
  const codecs = unit.types;
  return lines(
    `namespace ${fsNamespace(unit)}`,
    "",
    "open System.Text.Json",
    "open System.Text.Json.Nodes",
    "open Limen.Contract",
    "",
    ...doc(unit.doc, 0),
    "[<AutoOpen>]",
    "module Types =",
    declared.flatMap((decl, index) => [...typeDecl(decl, decls, index === 0), ""]),
    maps.flatMap((decl) => [...doc(decl.doc, 1), indent(1, `type ${decl.name} = ${fsType({ kind: "map", of: decl.of }, decls)}`), ""]),
    "/// The identity of this generated contract unit, exchanged in the handshake.",
    "[<RequireQualifiedAccess>]",
    "module Contract =",
    indent(1, `let [<Literal>] Unit = ${quoted(unit.unit)}`),
    indent(1, `let [<Literal>] Version = ${unit.version}L`),
    indent(1, `let [<Literal>] Fingerprint = ${quoted(unit.fingerprint)}`),
    ...unit.constants.map((constant) => indent(1, `let [<Literal>] ${pascal(constant.name.toLowerCase())} = ${constant.type === "int" ? `${constant.value}L` : quoted(String(constant.value))}`)),
    "",
    "/// Strict decoders (untrusted JSON → contract values) and encoders.",
    "[<RequireQualifiedAccess>]",
    "module Codec =",
    codecs.flatMap((decl, index) => [...decoderDecl(decl, decls, inherited, index === 0), ""]),
    codecs.flatMap((decl) => [...encoderDecl(decl, decls, inherited), ""]),
    ...codecs.flatMap((decl) => [
      indent(1, `let parse${decl.name} (json: string) = Wire.parse ${decoderRef(decl.name)} json`),
      indent(1, `let serialize${decl.name} (value: ${fsDeclType(decl, decls)}) = (encode${decl.name} value).ToJsonString()`),
    ]),
    "",
    "/// Decode-then-encode by type name. Used only by the shared conformance runner.",
    "[<RequireQualifiedAccess>]",
    "module Conformance =",
    indent(1, "let roundTrips : Map<string, string -> JsonElement -> Result<JsonNode, DecodeError>> ="),
    indent(2, "Map.ofList ["),
    ...codecs.map((decl) => indent(3, `${quoted(decl.name)}, (fun path element -> Codec.${decoderRef(decl.name)} path element |> Result.map Codec.encode${decl.name})`)),
    indent(2, "]"),
    "",
  );
};

export const FSHARP_RUNTIME = `namespace Limen.Contract

open System
open System.Collections.Generic
open System.Text.Json
open System.Text.Json.Nodes

/// An opaque JSON value, filled and read only by another generated binding
/// (a capability payload) or by the engine's own decoder (an Http body).
type RawJson = RawJson of string

/// Where decoding stopped, and what the contract expected there.
type DecodeError = { Path: string; Expected: string; Found: string }

type DecodeBuilder() =
    member _.Bind(result: Result<'a, DecodeError>, next: 'a -> Result<'b, DecodeError>) : Result<'b, DecodeError> = Result.bind next result
    member _.Return(value: 'a) : Result<'a, DecodeError> = Ok value
    member _.ReturnFrom(result: Result<'a, DecodeError>) : Result<'a, DecodeError> = result

/// Wire plumbing shared by every generated unit. Generic JSON appears only here.
[<RequireQualifiedAccess>]
module Wire =
    let decode = DecodeBuilder()

    let kindOf (element: JsonElement) =
        match element.ValueKind with
        | JsonValueKind.Null -> "null"
        | JsonValueKind.Array -> "array"
        | JsonValueKind.Object -> "object"
        | JsonValueKind.String -> "string"
        | JsonValueKind.Number -> "number"
        | JsonValueKind.True
        | JsonValueKind.False -> "boolean"
        | _ -> "undefined"

    let mismatch (expected: string) (path: string) (element: JsonElement) : Result<'a, DecodeError> =
        Error { Path = path; Expected = expected; Found = kindOf element }

    let missing (path: string) : Result<'a, DecodeError> =
        Error { Path = path; Expected = "a value"; Found = "undefined" }

    let unknownVariant (path: string) (found: string) : Result<'a, DecodeError> =
        Error { Path = path; Expected = "a known variant"; Found = JsonSerializer.Serialize found }

    let string (path: string) (element: JsonElement) =
        if element.ValueKind = JsonValueKind.String then Ok(element.GetString()) else mismatch "string" path element

    let private maxSafeInteger = 9007199254740991.0

    let int (path: string) (element: JsonElement) =
        match element.ValueKind with
        | JsonValueKind.Number ->
            match element.TryGetDouble() with
            | true, number when Double.IsFinite number && Math.Floor number = number && abs number <= maxSafeInteger -> Ok(int64 number)
            | _ -> mismatch "integer" path element
        | _ -> mismatch "integer" path element

    let number (path: string) (element: JsonElement) =
        match element.ValueKind with
        | JsonValueKind.Number ->
            match element.TryGetDouble() with
            | true, number when Double.IsFinite number -> Ok number
            | _ -> mismatch "finite number" path element
        | _ -> mismatch "finite number" path element

    let boolean (path: string) (element: JsonElement) =
        match element.ValueKind with
        | JsonValueKind.True -> Ok true
        | JsonValueKind.False -> Ok false
        | _ -> mismatch "boolean" path element

    let json (_: string) (element: JsonElement) : Result<RawJson, DecodeError> = Ok(RawJson(element.GetRawText()))

    let literalString (expected: string) (path: string) (element: JsonElement) =
        if element.ValueKind = JsonValueKind.String && element.GetString() = expected then Ok() else mismatch (JsonSerializer.Serialize expected) path element

    let literalInt (expected: int64) (path: string) (element: JsonElement) =
        match int path element with
        | Ok value when value = expected -> Ok()
        | _ -> mismatch (sprintf "%d" expected) path element

    let enumeration (cases: (string * 'a) list) (path: string) (element: JsonElement) : Result<'a, DecodeError> =
        if element.ValueKind = JsonValueKind.String then
            let text = element.GetString()
            match cases |> List.tryFind (fun (wire, _) -> wire = text) with
            | Some(_, value) -> Ok value
            | None -> unknownVariant path text
        else
            mismatch "a known variant" path element

    let nullable (decoder: string -> JsonElement -> Result<'a, DecodeError>) (path: string) (element: JsonElement) =
        if element.ValueKind = JsonValueKind.Null then Ok None else decoder path element |> Result.map Some

    let private firstError (results: Result<'a, DecodeError> seq) : Result<'a list, DecodeError> =
        Seq.foldBack (fun result state ->
            match result, state with
            | Error error, _ -> Error error
            | Ok _, Error error -> Error error
            | Ok value, Ok values -> Ok(value :: values)) results (Ok [])

    let list (decoder: string -> JsonElement -> Result<'a, DecodeError>) (path: string) (element: JsonElement) =
        if element.ValueKind = JsonValueKind.Array then
            element.EnumerateArray() |> Seq.mapi (fun index item -> decoder $"{path}[{index}]" item) |> Seq.toList |> firstError
        else
            mismatch "array" path element

    let properties (path: string) (element: JsonElement) : Result<Map<string, JsonElement>, DecodeError> =
        if element.ValueKind = JsonValueKind.Object then
            Ok(element.EnumerateObject() |> Seq.map (fun property -> property.Name, property.Value) |> Map.ofSeq)
        else
            mismatch "object" path element

    let private ordinal (keys: string seq) = keys |> Seq.sortWith (fun left right -> String.CompareOrdinal(left, right))

    let map (decoder: string -> JsonElement -> Result<'a, DecodeError>) (path: string) (element: JsonElement) : Result<Map<string, 'a>, DecodeError> =
        properties path element
        |> Result.bind (fun properties ->
            properties
            |> Map.keys
            |> ordinal
            |> Seq.map (fun key -> decoder $"{path}[{JsonSerializer.Serialize key}]" properties[key] |> Result.map (fun value -> key, value))
            |> Seq.toList
            |> firstError
            |> Result.map Map.ofList)

    // A closed key set: an unexpected field is corrupted or mismatched wire
    // data, never silently ignored. Reported in ordinal key order so every
    // language names the same field.
    let closed (keys: string list) (path: string) (properties: Map<string, JsonElement>) =
        match properties |> Map.keys |> ordinal |> Seq.tryFind (fun key -> not (List.contains key keys)) with
        | Some key -> Error { Path = $"{path}.{key}"; Expected = "no such field"; Found = "unexpected field" }
        | None -> Ok properties

    let required (name: string) (decoder: string -> JsonElement -> Result<'a, DecodeError>) (path: string) (properties: Map<string, JsonElement>) =
        match properties.TryFind name with
        | Some element -> decoder $"{path}.{name}" element
        | None -> missing $"{path}.{name}"

    let optional (name: string) (decoder: string -> JsonElement -> Result<'a, DecodeError>) (path: string) (properties: Map<string, JsonElement>) =
        match properties.TryFind name with
        | Some element -> decoder $"{path}.{name}" element |> Result.map Some
        | None -> Ok None

    let tag (name: string) (path: string) (element: JsonElement) : Result<string, DecodeError> =
        if element.ValueKind <> JsonValueKind.Object then
            mismatch "object" path element
        else
            match element.TryGetProperty name with
            | true, value when value.ValueKind = JsonValueKind.String -> Ok(value.GetString())
            | true, value -> mismatch "a known variant" $"{path}.{name}" value
            | _ -> missing $"{path}.{name}"

    let parse (decoder: string -> JsonElement -> Result<'a, DecodeError>) (json: string) : Result<'a, DecodeError> =
        try
            use document = JsonDocument.Parse json
            decoder "$" document.RootElement
        with :? JsonException ->
            Error { Path = "$"; Expected = "JSON text"; Found = "unparseable" }

    let ofString (value: string) : JsonNode = JsonValue.Create(value)
    let ofInt (value: int64) : JsonNode = JsonValue.Create(value)
    let ofNumber (value: float) : JsonNode = JsonValue.Create(value)
    let ofBool (value: bool) : JsonNode = JsonValue.Create(value)
    let ofJson (RawJson text) : JsonNode = JsonNode.Parse(text)
    let ofNullable (encoder: 'a -> JsonNode) (value: 'a option) : JsonNode = match value with Some inner -> encoder inner | None -> null
    let ofList (encoder: 'a -> JsonNode) (values: 'a list) : JsonNode = JsonArray(values |> List.map encoder |> List.toArray)

    let ofMap (encoder: 'a -> JsonNode) (values: Map<string, 'a>) : JsonNode =
        JsonObject(values |> Map.toSeq |> Seq.map (fun (key, value) -> KeyValuePair(key, encoder value)))

    let ofObject (fields: (string * JsonNode) option list) : JsonNode =
        JsonObject(fields |> List.choose id |> List.map (fun (key, value) -> KeyValuePair(key, value)))
`;
