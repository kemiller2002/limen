// Rust emitter: structs, enums (never #[non_exhaustive] — a new variant must
// break every match downstream), Option, Vec, BTreeMap; strict decoders from
// serde_json::Value returning Result, and encoders back to Value. Literal-
// valued fields are absent from the types. The generated crate carries
// #![forbid(unsafe_code)] and #![deny(warnings)] in its lib.rs.

import { inheritedTags, jsonKindOf, type ContractUnit, type Field, type Inherited, type TypeDecl, type TypeExpr, type Variant } from "./model.ts";
import { pascal, quoted, rustField, snake, unitSegments } from "./naming.ts";

type Decls = ReadonlyMap<string, TypeDecl>;

const lines = (...parts: readonly (string | readonly string[])[]): string => parts.flat().join("\n");
const indent = (depth: number, text: string): string => `${"    ".repeat(depth)}${text}`;
const doc = (text: string | undefined, depth: number): readonly string[] => (text === undefined ? [] : [indent(depth, `/// ${text}`)]);

// "limen.core" → limen_core (a module named plain `core` would shadow the core crate).
export const rustModule = (unit: ContractUnit): string => unitSegments(unit.unit).map((segment) => snake(segment)).join("_");

const isLiteral = (field: Field): boolean => field.type.kind === "literal";
const dataFields = (fields: readonly Field[]): readonly Field[] => fields.filter((field) => !isLiteral(field));

const rsType = (type: TypeExpr, decls: Decls): string => {
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return "String";
        case "int": return "i64";
        case "number": return "f64";
        case "bool": return "bool";
        case "json": return "RawJson";
      }
      return "never";
    case "ref": return type.name;
    case "list": return `Vec<${rsType(type.of, decls)}>`;
    case "map": return `BTreeMap<String, ${rsType(type.of, decls)}>`;
    case "nullable": return `Option<${rsType(type.of, decls)}>`;
    case "literal": return "()";
  }
};

const fieldType = (field: Field, decls: Decls): string => (field.optional ? `Option<${rsType(field.type, decls)}>` : rsType(field.type, decls));

const usesMap = (types: readonly TypeDecl[]): boolean => {
  const inExpr = (type: TypeExpr): boolean => type.kind === "map" || ((type.kind === "list" || type.kind === "nullable") && inExpr(type.of));
  return types.some((decl) => {
    switch (decl.kind) {
      case "map": return true;
      case "record": return decl.fields.some((field) => inExpr(field.type));
      case "union": return decl.variants.some((variant) => variant.kind === "inline" && variant.fields.some((field) => inExpr(field.type)));
      case "shape-union": return decl.variants.some((variant) => inExpr(variant.type));
      default: return false;
    }
  });
};

const usesJson = (types: readonly TypeDecl[]): boolean => {
  const inExpr = (type: TypeExpr): boolean => (type.kind === "primitive" && type.name === "json") || ((type.kind === "list" || type.kind === "nullable" || type.kind === "map") && inExpr(type.of));
  return types.some((decl) => {
    switch (decl.kind) {
      case "map": return inExpr(decl.of);
      case "record": return decl.fields.some((field) => inExpr(field.type));
      case "union": return decl.variants.some((variant) => variant.kind === "inline" && variant.fields.some((field) => inExpr(field.type)));
      case "shape-union": return decl.variants.some((variant) => inExpr(variant.type));
      default: return false;
    }
  });
};

const variantDecl = (variant: Variant, decls: Decls): readonly string[] => {
  if (variant.kind === "flatten") return [indent(1, `${pascal(variant.name)}(${variant.target}),`)];
  const data = dataFields(variant.fields);
  return data.length === 0
    ? [...doc(variant.doc, 1), indent(1, `${pascal(variant.name)},`)]
    : [...doc(variant.doc, 1), indent(1, `${pascal(variant.name)} {`), ...data.flatMap((field) => [...doc(field.doc, 2), indent(2, `${rustField(field.name)}: ${fieldType(field, decls)},`)]), indent(1, "},")];
};

