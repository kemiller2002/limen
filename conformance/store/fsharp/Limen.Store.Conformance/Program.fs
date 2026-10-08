// The F# fake against the language-neutral store vectors
// (conformance/store/store.vectors.json), the same file the TypeScript pack
// passes under node and in Chromium and WebKit. Every vector runs twice:
// through FakeStore's pure transition, and through its executors. The fake
// can perform every requirement, so an unsupported vector is a failure here.
module Program

open System
open System.IO
open Limen.Contract
open Limen.Store

let vectorsPath = Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "store.vectors.json")
let document = match Json.parse (RawJson(File.ReadAllText vectorsPath)) with Ok json -> json | Error e -> failwith e

let field (name: string) (json: Json) = match json with Json.Object members -> members |> List.tryFind (fun (key, _) -> key = name) |> Option.map snd | _ -> None
let text (json: Json option) = match json with Some(Json.String value) -> Some value | _ -> None
let items (json: Json option) = match json with Some(Json.Array values) -> values | _ -> []

/// {"$any": kind} matches any value of that kind; everything else is JSON
/// equality with exactly the same object keys.
let rec matches (expected: Json) (actual: Json) =
    match expected, actual with
    | Json.Object [ "$any", Json.String kind ], _ ->
        match kind, actual with
        | "bool", Json.Bool _ -> true
        | "int", Json.Number n -> Math.Floor n = n
        | "string", Json.String _ -> true
        | _ -> false
    | Json.Array e, Json.Array a -> e.Length = a.Length && List.forall2 matches e a
    | Json.Object e, Json.Object a ->
        let keys members = members |> List.map fst |> List.sort
        keys e = keys a && e |> List.forall (fun (name, value) -> a |> List.exists (fun (other, item) -> other = name && matches value item))
    | Json.Number x, Json.Number y -> x = y
    | _ -> expected = actual

let render (json: Json) = let (RawJson t) = Json.render json in t
let jsonOf (serialized: string) = match Json.parse (RawJson serialized) with Ok json -> json | Error _ -> Json.Null

let requirements = [ "holdOpen"; "inject:quota"; "inject:openFails"; "inject:storageCleared"; "inject:missing"; "storage:present"; "storage:absent" ]
let scripted : FakeStorage = { Persist = true; Persisted = false; Usage = 4096L; Quota = 1073741824L }

/// What a vector needs from a tab's point of view.
[<NoEquality; NoComparison>]
type Harness =
    { Ask: string -> bool -> Limen.Contract.Store.Types.StoreRequest -> Limen.Contract.Store.Types.StoreResult
      TakeFacts: string -> Limen.Contract.Store.Types.StoreFact list
      Inject: string -> FakeFault -> unit
      HoldOpen: string -> string -> unit
      Release: string -> string -> unit }

let configOf (index: int) (vector: Json) (tab: string) : FakeTabConfig =
    let app = field "tabs" vector |> Option.bind (field tab) |> Option.bind (field "app" >> text) |> Option.defaultValue "one"
    let limits =
        match field "registration" vector |> Option.bind (field "limits") with
        | Some l ->
            let number name = match field name l with Some(Json.Number n) -> int64 n | _ -> 0L
            { MaxValueBytes = number "maxValueBytes"; MaxTransactionBytes = number "maxTransactionBytes" }
        | None -> FakeTabConfig.defaultLimits
    { Namespace = "v" + string index + "-" + app; Limits = limits }

let storageFor (vector: Json) = if items (field "requires" vector) |> List.contains (Json.String "storage:present") then Some scripted else None

