// Tests for the functional F# store library (libraries/fsharp/Limen.Store).
// Property tests use seeded generators, so every run checks the same cases.
module Program

open System
open System.Diagnostics
open System.IO
open System.Reflection
open Limen.Contract
open Limen.Store

type W = Wire.Result
module T = Limen.Contract.Store.Types

let root = Path.GetFullPath(Path.Combine(__SOURCE_DIRECTORY__, "..", "..", "..", ".."))
let results = Collections.Generic.List<string * Result<unit, string>>()
let check name (body: unit -> Result<unit, string>) =
    let outcome = try body () with error -> Error("threw " + error.GetType().Name + ": " + error.Message)
    results.Add((name, outcome))
let ensure condition message = if condition then Ok() else Error message
let all (checks: Result<unit, string> list) = checks |> List.tryPick (function Error e -> Some e | Ok() -> None) |> function Some e -> Error e | None -> Ok()

let run (file: string) (args: string list) =
    let info = ProcessStartInfo(file, args, RedirectStandardOutput = true, RedirectStandardError = true, UseShellExecute = false, WorkingDirectory = root)
    use proc = Process.Start info
    let out = proc.StandardOutput.ReadToEndAsync()
    let err = proc.StandardError.ReadToEnd()
    proc.WaitForExit()
    proc.ExitCode, out.Result + err

// ---------------------------------------------------------------------------
// Builders are total, and every request they build is one the pack accepts
// ---------------------------------------------------------------------------