const typeDecl = (decl: TypeDecl, decls: Decls): readonly string[] => {
  switch (decl.kind) {
    case "brand":
      return [...doc(decl.doc, 0), "#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]", `pub struct ${decl.name}(pub ${decl.of === "int" ? "i64" : "String"});`];
    case "enum":
      return [...doc(decl.doc, 0), "#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]", `pub enum ${decl.name} {`, ...decl.values.map((value) => indent(1, `${pascal(value)},`)), "}"];
    case "record": {
      const data = dataFields(decl.fields);
      if (data.length === 0) throw new Error(`Rust: record ${decl.name} needs at least one non-literal field`);
      return [...doc(decl.doc, 0), "#[derive(Debug, Clone, PartialEq)]", `pub struct ${decl.name} {`, ...data.flatMap((field) => [...doc(field.doc, 1), indent(1, `pub ${rustField(field.name)}: ${fieldType(field, decls)},`)]), "}"];
    }
    case "union":
      return [...doc(decl.doc, 0), "#[derive(Debug, Clone, PartialEq)]", `pub enum ${decl.name} {`, ...decl.variants.flatMap((variant) => variantDecl(variant, decls)), "}"];
    case "shape-union":
      return [...doc(decl.doc, 0), "#[derive(Debug, Clone, PartialEq)]", `pub enum ${decl.name} {`, ...decl.variants.map((variant) => indent(1, `${variant.name}(${rsType(variant.type, decls)}),`)), "}"];
    case "map":
      return [...doc(decl.doc, 0), `pub type ${decl.name} = BTreeMap<String, ${rsType(decl.of, decls)}>;`];
  }
};

// --- Codec ----------------------------------------------------------------

const decoderName = (name: string): string => `decode_${snake(name)}`;
const encoderName = (name: string): string => `encode_${snake(name)}`;

// A decoder is an expression over a value reference and a path; where a
// function is needed it is wrapped in a closure with depth-unique names.
const decodeExpr = (type: TypeExpr, decls: Decls, value: string, path: string, depth: number): string => {
  const v = `v${depth}`;
  const p = `p${depth}`;
  const closure = (inner: TypeExpr): string => `|${v}: &Value, ${p}: &str| ${decodeExpr(inner, decls, v, p, depth + 1)}`;
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return `wire::string(${value}, ${path})`;
        case "int": return `wire::int(${value}, ${path})`;
        case "number": return `wire::number(${value}, ${path})`;
        case "bool": return `wire::boolean(${value}, ${path})`;
        case "json": return `wire::json(${value}, ${path})`;
      }
      return "never";
    case "ref": return `${decoderName(type.name)}(${value}, ${path})`;
    case "list": return `wire::list(${value}, ${path}, ${closure(type.of)})`;
    case "map": return `wire::map(${value}, ${path}, ${closure(type.of)})`;
    case "nullable": return `wire::nullable(${value}, ${path}, ${closure(type.of)})`;
    case "literal": return typeof type.value === "string" ? `wire::literal_string(${value}, ${path}, ${quoted(type.value)})` : `wire::literal_int(${value}, ${path}, ${type.value})`;
  }
};

const decodeClosure = (type: TypeExpr, decls: Decls): string => `|v0: &Value, p0: &str| ${decodeExpr(type, decls, "v0", "p0", 1)}`;

const local = (field: Field): string => `f_${snake(field.name)}`;

const objectDecode = (keys: readonly string[], constants: readonly Inherited[], fields: readonly Field[], decls: Decls, build: string, depth: number): readonly string[] => [
  indent(depth, `let props = wire::closed(wire::properties(value, path)?, path, &[${keys.map(quoted).join(", ")}])?;`),
  ...constants.map((constant) => indent(depth, `wire::required(props, path, ${quoted(constant.tag)}, |v0: &Value, p0: &str| wire::literal_string(v0, p0, ${quoted(constant.value)}))?;`)),
  ...fields.map((field) => {
    if (isLiteral(field)) return indent(depth, `wire::required(props, path, ${quoted(field.name)}, ${decodeClosure(field.type, decls)})?;`);
    return indent(depth, `let ${local(field)} = wire::${field.optional ? "optional" : "required"}(props, path, ${quoted(field.name)}, ${decodeClosure(field.type, decls)})?;`);
  }),
  indent(depth, `Ok(${build})`),
];

const structBuild = (name: string, fields: readonly Field[]): string => {
  const data = dataFields(fields);
  return data.length === 0 ? name : `${name} { ${data.map((field) => `${rustField(field.name)}: ${local(field)}`).join(", ")} }`;
};