/// The pure transition, folded in a local cell: each call is one step.
let pureHarness (index: int) (vector: Json) : Harness =
    let state = ref (FakeStore.create (storageFor vector))
    let registered = Collections.Generic.HashSet<string>()
    let ensure tab = if registered.Add tab then state.Value <- FakeStore.register tab (configOf index vector tab) state.Value
    { Ask = fun tab cancelled request ->
        ensure tab
        let next, result = if cancelled then FakeStore.cancelled state.Value request else FakeStore.stepAs tab state.Value request
        state.Value <- next
        result
      TakeFacts = fun tab -> ensure tab; let facts, next = FakeStore.takeFacts tab state.Value in state.Value <- next; facts
      Inject = fun tab fault -> ensure tab; state.Value <- FakeStore.inject tab fault state.Value
      HoldOpen = fun tab database -> ensure tab; state.Value <- FakeStore.holdOpen tab database state.Value
      Release = fun tab database -> state.Value <- FakeStore.release tab database state.Value }

/// The executors: what a consumer's tests use.
let executorHarness (index: int) (vector: Json) : Harness =
    let origin = FakeStore.origin (storageFor vector)
    let tabs = Collections.Generic.Dictionary<string, FakeExecutor>()
    let tabOf tab =
        match tabs.TryGetValue tab with
        | true, executor -> executor
        | false, _ -> let executor = origin tab (configOf index vector tab) in tabs[tab] <- executor; executor
    // The executors have no holdOpen; a vector that needs one runs through the
    // pure harness alongside, so this one reports it unsupported.
    { Ask = fun tab cancelled request -> if cancelled then Limen.Contract.Store.Types.StoreResult.Cancelled else (tabOf tab).Execute request |> Async.RunSynchronously
      TakeFacts = fun tab -> (tabOf tab).TakeFacts()
      Inject = fun tab fault -> (tabOf tab).Inject fault
      HoldOpen = fun _ _ -> failwith "unsupported: holdOpen through an executor"
      Release = fun _ _ -> () }

let runVector (harness: Harness) (vector: Json) : Result<unit, string> =
    let step (number: int) (s: Json) : Result<unit, string> =
        let tab = text (field "tab" s) |> Option.defaultValue "a"
        match field "request" s, field "facts" s, text (field "inject" s), text (field "holdOpen" s), text (field "release" s) with
        | Some request, _, _, _, _ ->
            match Limen.Contract.Store.Codec.parseStoreRequest (render request) with
            | Error error -> Error("step " + string number + ": the request does not decode at " + error.Path)
            | Ok decoded ->
                let actual = jsonOf (Limen.Contract.Store.Codec.serializeStoreResult (harness.Ask tab (field "cancelled" s = Some(Json.Bool true)) decoded))
                let expected = field "expect" s |> Option.defaultValue Json.Null
                if matches expected actual then Ok() else Error("step " + string number + ": expected " + render expected + ", got " + render actual)
        | None, Some(Json.String factsTab), _, _, _ ->
            let actual = Json.Array(harness.TakeFacts factsTab |> List.map (Limen.Contract.Store.Codec.serializeStoreFact >> jsonOf))
            let expected = field "expect" s |> Option.defaultValue (Json.Array [])
            if matches expected actual then Ok() else Error("step " + string number + " (facts of " + factsTab + "): expected " + render expected + ", got " + render actual)
        | None, _, Some injection, _, _ ->
            let fault =
                match injection with
                | "quota" -> Some FakeFault.Quota
                | "openFails" -> Some(FakeFault.OpenFails(text (field "error" s) |> Option.defaultValue "UnknownError"))
                | "missing" -> Some FakeFault.Missing
                | "storageCleared" -> Some FakeFault.StorageCleared
                | _ -> None
            match fault with
            | Some f -> harness.Inject tab f; Ok()
            | None -> Error("step " + string number + ": unknown injection " + injection)
        | None, _, None, Some database, _ -> harness.HoldOpen tab database; Ok()
        | None, _, None, None, Some database -> harness.Release tab database; Ok()
        | _ -> Error("step " + string number + ": unknown step " + render s)
    items (field "steps" vector) |> List.mapi (fun i s -> i, s) |> List.fold (fun acc (i, s) -> match acc with Ok() -> step i s | failed -> failed) (Ok())

type Outcome = Passed | Failed of string | Unsupported of string

