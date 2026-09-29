// The F# minimal engine against the normative session vectors.

open System
open System.IO
open System.Text.Json.Nodes
open Limen.Contract.Core

let repository =
    let rec up (directory: DirectoryInfo) =
        if File.Exists(Path.Combine(directory.FullName, "contract", "core.contract.json")) then directory.FullName else up directory.Parent
    up (DirectoryInfo(AppContext.BaseDirectory))

let sessions =
    let text = File.ReadAllText(Path.Combine(repository, "conformance", "sessions", "minimal.session.json")).Replace("{{core.fingerprint}}", Contract.Fingerprint)
    let file = JsonNode.Parse text
    file["sessions"].AsArray()

// Numbers compare by value: 3 and 3.0 are the same wire number.
let rec same (left: JsonNode) (right: JsonNode) =
    match left, right with
    | null, null -> true
    | null, _ | _, null -> false
    | (:? JsonObject as a), (:? JsonObject as b) -> a.Count = b.Count && a |> Seq.forall (fun pair -> b.ContainsKey pair.Key && same pair.Value b[pair.Key])
    | (:? JsonArray as a), (:? JsonArray as b) -> a.Count = b.Count && Seq.forall2 same a b
    | a, b when a.GetValueKind() = Text.Json.JsonValueKind.Number && b.GetValueKind() = Text.Json.JsonValueKind.Number ->
        let number (node: JsonNode) = Double.Parse(node.ToJsonString(), Globalization.CultureInfo.InvariantCulture)
        number a = number b
    | a, b -> a.ToJsonString() = b.ToJsonString()

let runSession (session: JsonNode) : string list =
    Limen.Minimal.Dispatch.reset ()
    let name = session["name"].GetValue<string>()
    session["steps"].AsArray()
    |> Seq.mapi (fun index step ->
        let expected = step["expect"]
        let actual = JsonNode.Parse(Limen.Minimal.Dispatch.handle (step["send"].ToJsonString()))
        if same actual expected then None
        else Some $"{name}, step {index + 1}:\n  expected {expected.ToJsonString()}\n  actual   {actual.ToJsonString()}")
    |> Seq.choose id
    |> Seq.toList

let failures = sessions |> Seq.collect runSession |> Seq.toList
let steps = sessions |> Seq.sumBy (fun session -> session["steps"].AsArray().Count)

match failures with
| [] ->
    printfn "F# minimal engine: all %d steps of %d sessions match." steps sessions.Count
    exit 0
| _ ->
    eprintfn "F# minimal engine disagrees on %d step(s):\n%s" failures.Length (String.Join("\n", failures))
    exit 1
