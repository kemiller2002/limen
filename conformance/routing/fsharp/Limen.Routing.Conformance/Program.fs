// The F# reference routing library against the language-neutral vectors
// (conformance/routing/routing.vectors.json). Tables arrive as neutral JSON
// and are translated into F# routes here; results are rendered back into the
// neutral JSON shape and compared structurally.
open System
open System.IO
open System.Text.Json.Nodes
open Limen.Routing

let vectorsPath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "routing.vectors.json")
let vectors = JsonNode.Parse(File.ReadAllText vectorsPath).AsObject()

let text (node: JsonNode) = node.GetValue<string>()
let items (node: JsonNode) = match node with | null -> [] | node -> node.AsArray() |> Seq.map (fun item -> item) |> List.ofSeq

let paramType (name: string) = if name = "int" then ParamType.Int else ParamType.String

let rec toRoute (node: JsonNode) : Route =
    let o = node.AsObject()
    let redirect =
        match o["redirect"] with
        | null -> None
        | r ->
            let templates =
                r["params"].AsObject()
                |> Seq.map (fun pair ->
                    let value = text pair.Value
                    let template = if value.StartsWith "{" && value.EndsWith "}" then Template.FromParam(value.Substring(1, value.Length - 2)) else Template.Literal value
                    pair.Key, template)
                |> List.ofSeq
            Some(text r["to"], templates)
    { Route.create (text o["name"]) (text o["path"]) with
        Query = items o["query"] |> List.map (fun q -> { Name = text q["name"]; Type = paramType (text q["type"]); Required = q["required"].GetValue<bool>() })
        Children = items o["children"] |> List.map toRoute
        Redirect = redirect
        Guard = (match o["guard"] with | null -> None | g -> Some(text g))
        Requires = items o["requires"] |> List.map text }

let tables =
    vectors["tables"].AsObject() |> Seq.map (fun pair -> pair.Key, items pair.Value |> List.map toRoute) |> Map.ofSeq

let toValue (node: JsonNode) =
    match node.GetValueKind() with
    | System.Text.Json.JsonValueKind.Number -> Value.Integer(node.GetValue<int64>())
    | _ -> Value.Text(node.GetValue<string>())

let toValues (node: JsonNode) =
    match node with
    | null -> Map.empty
    | node -> node.AsObject() |> Seq.map (fun pair -> pair.Key, toValue pair.Value) |> Map.ofSeq

let valueJson (value: Value) : JsonNode =
    match value with
    | Value.Text t -> JsonValue.Create t
    | Value.Integer i -> JsonValue.Create i

let mapJson (values: Map<string, Value>) =
    let o = JsonObject()
    values |> Map.iter (fun key value -> o[key] <- valueJson value)
    o

let strings (values: string list) = JsonArray(values |> List.map (fun v -> JsonValue.Create v :> JsonNode) |> Array.ofList)

let resolutionJson (resolution: Resolution) : JsonNode =
    let o = JsonObject()
    match resolution with
    | Resolution.Matched m ->
        o["kind"] <- "Matched"
        o["route"] <- m.Route
        o["chain"] <- JsonArray(m.Chain |> List.map (fun level -> JsonObject(dict [ "route", JsonValue.Create level.Route :> JsonNode; "params", mapJson level.Params :> JsonNode ]) :> JsonNode) |> Array.ofList)
        o["query"] <- mapJson m.Query
        o["requires"] <- strings m.Requires
        o["redirectedFrom"] <- strings m.RedirectedFrom
    | Resolution.NotFound -> o["kind"] <- "NotFound"
    | Resolution.MalformedPath -> o["kind"] <- "MalformedPath"
    | Resolution.MalformedQuery -> o["kind"] <- "MalformedQuery"
    | Resolution.Invalid(route, parameter, value, expected) ->
        o["kind"] <- "Invalid"; o["route"] <- route; o["parameter"] <- parameter; o["value"] <- value; o["expected"] <- expected
    | Resolution.RedirectLoop chain -> o["kind"] <- "RedirectLoop"; o["chain"] <- strings chain
    | Resolution.Denied route -> o["kind"] <- "Denied"; o["route"] <- route
    o