const decoderDecl = (decl: TypeDecl, decls: Decls, inherited: ReadonlyMap<string, Inherited>): readonly string[] => {
  const head = `pub fn ${decoderName(decl.name)}(value: &Value, path: &str) -> Result<${decl.name}, DecodeError> {`;
  const parent = inherited.get(decl.name);
  const parentConstants = parent === undefined ? [] : [parent];
  switch (decl.kind) {
    case "brand":
      return [head, indent(1, `${decl.of === "int" ? "wire::int" : "wire::string"}(value, path).map(${decl.name})`), "}"];
    case "enum":
      return [head, indent(1, `wire::enumeration(value, path, &[${decl.values.map((wire) => `(${quoted(wire)}, ${decl.name}::${pascal(wire)})`).join(", ")}])`), "}"];
    case "map":
      return [head, indent(1, `wire::map(value, path, ${decodeClosure(decl.of, decls)})`), "}"];
    case "shape-union":
      return [
        head,
        indent(1, "match wire::kind_of(value) {"),
        ...decl.variants.map((variant) => indent(2, `${quoted(jsonKindOf(variant.type, decls))} => ${decodeExpr(variant.type, decls, "value", "path", 1)}.map(${decl.name}::${variant.name}),`)),
        indent(2, `_ => Err(wire::mismatch(${quoted(decl.variants.map((variant) => jsonKindOf(variant.type, decls)).join(" | "))}, path, value)),`),
        indent(1, "}"),
        "}",
      ];
    case "record": {
      const keys = [...parentConstants.map((constant) => constant.tag), ...decl.fields.map((field) => field.name)];
      return [head, ...objectDecode(keys, parentConstants, decl.fields, decls, structBuild(decl.name, decl.fields), 1), "}"];
    }
    case "union":
      return [
        head,
        indent(1, `match wire::tag(value, path, ${quoted(decl.tag)})?.as_str() {`),
        ...decl.variants.flatMap((variant) => {
          if (variant.kind === "flatten") return [indent(2, `${quoted(variant.name)} => ${decoderName(variant.target)}(value, path).map(${decl.name}::${pascal(variant.name)}),`)];
          const constants = [...parentConstants, { tag: decl.tag, value: variant.name }];
          const keys = [...constants.map((constant) => constant.tag), ...variant.fields.map((field) => field.name)];
          return [indent(2, `${quoted(variant.name)} => {`), ...objectDecode(keys, constants, variant.fields, decls, structBuild(`${decl.name}::${pascal(variant.name)}`, variant.fields), 3), indent(2, "}")];
        }),
        indent(2, `other => Err(wire::unknown_variant(&format!("{}.${decl.tag}", path), other)),`),
        indent(1, "}"),
        "}",
      ];
  }
};

const encodeExpr = (type: TypeExpr, decls: Decls, value: string, depth: number): string => {
  const x = `x${depth}`;
  switch (type.kind) {
    case "primitive":
      switch (type.name) {
        case "string": return `wire::of_string(${value})`;
        case "int": return `wire::of_int(*${value})`;
        case "number": return `wire::of_number(*${value})`;
        case "bool": return `wire::of_bool(*${value})`;
        case "json": return `wire::of_json(${value})`;
      }
      return "never";
    case "ref": return `${encoderName(type.name)}(${value})`;
    case "list": return `wire::of_list(${value}, |${x}| ${encodeExpr(type.of, decls, x, depth + 1)})`;
    case "map": return `wire::of_map(${value}, |${x}| ${encodeExpr(type.of, decls, x, depth + 1)})`;
    case "nullable": return `wire::of_nullable(${value}, |${x}| ${encodeExpr(type.of, decls, x, depth + 1)})`;
    case "literal": return "never";
  }
};

const literalValue = (value: string | number): string => (typeof value === "string" ? `wire::of_string(${quoted(value)})` : `wire::of_int(${value})`);

const entries = (constants: readonly Inherited[], fields: readonly Field[], decls: Decls, access: (field: Field) => string): string => [
  ...constants.map((constant) => `Some((${quoted(constant.tag)}, wire::of_string(${quoted(constant.value)})))`),
  ...fields.map((field) => {
    if (field.type.kind === "literal") return `Some((${quoted(field.name)}, ${literalValue(field.type.value)}))`;
    return field.optional
      ? `(${access(field)}).as_ref().map(|x0| (${quoted(field.name)}, ${encodeExpr(field.type, decls, "x0", 1)}))`
      : `Some((${quoted(field.name)}, ${encodeExpr(field.type, decls, `${access(field)}`, 0)}))`;
  }),
].join(", ");

