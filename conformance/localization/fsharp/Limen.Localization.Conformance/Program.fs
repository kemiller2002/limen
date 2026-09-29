// The F# reference localization library against the language-neutral cases
// (conformance/localization/localization.vectors.json), compared exactly.
open System
open System.IO
open System.Text.Json.Nodes
open Limen.Localization

let vectorsPath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "localization.vectors.json")
let vectors = JsonNode.Parse(File.ReadAllText vectorsPath).AsObject()

let text (node: JsonNode) = node.GetValue<string>()
let items (node: JsonNode) = match node with | null -> [] | node -> node.AsArray() |> List.ofSeq
let has (key: string) (node: JsonNode) = node.AsObject().ContainsKey key
let str (value: string) : JsonNode = JsonValue.Create value
let obj (pairs: (string * JsonNode) list) = JsonObject(pairs |> List.map (fun (k, v) -> Collections.Generic.KeyValuePair(k, v)))
let arr (nodes: JsonNode list) = JsonArray(nodes |> Array.ofList)
let strings (node: JsonNode) = items node |> List.map text
let stringMap (node: JsonNode) = match node with | null -> Map.empty | node -> node.AsObject() |> Seq.map (fun pair -> pair.Key, text pair.Value) |> Map.ofSeq

let failures = ResizeArray<string>()
let passed = ref 0

let judge (name: string) (expected: JsonNode) (actual: JsonNode) =
    if JsonNode.DeepEquals(expected, actual) then passed.Value <- passed.Value + 1
    else failures.Add $"{name}\n    expected {expected.ToJsonString()}\n    actual   {actual.ToJsonString()}"

for case in items vectors["negotiate"] do
    let chosen = Locale.negotiate (strings case["available"]) (strings case["preferred"]) (text case["fallback"])
    judge $"""negotiate: {text case["name"]}""" case["expect"] (str chosen)

for case in items vectors["chain"] do
    judge $"""chain: {text case["locale"]}""" case["expect"] (arr (Locale.chain (text case["locale"]) (text case["fallback"]) |> List.map str))

for case in items vectors["direction"] do
    let direction = match Locale.direction (text case["tag"]) with | Direction.Rtl -> "rtl" | Direction.Ltr -> "ltr"
    judge $"""direction: {text case["tag"]}""" case["expect"] (str direction)

let messages = vectors["messages"]
let messageOf (node: JsonNode) =
    if has "text" node then Message.Text(text node["text"]) else Message.Plural(stringMap node["plural"])
let catalogues : Catalogues =
    messages["catalogues"].AsObject()
    |> Seq.map (fun locale -> locale.Key, (locale.Value.AsObject() |> Seq.map (fun entry -> entry.Key, messageOf entry.Value) |> Map.ofSeq))
    |> Map.ofSeq

for case in items messages["cases"] do
    let category = if has "category" case then Some(text case["category"]) else None
    let rendered = Messages.render catalogues (strings case["chain"]) (text case["id"]) (stringMap case["args"]) category
    let actual =
        match rendered with
        | Rendered.Found(locale, content, missing) -> obj [ "found", obj [ "locale", str locale; "text", str content; "missing", arr (missing |> List.map str) ] ]
        | Rendered.NotFound id -> obj [ "notFound", str id ]
    judge $"""messages: {text case["name"]}""" case["expect"] actual

if failures.Count > 0 then
    failures |> Seq.iter (eprintfn "FAIL %s")
    eprintfn "Localization conformance: %d of %d cases disagree." failures.Count (failures.Count + passed.Value)
    exit 1
else
    printfn "Localization conformance: %d/%d cases agree (F# reference library)." passed.Value passed.Value