let guardsFrom (node: JsonNode) : string -> Match -> GuardDecision =
    let decisions = match node with | null -> Map.empty | node -> node.AsObject() |> Seq.map (fun pair -> pair.Key, pair.Value) |> Map.ofSeq
    fun name _ ->
        match Map.tryFind name decisions with
        | None -> GuardDecision.Allow
        | Some decision when decision.GetValueKind() = System.Text.Json.JsonValueKind.String ->
            if text decision = "deny" then GuardDecision.Deny else GuardDecision.Allow
        | Some decision ->
            let r = decision["redirect"]
            GuardDecision.Redirect(text r["to"], toValues r["params"], toValues r["query"])

let failures = ResizeArray<string>()
let mutable passed = 0

let check name (expected: JsonNode) (actual: JsonNode) =
    if JsonNode.DeepEquals(expected, actual) then passed <- passed + 1
    else failures.Add $"{name}\n    expected {expected.ToJsonString()}\n    actual   {actual.ToJsonString()}"

for case in items vectors["resolve"] do
    let table = tables[text case["table"]]
    let actual = Router.resolve table (guardsFrom case["guards"]) (text case["path"]) (text case["query"])
    let name = text case["name"]
    check $"resolve: {name}" case["expect"] (resolutionJson actual)

for case in items vectors["build"] do
    let table = tables[text case["table"]]
    let actual : JsonNode =
        match Router.build table (text case["route"]) (toValues case["params"]) (toValues case["query"]) with
        | Ok location -> JsonObject(dict [ "ok", JsonValue.Create location :> JsonNode ])
        | Error error ->
            let kind, parameter =
                match error with
                | BuildError.UnknownRoute -> "UnknownRoute", ""
                | BuildError.MissingParameter p -> "MissingParameter", p
                | BuildError.InvalidParameter p -> "InvalidParameter", p
            JsonObject(dict [ "error", JsonValue.Create kind :> JsonNode; "parameter", JsonValue.Create parameter :> JsonNode ])
    let name = text case["name"]
    check $"build: {name}" case["expect"] actual

let effectJson (effect: NavigationEffect option) : JsonNode =
    match effect with
    | None -> null
    | Some(NavigationEffect.Push url) -> JsonObject(dict [ "push", JsonValue.Create url :> JsonNode ])
    | Some(NavigationEffect.Replace url) -> JsonObject(dict [ "replace", JsonValue.Create url :> JsonNode ])

for session in items vectors["sessions"] do
    let table = tables[text session["table"]]
    let guard = guardsFrom null
    items session["steps"]
    |> List.fold (fun (state, index) step ->
        let next, route, effect =
            match step["adopt"] with
            | null ->
                let n = step["navigate"]
                match Navigation.navigate table state (text n["route"]) (toValues n["params"]) (toValues n["query"]) with
                | Ok(next, effect) -> next, Some(text n["route"]), effect
                | Error error -> failwith $"navigate failed: {error}"
            | location ->
                let next, resolution, effect = Navigation.adopt table guard state (text location)
                let route = match resolution with | Resolution.Matched m -> Some m.Route | _ -> None
                next, route, effect
        let actual = JsonObject()
        actual["route"] <- (match route with | Some r -> JsonValue.Create r :> JsonNode | None -> null)
        actual["effect"] <- effectJson effect
        let name = text session["name"]
        check $"session {name} step {index}" step["expect"] actual
        next, index + 1) (Navigation.initial, 1)
    |> ignore

if failures.Count = 0 then
    printfn "Routing conformance: %d/%d vectors agree (F# reference library)." passed passed
else
    failures |> Seq.iter (eprintfn "FAIL %s")
    eprintfn "%d routing vector(s) disagree; %d agree." failures.Count passed
    Environment.ExitCode <- 1
