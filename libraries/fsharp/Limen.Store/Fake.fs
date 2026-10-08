/// An in-memory limen.store, version 2, for engine and consumer tests
/// (LCP-074). Its core is a pure, total transition,
///
///     FakeStore.step : FakeState -> StoreRequest -> FakeState * StoreResult
///
/// over one origin shared by named tabs, each a registration of the pack with
/// its own namespace, limits and connections. It answers exactly as the
/// browser pack does, validation messages included, and passes the shared
/// vectors in conformance/store/. The executors at the end are the only
/// stateful part: each closes over one cell and exposes nothing else.
namespace Limen.Store

open System
open System.Text
open Limen.Contract

/// A scripted navigator.storage.
type FakeStorage = { Persist: bool; Persisted: bool; Usage: int64; Quota: int64 }

/// A fault the fake produces on demand, as a browser does not.
[<RequireQualifiedAccess>]
type FakeFault =
    /// The tab's next transaction runs its operations, then fails at commit
    /// with QuotaExceededError.
    | Quota
    /// The tab's next indexedDB.open fails with this error name.
    | OpenFails of errorName: string
    /// The tab has no indexedDB at all.
    | Missing
    /// The origin's IndexedDB is cleared under every open connection, as
    /// clearing site data or eviction does.
    | StorageCleared

/// How a tab registered the pack.
type FakeTabConfig = { Namespace: string; Limits: Limits }

/// The default limits of a version 2 registration.
module FakeTabConfig =
    let defaultLimits : Limits = { MaxValueBytes = 1048576L; MaxTransactionBytes = 8388608L }
    let create (ns: string) : FakeTabConfig = { Namespace = ns; Limits = defaultLimits }

type private StoredIndex = { Path: Json; Unique: bool; MultiEntry: bool }

type private StoredStore = { Path: Json; Indexes: Map<string, StoredIndex>; Records: (Json * Json) list }

type private Database = { Version: int64; Stores: Map<string, StoredStore> }

type private Tab =
    { Config: FakeTabConfig
      Connections: Set<string>
      Facts: Wire.Fact list
      Quota: bool
      OpenFails: string option
      Missing: bool }

/// The whole fake: one origin and its tabs. Opaque; change it only through
/// FakeStore.
type FakeState =
    private
        { Databases: Map<string, Database>
          Holdouts: Set<string>
          Tabs: Map<string, Tab>
          Storage: FakeStorage option }

/// A tab's view of the fake through an executor: the only stateful part.
[<NoEquality; NoComparison>]
type FakeExecutor =
    { Execute: StoreExecutor
      /// The facts this tab received since the last call, in order.
      TakeFacts: unit -> Wire.Fact list
      Inject: FakeFault -> unit }