const encoderDecl = (decl: TypeDecl, decls: Decls, inherited: ReadonlyMap<string, Inherited>): readonly string[] => {
  const head = `pub fn ${encoderName(decl.name)}(value: &${decl.name}) -> Value {`;
  const parent = inherited.get(decl.name);
  const parentConstants = parent === undefined ? [] : [parent];
  switch (decl.kind) {
    case "brand":
      return [head, indent(1, decl.of === "int" ? "wire::of_int(value.0)" : "wire::of_string(&value.0)"), "}"];
    case "enum":
      return [head, indent(1, "match value {"), ...decl.values.map((wire) => indent(2, `${decl.name}::${pascal(wire)} => wire::of_string(${quoted(wire)}),`)), indent(1, "}"), "}"];
    case "map":
      return [head, indent(1, `wire::of_map(value, |x0| ${encodeExpr(decl.of, decls, "x0", 1)})`), "}"];
    case "shape-union":
      return [head, indent(1, "match value {"), ...decl.variants.map((variant) => indent(2, `${decl.name}::${variant.name}(inner) => ${encodeExpr(variant.type, decls, "inner", 0)},`)), indent(1, "}"), "}"];
    case "record":
      return [head, indent(1, `wire::of_object(vec![${entries(parentConstants, decl.fields, decls, (field) => `&value.${rustField(field.name)}`)}])`), "}"];
    case "union":
      return [
        head,
        indent(1, "match value {"),
        ...decl.variants.map((variant) => {
          if (variant.kind === "flatten") return indent(2, `${decl.name}::${pascal(variant.name)}(inner) => ${encoderName(variant.target)}(inner),`);
          const data = dataFields(variant.fields);
          const pattern = data.length === 0 ? `${decl.name}::${pascal(variant.name)}` : `${decl.name}::${pascal(variant.name)} { ${data.map((field) => `${rustField(field.name)}: ${local(field)}`).join(", ")} }`;
          return indent(2, `${pattern} => wire::of_object(vec![${entries([...parentConstants, { tag: decl.tag, value: variant.name }], variant.fields, decls, local)}]),`);
        }),
        indent(1, "}"),
        "}",
      ];
  }
};

export const emitRustUnit = (unit: ContractUnit): string => {
  const decls: Decls = new Map(unit.types.map((decl) => [decl.name, decl] as const));
  const inherited = inheritedTags(unit.types);
  const imports = [
    ...(usesMap(unit.types) ? ["use std::collections::BTreeMap;"] : []),
    "",
    "use serde_json::Value;",
    "",
    `use crate::runtime::{wire, DecodeError${usesJson(unit.types) ? ", RawJson" : ""}};`,
  ];
  return lines(
    ...(unit.doc === undefined ? [] : [`//! ${unit.doc}`]),
    "",
    imports,
    "",
    "/// The identity of this generated contract unit, exchanged in the handshake.",
    "pub mod contract {",
    indent(1, `pub const UNIT: &str = ${quoted(unit.unit)};`),
    indent(1, `pub const VERSION: i64 = ${unit.version};`),
    indent(1, `pub const FINGERPRINT: &str = ${quoted(unit.fingerprint)};`),
    ...unit.constants.map((constant) => indent(1, `pub const ${constant.name}: ${constant.type === "int" ? "i64" : "&str"} = ${constant.type === "int" ? constant.value : quoted(String(constant.value))};`)),
    "}",
    "",
    unit.types.flatMap((decl) => [...typeDecl(decl, decls), ""]),
    unit.types.flatMap((decl) => [...decoderDecl(decl, decls, inherited), ""]),
    unit.types.flatMap((decl) => [...encoderDecl(decl, decls, inherited), ""]),
    "/// Decode-then-encode by type name. Used only by the shared conformance runner.",
    "pub fn conformance_round_trip(type_name: &str, value: &Value) -> Option<Result<Value, DecodeError>> {",
    indent(1, "match type_name {"),
    ...unit.types.map((decl) => indent(2, `${quoted(decl.name)} => Some(${decoderName(decl.name)}(value, "$").map(|decoded| ${encoderName(decl.name)}(&decoded))),`)),
    indent(2, "_ => None,"),
    indent(1, "}"),
    "}",
    "",
  );
};