let random = Random(20261008)
let pick (items: 'a list) = items[random.Next items.Length]
let names = [ "db"; "entries"; "a"; ""; "x/y"; "queue" ]
let paths = [ "id"; "a.b"; ""; "ns" ]
let keyPath () = if random.Next 3 = 0 then KeyPath.Compound(List.init (random.Next 4) (fun _ -> pick paths)) else KeyPath.Path(pick paths)
let index () = { Name = pick names; KeyPath = keyPath (); Unique = random.Next 2 = 0; MultiEntry = random.Next 4 = 0 }
let store () = { Name = pick names; KeyPath = keyPath (); Indexes = List.init (random.Next 3) (fun _ -> index ()) }
let key () =
    match random.Next 4 with
    | 0 -> Key.Text(pick names)
    | 1 -> Key.Number(float (random.Next 100))
    | 2 -> Key.Tuple [ Key.Text(pick names); Key.Number(float (random.Next 9)) ]
    | _ -> Key.Number nan

type Row = { Id: string; Value: int64 }
let row : Codec<Row> =
    Codec.record
        (fun r -> Codec.fields [ Codec.field "id" Codec.string r.Id; Codec.field "value" Codec.int64 r.Value ])
        (fun fields -> match Codec.required "id" Codec.string fields, Codec.required "value" Codec.int64 fields with Ok id, Ok value -> Ok { Id = id; Value = value } | Error e, _ | _, Error e -> Error e)

let builtRequests () =
    let schemas =
        List.init 400 (fun _ -> Schema.create (pick names) (int64 (random.Next 4 - 1)) (List.init (random.Next 3) (fun _ -> store ())) (if random.Next 5 = 0 then [ pick names ] else []))
    let transactions =
        List.init 400 (fun _ ->
            let op () : Result<Op<ReadWrite>, BuildProblem> =
                match random.Next 6 with
                | 0 -> Op.get (pick names) (key ())
                | 1 -> Op.put (pick names) row { Id = pick names; Value = int64 (random.Next()) }
                | 2 -> Op.query (pick names) None (if random.Next 2 = 0 then None else Range.atLeast (key ()) |> Result.toOption) (random.Next 1003 - 1) (random.Next 2 = 0)
                | 3 -> Op.count (pick names) None (Range.prefix [ Key.Text(pick names) ] |> Result.toOption)
                | 4 -> Op.deleteRange (pick names) None
                | _ -> Op.delete (pick names) (key ())
            Transaction.readWrite (pick names) (List.init (random.Next 3) (fun _ -> op ())) |> Result.map Transaction.request)
    let opened = schemas |> List.choose Result.toOption |> List.map Store.openRequest
    let sent = transactions |> List.choose Result.toOption
    opened @ sent, (schemas |> List.filter Result.isError |> List.length) + (transactions |> List.filter Result.isError |> List.length)

check "LCP-045: every builder input yields a request the TypeScript pack's validator accepts, or an Error before any request exists" (fun () ->
    let requests, refused = builtRequests ()
    let dist = Path.Combine(root, "dist", "capabilities", "store", "index.js")
    if not (File.Exists dist) then Error "dist/ is not built: run npm run build first (npm run test:libraries does)"
    else
        let file = Path.Combine(Path.GetTempPath(), "limen-store-built-" + string (Environment.ProcessId) + ".json")
        File.WriteAllText(file, "[" + String.Join(",", requests |> List.map Limen.Contract.Store.Codec.serializeStoreRequest) + "]")
        let script =
            "import { requestProblem } from '" + Uri(dist).AbsoluteUri + "'; import { readFileSync } from 'node:fs';" +
            "const problems = JSON.parse(readFileSync(process.argv[1], 'utf8')).map((r) => requestProblem(r)).filter((p) => p !== undefined);" +
            "console.log(JSON.stringify(problems)); process.exit(problems.length === 0 ? 0 : 1);"
        let code, output = run "node" [ "--input-type=module"; "-e"; script; file ]
        File.Delete file
        all [ ensure (requests.Length > 100 && refused > 100) ("the generators must produce both accepted and refused inputs: " + string requests.Length + " built, " + string refused + " refused")
              ensure (code = 0) ("the pack's validator refused requests the library built: " + output.Trim()) ])

check "LCP-047: a range over a tuple prefix runs from [parts] to [parts, []]" (fun () ->
    match Range.prefix [ Key.Text "a" ] |> Result.bind (fun range -> Op.count "entries" None (Some range)) |> Result.bind (fun op -> Transaction.readOnly "db" [ Ok op ]) |> Result.map Transaction.request with
    | Ok(Wire.Request.Transact(_, T.TransactionMode.Readonly, [ Wire.Operation.Count(_, _, Some range) ])) ->
        ensure (range.Lower = Some(RawJson """["a"]""") && range.Upper = Some(RawJson """["a",[]]""") && not range.LowerOpen && not range.UpperOpen) "the prefix range bounds"
    | other -> Error("unexpected " + string (other |> Result.isOk)))

check "LCP-045: invalid input is an Error naming the problem: a NaN key, a limit of 0, an empty transaction, a separator in a name, a compound multiEntry index" (fun () ->
    all [ ensure (Op.get "s" (Key.Number nan) |> Result.isError) "NaN key"
          ensure (Op.query "s" None None 0 false |> Result.isError) "limit 0"
          ensure (Op.query "s" None None 1001 false |> Result.isError) "limit 1001"
          ensure (Transaction.readOnly "db" ([] : Result<Op<ReadOnly>, BuildProblem> list) |> Result.isError) "empty transaction"
          ensure (Schema.create "a/b" 1L [] [] = Error { Problem = "a database a/b may not contain \"/\" (the namespace separator)" }) "separator"
          ensure (Schema.create "db" 1L [ { Name = "s"; KeyPath = KeyPath.Path "id"; Indexes = [ { Name = "i"; KeyPath = KeyPath.Compound [ "a"; "b" ]; Unique = false; MultiEntry = true } ] } ] [] |> Result.isError) "compound multiEntry"
          ensure (Op.put "s" Codec.string "not a record" |> Result.isError) "a value that is not a record" ])

// ---------------------------------------------------------------------------
// Codecs round-trip (LCP-049)
// ---------------------------------------------------------------------------

let roundTrips (codec: Codec<'T>) (values: 'T list) =
    values |> List.forall (fun value -> (Codec.encode codec value |> Result.bind (fun raw -> Codec.decode codec raw |> Result.mapError (fun p -> { Path = p.Path; Problem = p.Expected }))) = Ok value)

check "LCP-049: decode (encode x) = Ok x for the built-in codecs, over generated values" (fun () ->
    let strings = [ ""; "plain"; "quote \" backslash \\ newline \n tab \t"; "ünïcödé ✓ 日本"; string (char 0) + "x" ] @ List.init 200 (fun _ -> String(Array.init (random.Next 20) (fun _ -> char (random.Next(32, 0x2FFF)))))
    let int64s = [ 0L; 1L; -1L; 9007199254740991L; 9007199254740992L; -9007199254740993L; Int64.MaxValue; Int64.MinValue ] @ List.init 300 (fun _ -> random.NextInt64(Int64.MinValue, Int64.MaxValue))
    let floats = [ 0.0; -0.5; 1e300; -1e-300; Math.PI; 0.1 + 0.2 ] @ List.init 300 (fun _ -> (random.NextDouble() - 0.5) * Math.Pow(10.0, float (random.Next(-30, 30))))
    let times = List.init 200 (fun _ -> DateTimeOffset(DateTime(2000, 1, 1).AddTicks(random.NextInt64(0L, 400L * 365L * TimeSpan.TicksPerDay)), TimeSpan.FromMinutes(float (random.Next(-14 * 4, 14 * 4) * 15))))
    let rows = List.init 100 (fun _ -> { Id = pick names; Value = random.NextInt64(Int64.MinValue, Int64.MaxValue) })
    all [ ensure (roundTrips Codec.string strings) "string"
          ensure (roundTrips Codec.int64 int64s) "int64"
          ensure (roundTrips Codec.float floats) "float"
          ensure (roundTrips Codec.bool [ true; false ]) "bool"
          ensure (roundTrips Codec.dateTimeOffset times) "dateTimeOffset"
          ensure (roundTrips (Codec.list (Codec.option Codec.int64)) [ []; [ None ]; [ Some 1L; None; Some Int64.MaxValue ] ]) "list of option"
          ensure (roundTrips row rows) "record" ])

check "LCP-049: integers beyond 2^53 travel as strings; timestamps carry their offset; non-finite floats are refused at encode time" (fun () ->
    all [ ensure (Codec.encode Codec.int64 9007199254740992L = Ok(RawJson "\"9007199254740992\"")) "2^53 as a string"
          ensure (Codec.encode Codec.int64 9007199254740991L = Ok(RawJson "9007199254740991")) "2^53 - 1 as a number"
          ensure ((Codec.encode Codec.dateTimeOffset (DateTimeOffset(2026, 10, 8, 12, 0, 0, TimeSpan.FromHours 2.0)) |> Result.map Json.parse) = Ok(Ok(Json.String "2026-10-08T12:00:00.0000000+02:00"))) "ISO-8601 with offset"
          ensure (Codec.encode (Codec.list Codec.float) [ 1.0; nan ] |> Result.isError) "a non-finite float inside a list is refused"
          ensure (Codec.encode Codec.float nan |> Result.isError && Codec.encode Codec.float infinity |> Result.isError && Codec.encode Codec.float -infinity |> Result.isError) "non-finite refused" ])

check "LCP-049, LCP-068: a stored value of another shape is Undecodable naming the store, the key and the field path, and contains no value content" (fun () ->
    let stored = Wire.OperationResult.Found(RawJson """{"id":"a","value":"SECRET-SENTINEL"}""")
    match Read.value row "db" "entries" (Key.Text "a") stored with
    | Error error ->
        let text = String.Join("|", [ error.Operation; error.Database; defaultArg error.Store ""; error.Code; error.Detail ])
        all [ ensure (error.Class = ErrorClass.Undecodable && error.Store = Some "entries" && error.Code = "limen.store.undecodable.value") ("class and code: " + text)
              ensure (error.Detail.Contains "\"a\"" && error.Detail.Contains "$.value") ("names key and path: " + error.Detail)
              ensure (not (text.Contains "SECRET-SENTINEL")) "no value content" ]
    | Ok _ -> Error "decoded a value of another shape")

// ---------------------------------------------------------------------------
// Outcomes: every pack variant maps to exactly one case (LCP-053)
// ---------------------------------------------------------------------------

let everyResult : (string * W) list =
    [ "Opened", W.Opened(2L, 1L, Some { MaxValueBytes = 1L; MaxTransactionBytes = 2L }, Some false)
      "VersionConflict", W.VersionConflict 3L
      "SchemaMismatch", W.SchemaMismatch [ "p" ]
      "Blocked", W.Blocked
      "Committed", W.Committed [ Wire.OperationResult.Missing ]
      "Aborted", W.Aborted(T.AbortReason.Conflict, Some 1L, Some(RawJson "{}"))
      "AbortedQuota", W.Aborted(T.AbortReason.Quota, None, None)
      "NotOpen", W.NotOpen
      "Closed", W.Closed
      "DatabaseDeleted", W.DatabaseDeleted
      "InvalidRequest", W.InvalidRequest "p"
      "Unavailable", W.Unavailable "r"
      "Cancelled", W.Cancelled
      "Persisted", W.Persisted true
      "Persistence", W.Persistence false
      "Estimate", W.Estimate(Some 1L, None)
      "Availability", W.Availability(T.AvailabilityClass.Refused, Some "SecurityError")
      "Unsupported", W.Unsupported ]

let caseName (value: obj) =
    let text = value.GetType().Name
    text

check "LCP-053: every StoreResult variant maps to exactly one case of each request kind's union, and none throws" (fun () ->
    let openCase result =
        match Outcome.ofOpen result with
        | Ok _ -> "Ok" | Error OpenFailure.VersionBlocked -> "VersionBlocked" | Error(OpenFailure.Outdated _) -> "Outdated" | Error(OpenFailure.SchemaMismatch _) -> "SchemaMismatch"
        | Error(OpenFailure.Unavailable _) -> "Unavailable" | Error(OpenFailure.Invalid _) -> "Invalid" | Error OpenFailure.Cancelled -> "Cancelled" | Error(OpenFailure.Unexpected _) -> "Unexpected"
    let transactCase result =
        match Outcome.ofTransact result with
        | Ok _ -> "Ok" | Error(TransactFailure.Aborted _) -> "Aborted" | Error TransactFailure.QuotaExceeded -> "QuotaExceeded" | Error TransactFailure.NotOpen -> "NotOpen"
        | Error TransactFailure.Cancelled -> "Cancelled" | Error(TransactFailure.Invalid _) -> "Invalid" | Error(TransactFailure.Unavailable _) -> "Unavailable" | Error(TransactFailure.Unexpected _) -> "Unexpected"
    let expectedOpen = [ "Ok"; "Outdated"; "SchemaMismatch"; "VersionBlocked"; "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected"; "Invalid"; "Unavailable"; "Cancelled"; "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected" ]
    let expectedTransact = [ "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected"; "Ok"; "Aborted"; "QuotaExceeded"; "NotOpen"; "Unexpected"; "Unexpected"; "Invalid"; "Unavailable"; "Cancelled"; "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected"; "Unexpected" ]
    let actualOpen = everyResult |> List.map (snd >> openCase)
    let actualTransact = everyResult |> List.map (snd >> transactCase)
    let others =
        everyResult |> List.map (fun (_, result) ->
            [ Outcome.ofClose result |> Result.isOk; Outcome.ofDelete result |> Result.isOk; Outcome.ofPersist result |> Result.isOk
              Outcome.ofPersisted result |> Result.isOk; Outcome.ofEstimate result |> Result.isOk; Outcome.ofAvailability result |> Result.isOk ])
    all [ ensure (actualOpen = expectedOpen) ("open: " + String.Join(",", actualOpen))
          ensure (actualTransact = expectedTransact) ("transact: " + String.Join(",", actualTransact))
          ensure (others |> List.map (List.filter id >> List.length) |> List.sum = 6) "each of close, delete, persist, persisted, estimate and availability succeeds on exactly its own variant"
          ensure (Outcome.ofAvailability (W.Availability(T.AvailabilityClass.Refused, Some "SecurityError")) = Ok(Availability.Refused "SecurityError")) "availability reason kept" ])

check "LCP-072, LCP-068: every failure has a class and a stable code, and a conflict's current value never reaches the error" (fun () ->
    let failures =
        [ TransactFailure.Aborted(AbortCause.Conflict, Some 0, Some(RawJson """{"secret":"SECRET-SENTINEL"}"""))
          TransactFailure.Aborted(AbortCause.Constraint, Some 1, None); TransactFailure.Aborted(AbortCause.InvalidKey, Some 0, None)
          TransactFailure.Aborted(AbortCause.UnknownStore, Some 0, None); TransactFailure.Aborted(AbortCause.Other, None, None)
          TransactFailure.QuotaExceeded; TransactFailure.NotOpen; TransactFailure.Cancelled; TransactFailure.Invalid "p"; TransactFailure.Unavailable "r"; TransactFailure.Unexpected "k" ]
    let errors = failures |> List.map (StoreError.ofTransact "db")
    let opens = [ OpenFailure.VersionBlocked; OpenFailure.Outdated 2L; OpenFailure.SchemaMismatch [ "p" ]; OpenFailure.Unavailable "r"; OpenFailure.Invalid "p"; OpenFailure.Cancelled; OpenFailure.Unexpected "k" ] |> List.map (StoreError.ofOpen "db")
    let everything = errors @ opens
    all [ ensure (everything |> List.forall (fun e -> e.Code.StartsWith "limen.store." && e.Database = "db" && e.Operation <> "")) "codes and names"
          ensure ((errors |> List.map (fun e -> e.Code) |> List.distinct |> List.length) = errors.Length && (opens |> List.map (fun e -> e.Code) |> List.distinct |> List.length) = opens.Length) "within an operation, every failure has its own code"
          ensure (errors[5].Class = ErrorClass.Quota && errors[0].Class = ErrorClass.Conflict && errors[6].Class = ErrorClass.ConnectionLost) "classes"
          ensure (everything |> List.forall (fun e -> not (e.Detail.Contains "SECRET-SENTINEL"))) "no stored value" ])

// ---------------------------------------------------------------------------
// The connection refuses locally (LCP-056, LCP-057)
// ---------------------------------------------------------------------------

let recording () =
    let sent = Collections.Generic.List<Wire.Request>()
    let execute (request: Wire.Request) = async { sent.Add request; return W.Committed [] }
    sent, execute

let writeOnce = Transaction.readWrite "db" [ Op.put "entries" row { Id = "a"; Value = 1L } ] |> function Ok t -> t | Error e -> failwith e.Problem
let opened = Connection.Open { Version = 1L; UpgradedFrom = 0L; Created = Some true; Limits = None }

check "LCP-056, LCP-057: after Outdated, VersionChanged or ConnectionLost a write is NotOpen and never sent; facts about another database leave the connection open" (fun () ->
    let sent, execute = recording ()
    let outdated = Connection.afterOpen (Error(OpenFailure.Outdated 2L)) Connection.initial
    let changed = Connection.afterFact "db" (Wire.Fact.VersionChanged("db", 2L)) opened
    let lost = Connection.afterFact "db" (Wire.Fact.ConnectionLost "db") opened
    let other = Connection.afterFact "db" (Wire.Fact.ConnectionLost "elsewhere") opened
    let answers = [ outdated; changed; lost ] |> List.map (fun connection -> Store.transact execute connection writeOnce |> Async.RunSynchronously)
    let sentToOpen = Store.transact execute other writeOnce |> Async.RunSynchronously
    all [ ensure (answers |> List.forall ((=) (Error TransactFailure.NotOpen))) "refused as NotOpen"
          ensure (outdated = Connection.Outdated 2L && changed = Connection.Changed 2L && lost = Connection.Lost && other = opened) "states"
          ensure (sentToOpen = Ok [] && sent.Count = 1) ("only the open connection sent: " + string sent.Count) ])

check "LCP-056: no path turns Outdated into a delete" (fun () ->
    let sent, execute = recording ()
    match Store.deleteDatabase execute (Connection.Outdated 2L) "db" |> Async.RunSynchronously with
    | Error(DeleteFailure.Invalid _) -> ensure (sent.Count = 0) "nothing sent"
    | _ -> Error "a delete from Outdated was allowed")

// ---------------------------------------------------------------------------
// Migrations (LCP-055) and diagnostics (LCP-073)
// ---------------------------------------------------------------------------

check "LCP-055: the planner runs consecutive positive versions after the stored one, and refuses gaps, repeats and decreases" (fun () ->
    let cases =
        List.init 300 (fun _ ->
            let start = int64 (random.Next(-1, 4))
            let versions = List.init (random.Next 5) (fun i -> start + int64 i + (if random.Next 6 = 0 then int64 (random.Next(-2, 3)) else 0L))
            let stored = int64 (random.Next 6)
            let steps = versions |> List.map (fun v -> v, "step " + string v)
            let wellFormed = versions |> List.forall (fun v -> v >= 1L) && (List.pairwise versions |> List.forall (fun (a, b) -> b = a + 1L))
            match Migration.plan stored steps with
            | Ok planned -> wellFormed && planned = (steps |> List.filter (fun (v, _) -> v > stored))
            | Error _ -> not wellFormed)
    all [ ensure (cases |> List.forall id) "planner property"
          ensure (Migration.plan 0L [ 1L, "a"; 3L, "c" ] = Error(PlanProblem.Gap(1L, 3L))) "gap"
          ensure (Migration.plan 0L [ 1L, "a"; 1L, "b" ] = Error(PlanProblem.Repeat 1L)) "repeat"
          ensure (Migration.plan 0L [ 0L, "z" ] = Error(PlanProblem.NotPositive 0L)) "not positive"
          ensure (Migration.pending (Set.ofList [ 2L ]) [ 2L, "b"; 3L, "c" ] = [ 3L, "c" ]) "a step whose marker is present is skipped" ])

check "LCP-055: a migration step and its marker are one transaction; the marker is put only if absent" (fun () ->
    match Migration.step "db" "migrations" 3L [ Op.put "entries" row { Id = "a"; Value = 3L } ] |> Result.map Transaction.request with
    | Ok(Wire.Request.Transact("db", T.TransactionMode.Readwrite, [ Wire.Operation.Put("entries", _); Wire.Operation.PutIf("migrations", RawJson marker, RawJson "null") ])) ->
        ensure (marker = """{"id":"migration/3","version":3}""") marker
    | _ -> Error "not one readwrite transaction with the marker last")

check "LCP-073: diagnostics are values; an unknown measurement is None, never zero" (fun () ->
    let diagnostics =
        Diagnostics.empty
        |> Diagnostics.withEstimate { UsageEstimate = Some 10L; QuotaEstimate = None }
        |> Diagnostics.withConnection "db" opened
        |> Diagnostics.withConnection "db" Connection.Lost
    ensure (diagnostics = { UsageEstimate = Some 10L; QuotaEstimate = None; Persisted = None; Databases = [ "db", Connection.Lost ] }) "diagnostics")

// ---------------------------------------------------------------------------
// Architecture: no mutable public surface (LCP-045); the mode is a type (LCP-052)
// ---------------------------------------------------------------------------

check "LCP-045: the public surface has no settable property, no mutable field and no ref cell" (fun () ->
    let types = typeof<Schema>.Assembly.GetExportedTypes()
    let settable = types |> Array.collect (fun t -> t.GetProperties(BindingFlags.Public ||| BindingFlags.Instance ||| BindingFlags.Static) |> Array.filter (fun p -> p.SetMethod <> null && p.SetMethod.IsPublic) |> Array.map (fun p -> t.Name + "." + p.Name))
    let fields = types |> Array.collect (fun t -> t.GetFields(BindingFlags.Public ||| BindingFlags.Instance ||| BindingFlags.Static) |> Array.filter (fun f -> not f.IsInitOnly && not f.IsLiteral) |> Array.map (fun f -> t.Name + "." + f.Name))
    let refs =
        types |> Array.collect (fun t ->
            t.GetMethods(BindingFlags.Public ||| BindingFlags.Instance ||| BindingFlags.Static ||| BindingFlags.DeclaredOnly)
            |> Array.filter (fun m -> (m.ReturnType.Name.StartsWith "FSharpRef") || (m.GetParameters() |> Array.exists (fun p -> p.ParameterType.Name.StartsWith "FSharpRef")))
            |> Array.map (fun m -> t.Name + "." + m.Name))
    all [ ensure (types.Length > 20) ("exported types: " + string types.Length)
          ensure (settable.Length = 0) ("settable: " + String.Join(", ", settable))
          ensure (fields.Length = 0) ("mutable fields: " + String.Join(", ", fields))
          ensure (refs.Length = 0) ("ref cells: " + String.Join(", ", refs)) ])

check "LCP-052: a write built into a readonly transaction does not compile (FS0001, ReadOnly against ReadWrite)" (fun () ->
    let fixture = Path.Combine(root, "conformance", "store", "fsharp", "Limen.Store.CompileFailure", "Limen.Store.CompileFailure.fsproj")
    let code, output = run "dotnet" [ "build"; fixture; "-c"; "Release"; "--nologo"; "-v"; "q" ]
    all [ ensure (code <> 0) "the fixture compiled"
          ensure (output.Contains "FS0001" && output.Contains "ReadOnly" && output.Contains "ReadWrite") ("the failure is not the mode mismatch: " + output.Substring(0, min 600 output.Length)) ])

[<EntryPoint>]
let main _ =
    let failed = results |> Seq.filter (snd >> Result.isError) |> List.ofSeq
    for name, outcome in results do
        match outcome with
        | Ok() -> Console.WriteLine("PASS  " + name)
        | Error message -> Console.WriteLine("FAIL  " + name + " — " + message)
    Console.WriteLine("F# store library: " + string (results.Count - failed.Length) + " passed, " + string failed.Length + " failed of " + string results.Count + ".")
    if failed.IsEmpty then 0 else 1
