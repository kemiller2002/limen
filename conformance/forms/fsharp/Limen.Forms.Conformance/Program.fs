// The F# reference forms library against the language-neutral scenarios
// (conformance/forms/forms.vectors.json). Schemas and commands arrive as
// neutral JSON; each step's snapshot is rendered back to neutral JSON. The
// snapshot is compared as a subset (a step states what it cares about), but
// what a command emitted and why it was ignored are compared exactly.
open System
open System.IO
open System.Text.Json
open System.Text.Json.Nodes
open Limen.Forms

let vectorsPath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "forms.vectors.json")
let vectors = JsonNode.Parse(File.ReadAllText vectorsPath).AsObject()

let text (node: JsonNode) = node.GetValue<string>()
let items (node: JsonNode) = match node with | null -> [] | node -> node.AsArray() |> List.ofSeq
let optionalText (node: JsonNode) = match node with | null -> None | node -> Some(text node)
let optionalInt (node: JsonNode) = match node with | null -> None | node -> Some(node.GetValue<int>())
let optionalScalar (node: JsonNode) =
    match node with
    | null -> None
    | node when node.GetValueKind() = JsonValueKind.Number -> Some(node.ToJsonString())
    | node -> Some(text node)

let kindOf name =
    match name with
    | "text" -> Kind.Text | "integer" -> Kind.Integer | "number" -> Kind.Number | "flag" -> Kind.Flag
    | "choice" -> Kind.Choice | "choices" -> Kind.Choices | "date" -> Kind.Date | "time" -> Kind.Time
    | other -> failwith $"unknown kind {other}"

let condition (node: JsonNode) = match node with | null -> None | c -> Some { Field = text c["field"]; Equals = text c["equals"] }
let flag (node: JsonNode) = match node with | null -> false | node -> node.GetValue<bool>()

let fieldSpec (node: JsonNode) : FieldSpec =
    { Field.spec (text node["name"]) (kindOf (text node["kind"])) with
        Required = flag node["required"]
        RequiredWhen = condition node["requiredWhen"]
        VisibleWhen = condition node["visibleWhen"]
        MinLength = optionalInt node["minLength"]
        MaxLength = optionalInt node["maxLength"]
        Min = optionalScalar node["min"]
        Max = optionalScalar node["max"]
        Options = items node["options"] |> List.map text
        MinCount = optionalInt node["minCount"]
        MaxCount = optionalInt node["maxCount"]
        AsyncValidator = optionalText node["asyncValidator"]
        Readonly = flag node["readonly"]
        Disabled = flag node["disabled"] }

let schemas =
    vectors["schemas"].AsObject()
    |> Seq.map (fun pair ->
        pair.Key,
        { Fields = items pair.Value["fields"] |> List.map fieldSpec
          Groups = items pair.Value["groups"] |> List.map (fun g -> { Name = text g["name"]; Fields = items g["fields"] |> List.map fieldSpec }) })
    |> Map.ofSeq

let raw (node: JsonNode) = if node.GetValueKind() = JsonValueKind.Array then Raw.Many(items node |> List.map text) else Raw.One(text node)
let rawMap (node: JsonNode) = node.AsObject() |> Seq.map (fun pair -> pair.Key, raw pair.Value) |> Map.ofSeq

let command (step: JsonObject) =
    let has (name: string) = step.ContainsKey name
    if has "load" then
        let load = step["load"]
        let rows = load["rows"].AsObject() |> Seq.map (fun pair -> pair.Key, items pair.Value |> List.map (fun row -> text row["key"], rawMap row["values"])) |> Map.ofSeq
        Command.Load(rawMap load["values"], rows)
    elif has "input" then
        let input = step["input"]
        Command.Input(text input["field"], (match input["values"] with | null -> raw input["value"] | values -> raw values))
    elif has "fill" then
        let fill = step["fill"]
        Command.Fill(fill["values"].AsObject() |> Seq.map (fun pair -> pair.Key, raw pair.Value) |> List.ofSeq)
    elif has "blur" then
        let blur = step["blur"]
        Command.Blur(text blur["field"])
    elif has "addRow" then
        let row = step["addRow"]
        Command.AddRow(text row["group"], text row["key"])
    elif has "removeRow" then
        let row = step["removeRow"]
        Command.RemoveRow(text row["group"], text row["key"])
    elif has "submit" then
        let submit = step["submit"]
        Command.Submit(text submit["submitter"])
    elif has "asyncResult" then
        let r = step["asyncResult"]
        Command.AsyncResult(text r["field"], text r["token"], optionalText r["error"])
    elif has "submitResult" then
        let r = step["submitResult"]
        let outcome = r["outcome"]
        let result =
            match text outcome["kind"] with
            | "success" -> Outcome.Success
            | "failed" -> Outcome.Failed
            | "unknown" -> Outcome.Unknown
            | _ ->
                let fields = outcome["fields"].AsObject() |> Seq.map (fun pair -> pair.Key, items pair.Value |> List.map text) |> List.ofSeq
                Outcome.Rejected(fields, items outcome["global"] |> List.map text)
        Command.SubmitResult(text r["token"], result)
    elif has "resolveUnknown" then
        let resolve = step["resolveUnknown"]
        Command.ResolveUnknown(resolve["applied"].GetValue<bool>())
    elif has "reset" then Command.Reset
    else failwith $"unknown command {step.ToJsonString()}"