module FakeStore =
    module T = Limen.Contract.Store.Types

    // -- JSON and keys, as the browser pack sees them -----------------------

    let private parse (raw: RawJson) = match Json.parse raw with Ok json -> json | Error _ -> Json.Null

    let rec private isKey (json: Json) =
        match json with
        | Json.String _ -> true
        | Json.Number number -> Double.IsFinite number
        | Json.Array items -> items |> List.forall isKey
        | Json.Null | Json.Bool _ | Json.Object _ -> false

    /// IndexedDB's key order: numbers, then strings (by code unit), then
    /// arrays (element by element, a prefix first).
    let rec private compareKeys (left: Json) (right: Json) : int =
        let rank json = match json with Json.Number _ -> 1 | Json.String _ -> 3 | Json.Array _ -> 5 | _ -> 9
        match left, right with
        | Json.Number a, Json.Number b -> compare a b
        | Json.String a, Json.String b -> sign (String.CompareOrdinal(a, b))
        | Json.Array a, Json.Array b ->
            let rec walk (xs: Json list) (ys: Json list) =
                match xs, ys with
                | [], [] -> 0
                | [], _ -> -1
                | _, [] -> 1
                | x :: xt, y :: yt -> match compareKeys x y with 0 -> walk xt yt | other -> other
            walk a b
        | _ -> compare (rank left) (rank right)

    let rec private jsonEqual (left: Json) (right: Json) =
        match left, right with
        | Json.Object a, Json.Object b ->
            let ka = a |> List.map fst |> List.sort
            let kb = b |> List.map fst |> List.sort
            ka = kb && a |> List.forall (fun (name, value) -> b |> List.exists (fun (other, item) -> other = name && jsonEqual value item))
        | Json.Array a, Json.Array b -> a.Length = b.Length && List.forall2 jsonEqual a b
        | Json.Number a, Json.Number b -> a = b
        | _ -> left = right

    let private atPath (value: Json) (path: string) : Json option =
        path.Split '.'
        |> Array.fold (fun current segment ->
            match current with
            | Some(Json.Object members) -> members |> List.tryFind (fun (name, _) -> name = segment) |> Option.map snd
            | _ -> None) (Some value)

    /// A key path as stored: Json.String for one path, Json.Array of strings
    /// for a compound one.
    let private keyAt (value: Json) (path: Json) : Json option =
        match path with
        | Json.String single -> atPath value single
        | Json.Array parts ->
            let found = parts |> List.map (fun part -> match part with Json.String p -> atPath value p | _ -> None)
            if found |> List.forall Option.isSome then Some(Json.Array(found |> List.choose id)) else None
        | _ -> None

    let private label (path: Json) =
        match path with
        | Json.String single -> single
        | Json.Array parts -> "[" + String.Join(",", parts |> List.map (function Json.String p -> p | _ -> "")) + "]"
        | _ -> ""

    let private pathOf (keyPath: string) (keyPaths: string list option) : Json =
        match keyPaths with
        | Some parts -> Json.Array(parts |> List.map Json.String)
        | None -> Json.String keyPath

    let private bytes (json: Json) = let (RawJson text) = Json.render json in int64 (Encoding.UTF8.GetByteCount text)

    // -- Validation, with the browser pack's own words ----------------------

    let private pathed (keyPath: string) (keyPaths: string list option) =
        match keyPaths with
        | None -> keyPath <> ""
        | Some parts -> keyPath = "" && parts.Length >= 2 && parts |> List.forall ((<>) "")

    let private duplicates (names: string list) = names |> List.filter (fun name -> (names |> List.filter ((=) name) |> List.length) > 1)

    let private schemaProblem (stores: T.StoreSchema list) : string option =
        match duplicates (stores |> List.map (fun store -> store.Name)) with
        | repeated :: _ -> Some("store " + repeated + " is declared twice")
        | [] ->
            match stores |> List.tryFind (fun store -> store.Name = "" || not (pathed store.KeyPath store.KeyPaths)) with
            | Some bad -> Some(if bad.KeyPaths.IsNone then "a store needs a name and a keyPath" else "store " + bad.Name + " needs two or more non-empty keyPaths, and an empty keyPath")
            | None ->
                match stores |> List.tryFind (fun store -> not (duplicates (store.Indexes |> List.map (fun index -> index.Name))).IsEmpty || store.Indexes |> List.exists (fun index -> index.Name = "" || not (pathed index.KeyPath index.KeyPaths))) with
                | Some store -> Some("store " + store.Name + " has an unnamed, pathless or repeated index")
                | None ->
                    stores |> List.tryPick (fun store -> store.Indexes |> List.tryPick (fun index -> if index.KeyPaths.IsSome && index.MultiEntry then Some("index " + store.Name + "." + index.Name + " is compound and multiEntry; IndexedDB allows only one") else None))

    let private rangeProblem (range: T.KeyRange option) : string option =
        match range with
        | None -> None
        | Some r ->
            let bad bound = bound |> Option.exists (parse >> isKey >> not)
            if bad r.Lower || bad r.Upper then Some "a range bound is not a valid key"
            elif r.Lower.IsNone && r.Upper.IsNone then Some "a range needs a lower or an upper bound"
            else None

    let private operationProblem (readonly: bool) (index: int) (operation: Wire.Operation) : string option =
        let at = "operation " + string index
        let writes = match operation with Wire.Operation.Put _ | Wire.Operation.PutIf _ | Wire.Operation.Delete _ | Wire.Operation.DeleteRange _ -> true | _ -> false
        if readonly && writes then Some(at + " writes in a readonly transaction")
        else
            match operation with
            | Wire.Operation.Get(_, key)
            | Wire.Operation.Delete(_, key) -> if isKey (parse key) then None else Some(at + " has an invalid key")
            | Wire.Operation.Put(_, value)
            | Wire.Operation.PutIf(_, value, _) -> (match parse value with Json.Object _ -> None | _ -> Some(at + " value is not a record"))
            | Wire.Operation.Query(_, _, range, limit, _) -> if limit < 1L || limit > 1000L then Some(at + " limit must be 1 to 1000") else rangeProblem range
            | Wire.Operation.Count(_, _, range)
            | Wire.Operation.DeleteRange(_, range) -> rangeProblem range

    let private databaseOf (request: Wire.Request) =
        match request with
        | Wire.Request.Open(database, _, _, _) | Wire.Request.Transact(database, _, _) | Wire.Request.Close database | Wire.Request.DeleteDatabase database -> Some database
        | Wire.Request.Persist | Wire.Request.Persisted | Wire.Request.Estimate | Wire.Request.Availability -> None

    let private requestProblem (request: Wire.Request) : string option =
        match databaseOf request with
        | Some "" -> Some "a database needs a name"
        | _ ->
            match request with
            | Wire.Request.Open(_, version, stores, drop) ->
                if version < 1L then Some "version must be a positive integer"
                else
                    match schemaProblem stores with
                    | Some problem -> Some problem
                    | None -> if drop |> List.exists (fun name -> stores |> List.exists (fun store -> store.Name = name)) then Some "a store cannot be both declared and dropped" else None
            | Wire.Request.Transact(_, mode, operations) ->
                if operations.IsEmpty then Some "a transaction needs at least one operation"
                else operations |> List.mapi (operationProblem (mode = T.TransactionMode.Readonly)) |> List.tryPick id
            | _ -> None

    let private rangeJson (range: T.KeyRange option) =
        range |> Option.map (fun r ->
            Json.Object(
                (r.Lower |> Option.map (fun l -> [ "lower", parse l ]) |> Option.defaultValue [])
                @ (r.Upper |> Option.map (fun u -> [ "upper", parse u ]) |> Option.defaultValue [])
                @ [ "lowerOpen", Json.Bool r.LowerOpen; "upperOpen", Json.Bool r.UpperOpen ]))

    /// The operation as JSON, as the pack measures it.
    let private operationJson (operation: Wire.Operation) : Json =
        let optional name value = value |> Option.map (fun v -> [ name, v ]) |> Option.defaultValue []
        match operation with
        | Wire.Operation.Get(store, key) -> Json.Object [ "op", Json.String "get"; "store", Json.String store; "key", parse key ]
        | Wire.Operation.Put(store, value) -> Json.Object [ "op", Json.String "put"; "store", Json.String store; "value", parse value ]
        | Wire.Operation.PutIf(store, value, expected) -> Json.Object [ "op", Json.String "putIf"; "store", Json.String store; "value", parse value; "expected", parse expected ]
        | Wire.Operation.Delete(store, key) -> Json.Object [ "op", Json.String "delete"; "store", Json.String store; "key", parse key ]
        | Wire.Operation.Query(store, index, range, limit, reverse) ->
            Json.Object([ "op", Json.String "query"; "store", Json.String store ] @ optional "index" (index |> Option.map Json.String) @ optional "range" (rangeJson range) @ [ "limit", Json.Number(float limit); "reverse", Json.Bool reverse ])
        | Wire.Operation.Count(store, index, range) ->
            Json.Object([ "op", Json.String "count"; "store", Json.String store ] @ optional "index" (index |> Option.map Json.String) @ optional "range" (rangeJson range))
        | Wire.Operation.DeleteRange(store, range) -> Json.Object([ "op", Json.String "deleteRange"; "store", Json.String store ] @ optional "range" (rangeJson range))

    let private registrationProblem (config: FakeTabConfig) (request: Wire.Request) : string option =
        match databaseOf request with
        | Some database when database.Contains "/" -> Some "a database name may not contain \"/\" (the namespace separator)"
        | _ ->
            match request with
            | Wire.Request.Transact(_, _, operations) ->
                let oversized =
                    operations |> List.mapi (fun index operation -> index, operation) |> List.tryPick (fun (index, operation) ->
                        match operation with
                        | Wire.Operation.Put(_, value)
                        | Wire.Operation.PutIf(_, value, _) ->
                            let size = bytes (parse value)
                            if size > config.Limits.MaxValueBytes then Some("operation " + string index + " value is " + string size + " bytes, over the limit of " + string config.Limits.MaxValueBytes) else None
                        | _ -> None)
                match oversized with
                | Some problem -> Some problem
                | None ->
                    let total = operations |> List.sumBy (operationJson >> bytes)
                    if total > config.Limits.MaxTransactionBytes then Some("the transaction is " + string total + " bytes, over the limit of " + string config.Limits.MaxTransactionBytes) else None
            | _ -> None

    // -- Stores, indexes and ranges -----------------------------------------

    let private indexKeys (index: StoredIndex) (value: Json) : Json list =
        match keyAt value index.Path with
        | Some(Json.Array items) when index.MultiEntry -> items |> List.filter isKey |> List.distinctBy (fun key -> Json.render key)
        | Some key when isKey key -> [ key ]
        | _ -> []

    let private within (range: T.KeyRange option) (key: Json) =
        match range with
        | None -> true
        | Some r ->
            let lowerOk = r.Lower |> Option.forall (fun lower -> let c = compareKeys key (parse lower) in c > 0 || (c = 0 && not r.LowerOpen))
            let upperOk = r.Upper |> Option.forall (fun upper -> let c = compareKeys key (parse upper) in c < 0 || (c = 0 && not r.UpperOpen))
            lowerOk && upperOk

    let private insert (records: (Json * Json) list) (key: Json) (value: Json) =
        (records |> List.filter (fun (k, _) -> compareKeys k key <> 0)) @ [ key, value ] |> List.sortWith (fun (a, _) (b, _) -> compareKeys a b)

    /// The (key, value) pairs a source yields in order: the store's records by
    /// primary key, or an index's entries by index key, then primary key.
    let private entries (store: StoredStore) (index: StoredIndex option) : (Json * Json) list =
        match index with
        | None -> store.Records
        | Some ix ->
            store.Records
            |> List.collect (fun (primary, value) -> indexKeys ix value |> List.map (fun key -> key, primary, value))
            |> List.sortWith (fun (k1, p1, _) (k2, p2, _) -> match compareKeys k1 k2 with 0 -> compareKeys p1 p2 | c -> c)
            |> List.map (fun (key, _, value) -> key, value)

    let private violatesUnique (store: StoredStore) (primary: Json) (value: Json) =
        store.Indexes |> Map.exists (fun _ index ->
            index.Unique
            && (let keys = indexKeys index value
                store.Records |> List.exists (fun (other, record) -> compareKeys other primary <> 0 && indexKeys index record |> List.exists (fun k -> keys |> List.exists (fun mine -> compareKeys k mine = 0)))))

    // -- Schemas, as the pack compares them ---------------------------------

    let private indexSame (stored: StoredIndex) (declared: T.IndexSchema) =
        stored.Path = pathOf declared.KeyPath declared.KeyPaths && stored.Unique = declared.Unique && stored.MultiEntry = declared.MultiEntry

    let private schemaProblems (declared: T.StoreSchema list) (stored: Map<string, StoredStore>) : string list =
        (declared |> List.collect (fun store ->
            match stored.TryFind store.Name with
            | None -> [ "store " + store.Name + " is declared but not stored" ]
            | Some found ->
                let want = pathOf store.KeyPath store.KeyPaths
                (if found.Path = want then [] else [ "store " + store.Name + " keyPath is " + label found.Path + ", declared " + label want ])
                @ (store.Indexes |> List.collect (fun index ->
                    match found.Indexes.TryFind index.Name with
                    | None -> [ "index " + store.Name + "." + index.Name + " is declared but not stored" ]
                    | Some existing -> if indexSame existing index then [] else [ "index " + store.Name + "." + index.Name + " differs from its declaration" ]))
                @ (found.Indexes |> Map.toList |> List.filter (fun (name, _) -> not (store.Indexes |> List.exists (fun index -> index.Name = name))) |> List.map (fun (name, _) -> "index " + store.Name + "." + name + " is stored but not declared"))))
        @ (stored |> Map.toList |> List.filter (fun (name, _) -> not (declared |> List.exists (fun store -> store.Name = name))) |> List.map (fun (name, _) -> "store " + name + " is stored but not declared"))

    /// The upgrade: drop what is named, create what is declared and missing,
    /// rebuild an index whose definition changed. A keyPath change, or an
    /// index a stored record violates, fails it.
    let private upgrade (database: Database) (stores: T.StoreSchema list) (drop: string list) : Result<Map<string, StoredStore>, Choice<string list, string>> =
        let kept = database.Stores |> Map.filter (fun name _ -> not (drop |> List.contains name))
        let folder acc (declared: T.StoreSchema) =
            match acc with
            | Error error -> Error error
            | Ok (current: Map<string, StoredStore>) ->
                let want = pathOf declared.KeyPath declared.KeyPaths
                let store = current.TryFind declared.Name |> Option.defaultValue { Path = want; Indexes = Map.empty; Records = [] }
                if store.Path <> want then Error(Choice1Of2 [ "store " + declared.Name + " keyPath is " + label store.Path + ", declared " + label want + "; drop it to change it" ])
                else
                    let indexes =
                        declared.Indexes |> List.fold (fun (map: Map<string, StoredIndex>) index ->
                            match map.TryFind index.Name with
                            | Some existing when indexSame existing index -> map
                            | _ -> map.Add(index.Name, { Path = pathOf index.KeyPath index.KeyPaths; Unique = index.Unique; MultiEntry = index.MultiEntry })) store.Indexes
                    let rebuilt = { store with Indexes = indexes }
                    let violated = rebuilt.Records |> List.exists (fun (primary, value) -> violatesUnique rebuilt primary value)
                    if violated then Error(Choice2Of2 "AbortError") else Ok(current.Add(declared.Name, rebuilt))
        stores |> List.fold folder (Ok kept)

    // -- Tabs ---------------------------------------------------------------

    let private tabOf (state: FakeState) (id: string) =
        state.Tabs.TryFind id |> Option.defaultValue { Config = FakeTabConfig.create id; Connections = Set.empty; Facts = []; Quota = false; OpenFails = None; Missing = false }

    let private physical (tab: Tab) (database: string) = tab.Config.Namespace + "/" + database

    let private withTab (id: string) (tab: Tab) (state: FakeState) = { state with Tabs = state.Tabs.Add(id, tab) }

    /// Another tab's upgrade or delete: every other tab holding the database
    /// steps aside and hears VersionChanged under its own name.
    let private versionChange (self: string) (phys: string) (newVersion: int64) (state: FakeState) : FakeState =
        let tabs =
            state.Tabs |> Map.map (fun id tab ->
                let held = tab.Connections |> Set.filter (fun name -> id <> self && physical tab name = phys)
                if held.IsEmpty then tab
                else { tab with Connections = tab.Connections - held; Facts = tab.Facts @ (held |> Set.toList |> List.map (fun name -> Wire.Fact.VersionChanged(name, newVersion))) })
        { state with Tabs = tabs }

    let private storageCleared (state: FakeState) : FakeState =
        let tabs = state.Tabs |> Map.map (fun _ tab -> { tab with Connections = Set.empty; Facts = tab.Facts @ (tab.Connections |> Set.toList |> List.map Wire.Fact.ConnectionLost) })
        { state with Tabs = tabs; Databases = Map.empty; Holdouts = Set.empty }

    // -- Requests -----------------------------------------------------------

    let private openDatabase (id: string) (tab: Tab) (state: FakeState) (database: string) (version: int64) (stores: T.StoreSchema list) (drop: string list) : FakeState * Wire.Result =
        let tab = { tab with Connections = tab.Connections.Remove database }
        let phys = physical tab database
        match tab.OpenFails with
        | Some error -> withTab id { tab with OpenFails = None } state, Wire.Result.Unavailable error
        | None ->
            let state = withTab id tab state
            let stored = state.Databases.TryFind phys
            let current = stored |> Option.map (fun db -> db.Version) |> Option.defaultValue 0L
            let limits = Some({ MaxValueBytes = tab.Config.Limits.MaxValueBytes; MaxTransactionBytes = tab.Config.Limits.MaxTransactionBytes } : T.StoreLimits)
            let opened (state: FakeState) from =
                withTab id { tab with Connections = tab.Connections.Add database } state, Wire.Result.Opened(version, from, limits, Some(from = 0L))
            if current > version then state, Wire.Result.VersionConflict current
            elif current = version then
                match schemaProblems stores (stored |> Option.map (fun db -> db.Stores) |> Option.defaultValue Map.empty) with
                | [] -> opened state version
                | problems -> state, Wire.Result.SchemaMismatch problems
            else
                let state = versionChange id phys version state
                if state.Holdouts.Contains phys then state, Wire.Result.Blocked
                else
                    let before = stored |> Option.defaultValue { Version = 0L; Stores = Map.empty }
                    match upgrade before stores drop with
                    | Error(Choice1Of2 problems) -> state, Wire.Result.SchemaMismatch problems
                    | Error(Choice2Of2 reason) -> state, Wire.Result.Unavailable reason
                    | Ok upgraded ->
                        let state = { state with Databases = state.Databases.Add(phys, { Version = version; Stores = upgraded }) }
                        match schemaProblems stores upgraded with
                        | [] -> opened state current
                        | problems -> state, Wire.Result.SchemaMismatch problems

    type private Run = { Store: Map<string, StoredStore>; Results: Wire.OperationResult list }

    let private runOperation (index: int) (acc: Result<Run, Wire.Result>) (operation: Wire.Operation) : Result<Run, Wire.Result> =
        let abort reason current = Error(Wire.Result.Aborted(reason, Some(int64 index), current))
        match acc with
        | Error failed -> Error failed
        | Ok run ->
            let storeName = match operation with Wire.Operation.Get(s, _) | Wire.Operation.Put(s, _) | Wire.Operation.PutIf(s, _, _) | Wire.Operation.Delete(s, _) | Wire.Operation.Query(s, _, _, _, _) | Wire.Operation.Count(s, _, _) | Wire.Operation.DeleteRange(s, _) -> s
            let store = run.Store[storeName]
            let next (updated: StoredStore) (result: Wire.OperationResult) = Ok { Store = run.Store.Add(storeName, updated); Results = run.Results @ [ result ] }
            let source (indexName: string option) =
                match indexName with
                | None -> Some(entries store None)
                | Some name -> store.Indexes.TryFind name |> Option.map (Some >> entries store)
            let write (key: Json) (value: Json) =
                if violatesUnique store key value then abort T.AbortReason.Constraint None
                else next { store with Records = insert store.Records key value } (Wire.OperationResult.Put(Json.render key))
            match operation with
            | Wire.Operation.Get(_, key) ->
                let wanted = parse key
                match store.Records |> List.tryFind (fun (k, _) -> compareKeys k wanted = 0) with
                | Some(_, value) -> next store (Wire.OperationResult.Found(Json.render value))
                | None -> next store Wire.OperationResult.Missing
            | Wire.Operation.Delete(_, key) ->
                let wanted = parse key
                next { store with Records = store.Records |> List.filter (fun (k, _) -> compareKeys k wanted <> 0) } Wire.OperationResult.Deleted
            | Wire.Operation.Put(_, raw) ->
                let value = parse raw
                match keyAt value store.Path with
                | Some key when isKey key -> write key value
                | _ -> abort T.AbortReason.InvalidKey None
            | Wire.Operation.PutIf(_, raw, expected) ->
                let value = parse raw
                match keyAt value store.Path with
                | Some key when isKey key ->
                    let current = store.Records |> List.tryFind (fun (k, _) -> compareKeys k key = 0) |> Option.map snd |> Option.defaultValue Json.Null
                    if jsonEqual current (parse expected) then write key value else abort T.AbortReason.Conflict (Some(Json.render current))
                | _ -> abort T.AbortReason.InvalidKey None
            | Wire.Operation.Query(_, indexName, range, limit, reverse) ->
                match source indexName with
                | None -> abort T.AbortReason.UnknownStore None
                | Some items ->
                    let inRange = items |> List.filter (fst >> within range)
                    let ordered = if reverse then List.rev inRange else inRange
                    next store (Wire.OperationResult.Queried(ordered |> List.truncate (int limit) |> List.map (snd >> Json.render)))
            | Wire.Operation.Count(_, indexName, range) ->
                match source indexName with
                | None -> abort T.AbortReason.UnknownStore None
                | Some items -> next store (Wire.OperationResult.Counted(items |> List.filter (fst >> within range) |> List.length |> int64))
            | Wire.Operation.DeleteRange(_, range) ->
                // No range clears the store; a range deletes exactly its keys.
                let kept = match range with None -> [] | Some _ -> store.Records |> List.filter (fun (k, _) -> not (within range k))
                next { store with Records = kept } Wire.OperationResult.RangeDeleted

    let private transact (id: string) (tab: Tab) (state: FakeState) (database: string) (operations: Wire.Operation list) : FakeState * Wire.Result =
        match tab.Connections.Contains database, state.Databases.TryFind(physical tab database) with
        | true, Some db ->
            let storeOf operation = match operation with Wire.Operation.Get(s, _) | Wire.Operation.Put(s, _) | Wire.Operation.PutIf(s, _, _) | Wire.Operation.Delete(s, _) | Wire.Operation.Query(s, _, _, _, _) | Wire.Operation.Count(s, _, _) | Wire.Operation.DeleteRange(s, _) -> s
            match operations |> List.tryFindIndex (fun operation -> not (db.Stores.ContainsKey(storeOf operation))) with
            | Some index -> state, Wire.Result.Aborted(T.AbortReason.UnknownStore, Some(int64 index), None)
            | None ->
                let quota = tab.Quota
                let state = withTab id { tab with Quota = false } state
                match operations |> List.mapi (fun index operation -> index, operation) |> List.fold (fun acc (index, operation) -> runOperation index acc operation) (Ok { Store = db.Stores; Results = [] }) with
                | Error failed -> state, failed
                | Ok _ when quota -> state, Wire.Result.Aborted(T.AbortReason.Quota, None, None)
                | Ok run -> { state with Databases = state.Databases.Add(physical tab database, { db with Stores = run.Store }) }, Wire.Result.Committed run.Results
        | _ -> state, Wire.Result.NotOpen

    let private deleteDatabase (id: string) (tab: Tab) (state: FakeState) (database: string) : FakeState * Wire.Result =
        let tab = { tab with Connections = tab.Connections.Remove database }
        let phys = physical tab database
        let state = versionChange id phys 0L (withTab id tab state)
        if state.Holdouts.Contains phys then state, Wire.Result.Blocked
        else { state with Databases = state.Databases.Remove phys }, Wire.Result.DatabaseDeleted

    let private availability (id: string) (tab: Tab) (state: FakeState) : FakeState * Wire.Result =
        if tab.Missing then state, Wire.Result.Availability(T.AvailabilityClass.Missing, None)
        else
            match tab.OpenFails with
            | Some error ->
                let cls = if error = "SecurityError" || error = "InvalidStateError" then T.AvailabilityClass.Refused else T.AvailabilityClass.Broken
                withTab id { tab with OpenFails = None } state, Wire.Result.Availability(cls, Some error)
            | None -> state, Wire.Result.Availability(T.AvailabilityClass.Available, None)

    // -- The transition -----------------------------------------------------

    /// An origin with no databases and no tabs; storage is the scripted
    /// navigator.storage, or None for a browser without one.
    let create (storage: FakeStorage option) : FakeState = { Databases = Map.empty; Holdouts = Set.empty; Tabs = Map.empty; Storage = storage }

    /// Register a tab: the pack, registered with this namespace and these limits.
    let register (id: string) (config: FakeTabConfig) (state: FakeState) : FakeState =
        withTab id { tabOf state id with Config = config } state

    /// One request from one tab. Pure and total.
    let stepAs (id: string) (state: FakeState) (request: Wire.Request) : FakeState * Wire.Result =
        let tab = tabOf state id
        match requestProblem request |> Option.orElse (registrationProblem tab.Config request) with
        | Some problem -> state, Wire.Result.InvalidRequest problem
        | None ->
            match request with
            | Wire.Request.Persist -> state, (match state.Storage with Some s -> Wire.Result.Persisted s.Persist | None -> Wire.Result.Unsupported)
            | Wire.Request.Persisted -> state, (match state.Storage with Some s -> Wire.Result.Persistence s.Persisted | None -> Wire.Result.Unsupported)
            | Wire.Request.Estimate -> state, (match state.Storage with Some s -> Wire.Result.Estimate(Some s.Usage, Some s.Quota) | None -> Wire.Result.Unsupported)
            | Wire.Request.Availability -> availability id tab state
            | _ when tab.Missing -> state, Wire.Result.Unavailable "unsupported"
            | Wire.Request.Open(database, version, stores, drop) -> openDatabase id tab state database version stores drop
            | Wire.Request.Transact(database, _, operations) -> transact id tab state database operations
            | Wire.Request.Close database -> withTab id { tab with Connections = tab.Connections.Remove database } state, (if tab.Connections.Contains database then Wire.Result.Closed else Wire.Result.NotOpen)
            | Wire.Request.DeleteDatabase database -> deleteDatabase id tab state database

    /// One request from the tab named "main", registered on first use with the
    /// namespace "main" and the default limits.
    let step (state: FakeState) (request: Wire.Request) : FakeState * Wire.Result = stepAs "main" state request

    /// A request the engine cancelled before it ran: Cancelled, nothing applied.
    let cancelled (state: FakeState) (_: Wire.Request) : FakeState * Wire.Result = state, Wire.Result.Cancelled

    let inject (id: string) (fault: FakeFault) (state: FakeState) : FakeState =
        let tab = tabOf state id
        match fault with
        | FakeFault.Quota -> withTab id { tab with Quota = true } state
        | FakeFault.OpenFails error -> withTab id { tab with OpenFails = Some error } state
        | FakeFault.Missing -> withTab id { tab with Missing = true } state
        | FakeFault.StorageCleared -> storageCleared (withTab id tab state)

    /// A raw connection, outside every tab, that ignores version changes.
    let holdOpen (id: string) (database: string) (state: FakeState) : FakeState = { state with Holdouts = state.Holdouts.Add(physical (tabOf state id) database) }
    let release (id: string) (database: string) (state: FakeState) : FakeState = { state with Holdouts = state.Holdouts.Remove(physical (tabOf state id) database) }

    /// The facts a tab received since it last took them, in order.
    let takeFacts (id: string) (state: FakeState) : Wire.Fact list * FakeState =
        let tab = tabOf state id
        tab.Facts, withTab id { tab with Facts = [] } state

    // -- The executors: the only stateful part ------------------------------

    /// Executors for tabs of one shared origin: each call registers a tab and
    /// answers its executor. The state lives in one cell nothing else sees.
    let origin (storage: FakeStorage option) : string -> FakeTabConfig -> FakeExecutor =
        let cell = ref (create storage)
        fun id config ->
            cell.Value <- register id config cell.Value
            { Execute = fun request -> async { let next, result = stepAs id cell.Value request in cell.Value <- next; return result }
              TakeFacts = fun () -> let facts, next = takeFacts id cell.Value in cell.Value <- next; facts
              Inject = fun fault -> cell.Value <- inject id fault cell.Value }

    /// One tab's executor over its own origin.
    let executor (config: FakeTabConfig) (storage: FakeStorage option) : FakeExecutor = origin storage "main" config