export const RUST_RUNTIME = `//! Wire plumbing shared by every generated unit. Generic JSON appears only here.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

/// An opaque JSON value, filled and read only by another generated binding
/// (a capability payload) or by the engine's own decoder (an Http body).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawJson(pub String);

/// Where decoding stopped, and what the contract expected there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodeError {
    pub path: String,
    pub expected: String,
    pub found: String,
}

pub mod wire {
    use super::{BTreeMap, DecodeError, Map, RawJson, Value};

    const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

    pub fn kind_of(value: &Value) -> &'static str {
        match value {
            Value::Null => "null",
            Value::Array(_) => "array",
            Value::Object(_) => "object",
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
        }
    }

    pub fn mismatch(expected: &str, path: &str, value: &Value) -> DecodeError {
        DecodeError { path: path.to_string(), expected: expected.to_string(), found: kind_of(value).to_string() }
    }

    pub fn missing(path: &str) -> DecodeError {
        DecodeError { path: path.to_string(), expected: "a value".to_string(), found: "undefined".to_string() }
    }

    pub fn unknown_variant(path: &str, found: &str) -> DecodeError {
        DecodeError { path: path.to_string(), expected: "a known variant".to_string(), found: Value::String(found.to_string()).to_string() }
    }

    pub fn string(value: &Value, path: &str) -> Result<String, DecodeError> {
        value.as_str().map(str::to_string).ok_or_else(|| mismatch("string", path, value))
    }

    pub fn int(value: &Value, path: &str) -> Result<i64, DecodeError> {
        let integral = |number: f64| number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER;
        match value {
            Value::Number(number) => match (number.as_i64(), number.as_f64()) {
                (Some(whole), _) if (whole.unsigned_abs() as f64) <= MAX_SAFE_INTEGER => Ok(whole),
                (None, Some(float)) if number.as_u64().is_none() && integral(float) => Ok(float as i64),
                _ => Err(mismatch("integer", path, value)),
            },
            _ => Err(mismatch("integer", path, value)),
        }
    }

    pub fn number(value: &Value, path: &str) -> Result<f64, DecodeError> {
        value.as_f64().filter(|number| number.is_finite()).ok_or_else(|| mismatch("finite number", path, value))
    }

    pub fn boolean(value: &Value, path: &str) -> Result<bool, DecodeError> {
        value.as_bool().ok_or_else(|| mismatch("boolean", path, value))
    }

    pub fn json(value: &Value, _path: &str) -> Result<RawJson, DecodeError> {
        Ok(RawJson(value.to_string()))
    }

    pub fn literal_string(value: &Value, path: &str, expected: &str) -> Result<(), DecodeError> {
        match value.as_str() {
            Some(text) if text == expected => Ok(()),
            _ => Err(mismatch(&Value::String(expected.to_string()).to_string(), path, value)),
        }
    }

    pub fn literal_int(value: &Value, path: &str, expected: i64) -> Result<(), DecodeError> {
        match int(value, path) {
            Ok(found) if found == expected => Ok(()),
            _ => Err(mismatch(&expected.to_string(), path, value)),
        }
    }

    pub fn enumeration<T: Copy>(value: &Value, path: &str, cases: &[(&str, T)]) -> Result<T, DecodeError> {
        let text = value.as_str().ok_or_else(|| mismatch("a known variant", path, value))?;
        cases.iter().find(|(wire, _)| *wire == text).map(|(_, case)| *case).ok_or_else(|| unknown_variant(path, text))
    }

    pub fn nullable<T>(value: &Value, path: &str, decode: impl Fn(&Value, &str) -> Result<T, DecodeError>) -> Result<Option<T>, DecodeError> {
        if value.is_null() { Ok(None) } else { decode(value, path).map(Some) }
    }

    pub fn list<T>(value: &Value, path: &str, decode: impl Fn(&Value, &str) -> Result<T, DecodeError>) -> Result<Vec<T>, DecodeError> {
        let items = value.as_array().ok_or_else(|| mismatch("array", path, value))?;
        items.iter().enumerate().map(|(index, item)| decode(item, &format!("{}[{}]", path, index))).collect()
    }

    pub fn properties<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, DecodeError> {
        value.as_object().ok_or_else(|| mismatch("object", path, value))
    }

    pub fn map<T>(value: &Value, path: &str, decode: impl Fn(&Value, &str) -> Result<T, DecodeError>) -> Result<BTreeMap<String, T>, DecodeError> {
        let properties = properties(value, path)?;
        let mut keys: Vec<&String> = properties.keys().collect();
        keys.sort();
        keys.into_iter()
            .map(|key| decode(&properties[key], &format!("{}[{}]", path, Value::String(key.clone()))).map(|decoded| (key.clone(), decoded)))
            .collect()
    }

    /// A closed key set: an unexpected field is corrupted or mismatched wire
    /// data, never silently ignored. Reported in ordinal key order so every
    /// language names the same field.
    pub fn closed<'a>(properties: &'a Map<String, Value>, path: &str, keys: &[&str]) -> Result<&'a Map<String, Value>, DecodeError> {
        let mut present: Vec<&String> = properties.keys().collect();
        present.sort();
        match present.into_iter().find(|key| !keys.contains(&key.as_str())) {
            Some(key) => Err(DecodeError { path: format!("{}.{}", path, key), expected: "no such field".to_string(), found: "unexpected field".to_string() }),
            None => Ok(properties),
        }
    }

    pub fn required<T>(properties: &Map<String, Value>, path: &str, name: &str, decode: impl Fn(&Value, &str) -> Result<T, DecodeError>) -> Result<T, DecodeError> {
        let at = format!("{}.{}", path, name);
        match properties.get(name) {
            Some(value) => decode(value, &at),
            None => Err(missing(&at)),
        }
    }

    pub fn optional<T>(properties: &Map<String, Value>, path: &str, name: &str, decode: impl Fn(&Value, &str) -> Result<T, DecodeError>) -> Result<Option<T>, DecodeError> {
        match properties.get(name) {
            Some(value) => decode(value, &format!("{}.{}", path, name)).map(Some),
            None => Ok(None),
        }
    }

    pub fn tag(value: &Value, path: &str, name: &str) -> Result<String, DecodeError> {
        let properties = properties(value, path)?;
        let at = format!("{}.{}", path, name);
        match properties.get(name) {
            Some(Value::String(text)) => Ok(text.clone()),
            Some(other) => Err(mismatch("a known variant", &at, other)),
            None => Err(missing(&at)),
        }
    }

    pub fn parse<T>(json: &str, decode: impl Fn(&Value, &str) -> Result<T, DecodeError>) -> Result<T, DecodeError> {
        let value: Value = serde_json::from_str(json).map_err(|_| DecodeError { path: "$".to_string(), expected: "JSON text".to_string(), found: "unparseable".to_string() })?;
        decode(&value, "$")
    }

    pub fn of_string(value: &str) -> Value {
        Value::String(value.to_string())
    }

    pub fn of_int(value: i64) -> Value {
        Value::from(value)
    }

    pub fn of_number(value: f64) -> Value {
        serde_json::Number::from_f64(value).map(Value::Number).unwrap_or(Value::Null)
    }

    pub fn of_bool(value: bool) -> Value {
        Value::Bool(value)
    }

    pub fn of_json(value: &RawJson) -> Value {
        serde_json::from_str(&value.0).unwrap_or(Value::Null)
    }

    pub fn of_nullable<T>(value: &Option<T>, encode: impl Fn(&T) -> Value) -> Value {
        value.as_ref().map(encode).unwrap_or(Value::Null)
    }

    pub fn of_list<T>(values: &[T], encode: impl Fn(&T) -> Value) -> Value {
        Value::Array(values.iter().map(encode).collect())
    }

    pub fn of_map<T>(values: &BTreeMap<String, T>, encode: impl Fn(&T) -> Value) -> Value {
        Value::Object(values.iter().map(|(key, value)| (key.clone(), encode(value))).collect())
    }

    pub fn of_object(fields: Vec<Option<(&str, Value)>>) -> Value {
        Value::Object(fields.into_iter().flatten().map(|(key, value)| (key.to_string(), value)).collect())
    }
}
`;