let runAll (name: string) (harnessOf: int -> Json -> Harness) (supports: string list) =
    let outcomes =
        items (field "vectors" document) |> List.mapi (fun index vector ->
            let vectorName = text (field "name" vector) |> Option.defaultValue "?"
            let missing = items (field "requires" vector) |> List.choose (function Json.String r when not (supports |> List.contains r) -> Some r | _ -> None)
            if not missing.IsEmpty then vectorName, Unsupported(String.Join(", ", missing))
            else
                match (try runVector (harnessOf index vector) vector with error -> Error("threw " + error.Message)) with
                | Ok() -> vectorName, Passed
                | Error message -> vectorName, Failed message)
    let count f = outcomes |> List.filter (snd >> f) |> List.length
    let passed = count (function Passed -> true | _ -> false)
    let failed = count (function Failed _ -> true | _ -> false)
    let unsupported = count (function Unsupported _ -> true | _ -> false)
    for vectorName, outcome in outcomes do
        match outcome with
        | Passed -> ()
        | Failed message -> Console.WriteLine("FAIL  " + name + ": " + vectorName + " — " + message)
        | Unsupported needs -> Console.WriteLine("UNSUPPORTED  " + name + ": " + vectorName + " — needs " + needs)
    Console.WriteLine("F# fake (" + name + "): " + string passed + " passed, " + string failed + " failed, " + string unsupported + " unsupported of " + string outcomes.Length + " vectors.")
    passed, failed, unsupported, outcomes.Length

/// The runner is not vacuous: the first vector with a wrong expectation fails.
let nonVacuous () =
    match items (field "vectors" document) with
    | first :: _ ->
        let wrong =
            match first with
            | Json.Object members ->
                Json.Object(members |> List.map (fun (name, value) ->
                    if name <> "steps" then name, value
                    else name, Json.Array(items (Some value) |> List.mapi (fun i step -> if i > 0 then step else match step with Json.Object m -> Json.Object(m |> List.map (fun (k, v) -> if k = "expect" then k, Json.Object [ "kind", Json.String "Blocked" ] else k, v)) | other -> other))))
            | other -> other
        runVector (pureHarness 9999 wrong) wrong |> Result.isError
    | [] -> false