let strings (values: string list) = JsonArray(values |> List.map (fun v -> JsonValue.Create v :> JsonNode) |> Array.ofList)

let rawJson (value: Raw) : JsonNode =
    match value with
    | Raw.One v -> JsonValue.Create v
    | Raw.Many vs -> strings vs

let typedJson (value: Typed) : JsonNode =
    match value with
    | Typed.Text t -> JsonValue.Create t
    | Typed.Integer i -> JsonValue.Create i
    | Typed.Number n -> JsonValue.Create n
    | Typed.Flag b -> JsonValue.Create b
    | Typed.List l -> strings l

let pairsJson (pairs: (string * Typed) list) =
    let o = JsonObject()
    pairs |> List.iter (fun (key, value) -> o[key] <- typedJson value)
    o

let emittedJson (emitted: Emitted) : JsonNode =
    match emitted with
    | Emitted.Validate(path, value, token) ->
        JsonObject(dict [ "validate", JsonObject(dict [ "field", JsonValue.Create path :> JsonNode; "value", JsonValue.Create value; "token", JsonValue.Create token ]) :> JsonNode ])
    | Emitted.Submit(token, submitter, payload) ->
        let values = pairsJson payload.Values
        payload.Rows
        |> List.iter (fun (group, rows) ->
            values[group] <- JsonArray(rows |> List.map (fun (key, pairs) -> JsonObject(dict [ "key", JsonValue.Create key :> JsonNode; "values", pairsJson pairs :> JsonNode ]) :> JsonNode) |> Array.ofList))
        JsonObject(dict [ "submit", JsonObject(dict [ "token", JsonValue.Create token :> JsonNode; "submitter", JsonValue.Create submitter; "values", values ]) :> JsonNode ])

let statusName (status: Status) =
    match status with
    | Status.Editing -> "editing" | Status.Submitting _ -> "submitting" | Status.Submitted -> "submitted"
    | Status.Rejected -> "rejected" | Status.Failed -> "failed" | Status.Unknown _ -> "unknown"

let snapshot (form: Form) (schema: Schema) (paths: string list) : JsonObject =
    let o = JsonObject()
    o["status"] <- statusName (Form.status form)
    o["canSubmit"] <- Form.canSubmit form
    o["valid"] <- Form.isValid form
    o["dirty"] <- Form.isDirty form
    o["global"] <- strings (Form.globalErrors form)
    let rows = JsonObject()
    schema.Groups |> List.iter (fun g -> rows[g.Name] <- strings (Form.rows form g.Name))
    o["rows"] <- rows
    let fields = JsonObject()
    paths
    |> List.iter (fun path ->
        fields[path] <-
            match Form.field form path with
            | None -> null
            | Some view ->
                JsonObject(dict [ "value", rawJson view.Value; "touched", JsonValue.Create view.Touched :> JsonNode; "dirty", JsonValue.Create view.Dirty
                                  "errors", strings view.Errors; "pending", JsonValue.Create view.Pending; "visible", JsonValue.Create view.Visible; "required", JsonValue.Create view.Required ]))
    o["fields"] <- fields
    o

let rec subset (expected: JsonNode) (actual: JsonNode) =
    match expected with
    | :? JsonObject as e ->
        match actual with
        | :? JsonObject as a -> e |> Seq.forall (fun pair -> a.ContainsKey pair.Key && subset pair.Value a[pair.Key])
        | _ -> false
    | _ -> JsonNode.DeepEquals(expected, actual)

let failures = ResizeArray<string>()
let mutable passed = 0

for scenario in items vectors["scenarios"] do
    let schema = schemas[text scenario["schema"]]
    let name = text scenario["name"]
    items scenario["steps"]
    |> List.fold (fun (form, index) stepNode ->
        let step = stepNode.AsObject()
        let expect = step["expect"].AsObject()
        let next, emitted, ignored = Form.apply (command step) form
        let paths = match expect["fields"] with | null -> [] | f -> f.AsObject() |> Seq.map (fun pair -> pair.Key) |> List.ofSeq
        let actual = snapshot next schema paths
        actual["emitted"] <- JsonArray(emitted |> List.map emittedJson |> Array.ofList)
        actual["ignored"] <- (match ignored with | Some reason -> JsonValue.Create reason :> JsonNode | None -> null)
        let expected = expect.DeepClone().AsObject()
        if not (expected.ContainsKey "emitted") then expected["emitted"] <- JsonArray()
        if not (expected.ContainsKey "ignored") then expected["ignored"] <- null
        let exact = JsonNode.DeepEquals(expected["emitted"], actual["emitted"]) && JsonNode.DeepEquals(expected["ignored"], actual["ignored"])
        if exact && subset expected actual then passed <- passed + 1
        else failures.Add $"{name} step {index}\n    expected {expected.ToJsonString()}\n    actual   {actual.ToJsonString()}"
        next, index + 1) (Form.create schema, 1)
    |> ignore

if failures.Count = 0 then
    printfn "Forms conformance: %d/%d scenario steps agree (F# reference library)." passed passed
else
    failures |> Seq.iter (eprintfn "FAIL %s")
    eprintfn "%d form step(s) disagree; %d agree." failures.Count passed
    Environment.ExitCode <- 1
