// The F# binding's side of the shared semantic vectors in
// conformance/vectors/. TypeScript, C# and Rust run the same file.

open System
open System.IO
open System.Security.Cryptography
open System.Text
open System.Text.Json
open System.Text.Json.Nodes
open Limen.Contract
open Limen.Contract.Core

let repository =
    let rec up (directory: DirectoryInfo) =
        if File.Exists(Path.Combine(directory.FullName, "contract", "core.contract.json")) then directory.FullName
        else up directory.Parent
    up (DirectoryInfo(AppContext.BaseDirectory))

let readJson (relative: string) = JsonNode.Parse(File.ReadAllText(Path.Combine(repository, relative)))

// Canonical form: ordinal-sorted keys, every "doc" removed, no whitespace —
// the rule the generator applies. Strings are escaped exactly as JSON.stringify
// escapes ASCII text.
let rec canonical (node: JsonNode) : string =
    let quote (text: string) =
        let escape (character: char) =
            match character with
            | '"' -> "\\\""
            | '\\' -> "\\\\"
            | '\n' -> "\\n"
            | '\r' -> "\\r"
            | '\t' -> "\\t"
            | '\b' -> "\\b"
            | '\f' -> "\\f"
            | c when c < ' ' -> sprintf "\\u%04x" (int c)
            | c -> string c
        "\"" + String.Join("", text |> Seq.map escape) + "\""
    match node with
    | :? JsonObject as record ->
        let entries =
            record
            |> Seq.filter (fun pair -> pair.Key <> "doc")
            |> Seq.sortWith (fun left right -> String.CompareOrdinal(left.Key, right.Key))
            |> Seq.map (fun pair -> quote pair.Key + ":" + canonical pair.Value)
        "{" + String.Join(",", entries) + "}"
    | :? JsonArray as items -> "[" + String.Join(",", items |> Seq.map canonical) + "]"
    | null -> "null"
    | value ->
        match value.GetValueKind() with
        | JsonValueKind.String -> quote (value.GetValue<string>())
        | _ -> value.ToJsonString()

let fingerprint =
    let digest = SHA256.HashData(Encoding.UTF8.GetBytes(canonical (readJson "contract/core.contract.json")))
    "sha256:" + Convert.ToHexString(digest).ToLowerInvariant()

// Numbers compare by value: 200 and 200.0 are the same wire number.
let rec same (left: JsonNode) (right: JsonNode) =
    match left, right with
    | null, null -> true
    | null, _
    | _, null -> false
    | (:? JsonObject as a), (:? JsonObject as b) ->
        a.Count = b.Count && a |> Seq.forall (fun pair -> b.ContainsKey pair.Key && same pair.Value b[pair.Key])
    | (:? JsonArray as a), (:? JsonArray as b) -> a.Count = b.Count && Seq.forall2 same a b
    | a, b when a.GetValueKind() = JsonValueKind.Number && b.GetValueKind() = JsonValueKind.Number ->
        let number (node: JsonNode) = Double.Parse(node.ToJsonString(), Globalization.CultureInfo.InvariantCulture)
        number a = number b
    | a, b -> a.ToJsonString() = b.ToJsonString()

let check (vector: JsonNode) : string option =
    let name = vector["name"].GetValue<string>()
    let typeName = vector["type"].GetValue<string>()
    let valid = vector["valid"].GetValue<bool>()
    let raw = match vector["json"] with null -> "null" | node -> node.ToJsonString()
    use document = JsonDocument.Parse raw
    match Conformance.roundTrips.TryFind typeName with
    | None -> Some $"{name}: no generated decoder for {typeName}"
    | Some roundTrip ->
        match roundTrip "$" document.RootElement, valid with
        | Ok encoded, true -> if same encoded vector["json"] then None else Some $"{name}: round trip changed the value: {encoded.ToJsonString()}"
        | Ok _, false -> Some $"{name}: decoded a vector that must be rejected"
        | Error error, true -> Some $"{name}: rejected a valid vector at {error.Path} ({error.Expected})"
        | Error error, false ->
            let expected = vector["errorPath"].GetValue<string>()
            if error.Path = expected then None else Some $"{name}: rejected at {error.Path} instead of {expected}"

let vectors =
    let file = readJson "conformance/vectors/core.vectors.json"
    file["vectors"].AsArray()

// Typed, not only wire-to-wire: a mutable read that refuses the HTTP cache
// (protocol 1.5, DC-005) encodes its mode as the wire string and decodes back
// to the same value; absent stays absent.
let cacheModeChecks : string list =
    let read cache =
        EffectRequest.Http
            { CorrelationId = CorrelationId "h1"; Method = HttpMethod.Get; Url = "/repos/o/r/commits/main"
              Headers = None; Body = None; TimeoutMs = 5000L; Response = None; ResponseHeaders = None
              Credentials = None; Cache = cache; Xsrf = None }
    let roundTrip (cache: HttpCacheMode option) (expected: string option) =
        let json = Codec.serializeEffectRequest (read cache)
        let wire = JsonNode.Parse(json)["cache"]
        [ match wire, expected with
          | null, None -> ()
          | null, Some text -> yield $"cache {text}: not encoded in {json}"
          | node, Some text when node.GetValue<string>() = text -> ()
          | node, _ -> yield $"cache {cache}: encoded as {node.ToJsonString()}"
          match Codec.parseEffectRequest json with
          | Ok decoded when decoded = read cache -> ()
          | Ok decoded -> yield $"cache {cache}: decoded as {decoded}"
          | Error error -> yield $"cache {cache}: rejected at {error.Path}" ]
    [ None, None
      Some HttpCacheMode.Default, Some "default"
      Some HttpCacheMode.NoStore, Some "no-store"
      Some HttpCacheMode.NoCache, Some "no-cache"
      Some HttpCacheMode.Reload, Some "reload" ]
    |> List.collect (fun (cache, expected) -> roundTrip cache expected)

let failures =
    [ if Contract.Fingerprint <> fingerprint then
          yield $"fingerprint: binding carries {Contract.Fingerprint}, contract computes to {fingerprint}"
      yield! cacheModeChecks
      yield! vectors |> Seq.choose check ]

let count = vectors.Count

match failures with
| [] ->
    printfn "F# binding: fingerprint agrees and all %d shared vectors pass." count
    exit 0
| _ ->
    eprintfn "F# binding disagrees on %d check(s):\n%s" failures.Length (String.Join("\n", failures))
    exit 1