/// LCP-074: the pure step is total. Thousands of generated requests from
/// three tabs, with every fault injected along the way, never throw, and
/// every answer serializes through the generated codec.
let total () =
    let random = Random 74
    let pick (xs: 'a list) = xs[random.Next xs.Length]
    let module' = Limen.Contract.Store.Types.StoreRequest.Open
    let schema : Limen.Contract.Store.Types.StoreSchema list =
        [ { Name = "s"; KeyPath = "id"; KeyPaths = None; Indexes = [ { Name = "i"; KeyPath = "tag"; KeyPaths = None; Unique = random.Next 2 = 0; MultiEntry = true } ] }
          { Name = "c"; KeyPath = ""; KeyPaths = Some [ "ns"; "seq" ]; Indexes = [] } ]
    let key () = RawJson(pick [ "1"; "\"a\""; "[\"a\",1]"; "[]"; "null"; "{}" ])
    let value () = RawJson(pick [ "{\"id\":1,\"tag\":[\"x\",\"y\"]}"; "{\"id\":\"b\",\"tag\":\"x\"}"; "{\"ns\":\"a\",\"seq\":2}"; "{\"nokey\":true}"; "[1]" ])
    let range () : Limen.Contract.Store.Types.KeyRange option = if random.Next 3 = 0 then None else Some { Lower = Some(key ()); Upper = (if random.Next 2 = 0 then None else Some(key ())); LowerOpen = random.Next 2 = 0; UpperOpen = random.Next 2 = 0 }
    let operation () : Limen.Contract.Store.Types.Operation =
        match random.Next 7 with
        | 0 -> Limen.Contract.Store.Types.Operation.Get(pick [ "s"; "c"; "x" ], key ())
        | 1 -> Limen.Contract.Store.Types.Operation.Put(pick [ "s"; "c" ], value ())
        | 2 -> Limen.Contract.Store.Types.Operation.PutIf(pick [ "s"; "c" ], value (), value ())
        | 3 -> Limen.Contract.Store.Types.Operation.Delete("s", key ())
        | 4 -> Limen.Contract.Store.Types.Operation.Query(pick [ "s"; "c" ], (if random.Next 2 = 0 then Some "i" else None), range (), int64 (random.Next 3), random.Next 2 = 0)
        | 5 -> Limen.Contract.Store.Types.Operation.Count("s", (if random.Next 2 = 0 then Some(pick [ "i"; "nope" ]) else None), range ())
        | _ -> Limen.Contract.Store.Types.Operation.DeleteRange(pick [ "s"; "c" ], range ())
    let request () : Limen.Contract.Store.Types.StoreRequest =
        match random.Next 9 with
        | 0 | 1 -> module'(pick [ "db"; "other"; ""; "a/b" ], int64 (random.Next 4), (if random.Next 4 = 0 then [] else schema), (if random.Next 6 = 0 then [ "s" ] else []))
        | 2 | 3 | 4 -> Limen.Contract.Store.Types.StoreRequest.Transact(pick [ "db"; "other" ], (if random.Next 2 = 0 then Limen.Contract.Store.Types.TransactionMode.Readwrite else Limen.Contract.Store.Types.TransactionMode.Readonly), List.init (random.Next 4) (fun _ -> operation ()))
        | 5 -> Limen.Contract.Store.Types.StoreRequest.Close(pick [ "db"; "other" ])
        | 6 -> Limen.Contract.Store.Types.StoreRequest.DeleteDatabase(pick [ "db"; "other" ])
        | _ -> pick [ Limen.Contract.Store.Types.StoreRequest.Persist; Limen.Contract.Store.Types.StoreRequest.Persisted; Limen.Contract.Store.Types.StoreRequest.Estimate; Limen.Contract.Store.Types.StoreRequest.Availability ]
    let tabs = [ "a"; "b"; "c" ]
    let start = tabs |> List.fold (fun state tab -> FakeStore.register tab (FakeTabConfig.create "fuzz") state) (FakeStore.create (Some scripted))
    let faults = [ FakeFault.Quota; FakeFault.OpenFails "UnknownError"; FakeFault.OpenFails "SecurityError"; FakeFault.StorageCleared ]
    let final, answers =
        List.init 3000 id |> List.fold (fun (state, count) i ->
            let tab = pick tabs
            let state = if i % 97 = 0 then FakeStore.inject tab (pick faults) state else state
            let state = if i % 131 = 0 then FakeStore.holdOpen tab "db" state elif i % 131 = 7 then FakeStore.release tab "db" state else state
            let next, result = FakeStore.stepAs tab state (request ())
            let _ = Limen.Contract.Store.Codec.serializeStoreResult result
            let facts, next = FakeStore.takeFacts tab next
            facts |> List.iter (Limen.Contract.Store.Codec.serializeStoreFact >> ignore)
            next, count + 1) (start, 0)
    ignore final
    answers = 3000

[<EntryPoint>]
let main _ =
    let p, f, u, total' = runAll "pure transition" pureHarness requirements
    let ep, ef, eu, etotal = runAll "executors" executorHarness (requirements |> List.filter ((<>) "holdOpen"))
    let honest = nonVacuous ()
    let isTotal = try total () with error -> Console.WriteLine("FAIL  totality: threw " + error.Message); false
    Console.WriteLine((if honest then "PASS" else "FAIL") + "  the runner reports a wrong expectation as failed")
    Console.WriteLine((if isTotal then "PASS" else "FAIL") + "  LCP-074: the pure step is total over 3000 generated requests from three tabs with faults injected")
    // The pure transition performs every requirement: unsupported is a failure.
    let ok = f = 0 && u = 0 && p = total' && ef = 0 && ep + eu = etotal && ep > 0 && honest && isTotal
    if ok then 0 else 1
