/// JSON reading and writing.
///
/// Writing is done by hand from typed records rather than by a serializer: the
/// schemas are public interface, and hand-written emission means a field cannot
/// appear or disappear because a type changed shape. It is also trim-safe,
/// which matters because the CLI ships as a trimmed single-file binary and
/// reflection-based serialization does not survive that.
///
/// Reading uses `JsonDocument`, which is a DOM reader and likewise uses no
/// reflection.
module Limen.Core.Json

open System
open System.Globalization
open System.Text
open System.Text.Json

// ---------------------------------------------------------------- writing ---

/// Escape a string for inclusion in JSON, including the control characters that
/// a naive implementation forgets.
let escape (value: string) =
    let builder = StringBuilder()

    for character in value do
        match character with
        | '"' -> builder.Append "\\\"" |> ignore
        | '\\' -> builder.Append "\\\\" |> ignore
        | '\n' -> builder.Append "\\n" |> ignore
        | '\r' -> builder.Append "\\r" |> ignore
        | '\t' -> builder.Append "\\t" |> ignore
        | '\b' -> builder.Append "\\b" |> ignore
        | '\f' -> builder.Append "\\f" |> ignore
        | c when c < ' ' -> builder.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", int c) |> ignore
        | c -> builder.Append c |> ignore

    builder.ToString()

/// A minimal JSON value. Everything the tool emits is built from these, so the
/// output is valid by construction rather than by careful string concatenation.
type Value =
    | JString of string
    | JInt of int
    | JBool of bool
    | JNull
    | JArray of Value list
    | JObject of (string * Value) list

let private indentation level = String(' ', level * 2)

/// Render a value as indented JSON. Indentation is for humans reading
/// `--json` output in a terminal; parsers do not care either way.
let rec private renderAt level value =
    match value with
    | JString s -> "\"" + escape s + "\""
    | JInt i -> i.ToString(CultureInfo.InvariantCulture)
    | JBool b -> if b then "true" else "false"
    | JNull -> "null"
    | JArray [] -> "[]"
    | JArray items ->
        let inner =
            items
            |> List.map (fun item -> indentation (level + 1) + renderAt (level + 1) item)
            |> String.concat ",\n"

        "[\n" + inner + "\n" + indentation level + "]"
    | JObject [] -> "{}"
    | JObject fields ->
        let inner =
            fields
            |> List.map (fun (key, fieldValue) ->
                indentation (level + 1) + "\"" + escape key + "\": " + renderAt (level + 1) fieldValue)
            |> String.concat ",\n"

        "{\n" + inner + "\n" + indentation level + "}"

let render value = renderAt 0 value

// ---------------------------------------------------------------- reading ---

/// Parse text into a `JsonDocument`, turning any malformed input into a
/// message rather than an exception escaping into the CLI.
let tryParse (text: string) : Result<JsonDocument, string> =
    try
        Ok(JsonDocument.Parse text)
    with
    | :? JsonException as error -> Error error.Message
    | :? ArgumentException as error -> Error error.Message

let tryProperty (name: string) (element: JsonElement) =
    if element.ValueKind <> JsonValueKind.Object then
        None
    else
        match element.TryGetProperty name with
        | true, value -> Some value
        | _ -> None

let tryInt (element: JsonElement) =
    if element.ValueKind = JsonValueKind.Number then
        match element.TryGetInt32() with
        | true, value -> Some value
        | _ -> None
    else
        None

let tryString (element: JsonElement) =
    if element.ValueKind = JsonValueKind.String then
        Option.ofObj (element.GetString())
    else
        None

/// Read a string array, ignoring non-string entries rather than failing: a
/// malformed entry is reported later by the path checks, where the message can
/// name the offending path.
let tryStringArray (element: JsonElement) =
    if element.ValueKind <> JsonValueKind.Array then
        None
    else
        element.EnumerateArray()
        |> Seq.choose tryString
        |> List.ofSeq
        |> Some

let arrayItems (element: JsonElement) =
    if element.ValueKind = JsonValueKind.Array then
        element.EnumerateArray() |> List.ofSeq
    else
        []
