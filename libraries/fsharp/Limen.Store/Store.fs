/// A pure functional API for Limen's IndexedDB store capability, limen.store
/// version 2 (LCP-045). Schemas, keys, ranges and transactions are immutable
/// values; every builder is total (an Error before any request exists); every
/// outcome is a closed union inside Result, never an exception; the only
/// effect is the StoreExecutor the host supplies. Time, identifiers and
/// randomness are inputs. Nothing here names a browser API.
namespace Limen.Store

open System
open System.Globalization
open System.Text
open System.Text.Json
open Limen.Contract

/// The wire contract this library speaks (generated from
/// contract/store.contract.json).
module Wire =
    type Request = Limen.Contract.Store.Types.StoreRequest
    type Result = Limen.Contract.Store.Types.StoreResult
    type Fact = Limen.Contract.Store.Types.StoreFact
    type Operation = Limen.Contract.Store.Types.Operation
    type OperationResult = Limen.Contract.Store.Types.OperationResult
    let unit = Limen.Contract.Store.Contract.Unit
    let version = Limen.Contract.Store.Contract.Version
    let fingerprint = Limen.Contract.Store.Contract.Fingerprint

/// The one effect: the host performs a request and answers with the pack's
/// result. In the browser this is the engine's Limen request loop; in tests,
/// the in-memory fake.
type StoreExecutor = Wire.Request -> Async<Wire.Result>

// ---------------------------------------------------------------------------
// JSON values and codecs (LCP-049)
// ---------------------------------------------------------------------------

/// An immutable JSON value. Object members keep their order.
[<RequireQualifiedAccess>]
type Json =
    | Null
    | Bool of bool
    | Number of float
    | String of string
    | Array of Json list
    | Object of (string * Json) list

module Json =
    let rec private ofElement (element: JsonElement) : Json =
        match element.ValueKind with
        | JsonValueKind.Null -> Json.Null
        | JsonValueKind.True -> Json.Bool true
        | JsonValueKind.False -> Json.Bool false
        | JsonValueKind.Number -> Json.Number(element.GetDouble())
        | JsonValueKind.String -> Json.String(element.GetString())
        | JsonValueKind.Array -> Json.Array [ for item in element.EnumerateArray() -> ofElement item ]
        | JsonValueKind.Object -> Json.Object [ for member' in element.EnumerateObject() -> member'.Name, ofElement member'.Value ]
        | _ -> Json.Null

    /// Parses JSON text; malformed text is an Error naming only its position.
    let parse (RawJson text) : Result<Json, string> =
        try
            use document = JsonDocument.Parse text
            Ok(ofElement document.RootElement)
        with :? JsonException as error -> Error("malformed JSON at byte " + string (error.BytePositionInLine |> Option.ofNullable |> Option.defaultValue 0L))

    // Rendered by hand, as RFC 8259 requires and no more: no serializer and
    // no options object, so nothing here needs reflection or a type-info
    // resolver in a trimmed WebAssembly publish.
    let private quoted (text: string) =
        let builder = StringBuilder(text.Length + 2)
        builder.Append '"' |> ignore
        for ch in text do
            match ch with
            | '"' -> builder.Append "\\\"" |> ignore
            | '\\' -> builder.Append "\\\\" |> ignore
            | '\n' -> builder.Append "\\n" |> ignore
            | '\r' -> builder.Append "\\r" |> ignore
            | '\t' -> builder.Append "\\t" |> ignore
            | '\b' -> builder.Append "\\b" |> ignore
            | '\f' -> builder.Append "\\f" |> ignore
            | c when c < ' ' -> builder.Append("\\u").Append((int c).ToString("x4", CultureInfo.InvariantCulture)) |> ignore
            | c -> builder.Append c |> ignore
        builder.Append('"').ToString()

    // The shortest text that round-trips the double, as JavaScript writes it
    // (an exponent may be "E+21" where JavaScript writes "e+21"; both are JSON).
    let private number (value: float) = value.ToString("R", CultureInfo.InvariantCulture)

    /// Whether every number in the value is finite: JSON cannot carry NaN or
    /// the infinities, and encoding refuses them.
    let rec finite (value: Json) =
        match value with
        | Json.Number number -> Double.IsFinite number
        | Json.Array items -> items |> List.forall finite
        | Json.Object members -> members |> List.forall (snd >> finite)
        | Json.Null | Json.Bool _ | Json.String _ -> true

    let rec private text (value: Json) : string =
        match value with
        | Json.Null -> "null"
        | Json.Bool true -> "true"
        | Json.Bool false -> "false"
        // Total: a number JSON cannot carry renders as null. Every encoder in
        // this library refuses one first (Json.finite), so only a caller
        // rendering by hand can reach it.
        | Json.Number number when not (Double.IsFinite number) -> "null"
        | Json.Number value -> number value
        | Json.String value -> quoted value
        | Json.Array items -> "[" + String.Join(",", items |> List.map text) + "]"
        | Json.Object members -> "{" + String.Join(",", members |> List.map (fun (name, item) -> quoted name + ":" + text item)) + "}"

    /// Renders compact JSON, as it crosses the boundary.
    let render (value: Json) : RawJson = RawJson(text value)

/// Why a value could not be encoded. Names the field, never the value.
type EncodeProblem = { Path: string; Problem: string }

/// Why stored JSON did not decode: the field path and what was expected
/// there, never the value found.
type DecodeProblem = { Path: string; Expected: string }

/// An explicit codec for one stored type: an encoder to JSON and a decoder
/// to Result. The guests are reflection-free, so there is no implicit one.
[<NoEquality; NoComparison>]
type Codec<'T> =
    { Encode: 'T -> Result<Json, EncodeProblem>
      Decode: string -> Json -> Result<'T, DecodeProblem> }

/// What a record decoder reads its fields from.
type Fields = private Fields of path: string * members: (string * Json) list

module Codec =
    let private expected path what : Result<'T, DecodeProblem> = Error { Path = path; Expected = what }
    let private maxSafe = 9007199254740991L
    // This module defines codecs named string, int64 and so on; the
    // built-in conversions are reached through these.
    let private ordinal (index: int) = index.ToString(CultureInfo.InvariantCulture)

    let string : Codec<string> =
        { Encode = fun value -> Ok(Json.String value)
          Decode = fun path json -> match json with Json.String value -> Ok value | _ -> expected path "a string" }

    let bool : Codec<bool> =
        { Encode = fun value -> Ok(Json.Bool value)
          Decode = fun path json -> match json with Json.Bool value -> Ok value | _ -> expected path "a boolean" }

    /// Finite numbers only: NaN and the infinities are refused at encode time.
    let float : Codec<float> =
        { Encode = fun value -> if Double.IsFinite value then Ok(Json.Number value) else Error { Path = "$"; Problem = "a number that is not finite" }
          Decode = fun path json -> match json with Json.Number value -> Ok value | _ -> expected path "a number" }

    /// 64-bit integers: within ±(2^53 − 1) as a JSON number, beyond it as a
    /// string of digits, so nothing is rounded on the way through JavaScript.
    let int64 : Codec<int64> =
        { Encode = fun value -> Ok(if value > maxSafe || value < -maxSafe then Json.String(value.ToString(CultureInfo.InvariantCulture)) else Json.Number(double value))
          Decode =
            fun path json ->
                match json with
                | Json.Number value when Math.Floor value = value && abs value <= double maxSafe -> Ok(int64 value)
                | Json.String digits ->
                    match Int64.TryParse(digits, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture) with
                    | true, value -> Ok value
                    | false, _ -> expected path "an integer"
                | _ -> expected path "an integer" }

    /// Timestamps as ISO-8601 text with an offset, round-tripped exactly.
    let dateTimeOffset : Codec<DateTimeOffset> =
        { Encode = fun value -> Ok(Json.String(value.ToString("o", CultureInfo.InvariantCulture)))
          Decode =
            fun path json ->
                match json with
                | Json.String text ->
                    match DateTimeOffset.TryParseExact(text, "o", CultureInfo.InvariantCulture, DateTimeStyles.None) with
                    | true, value -> Ok value
                    | false, _ -> expected path "an ISO-8601 timestamp with an offset"
                | _ -> expected path "an ISO-8601 timestamp with an offset" }

    let private traverse (step: int -> 'a -> Result<'b, 'e>) (items: 'a list) : Result<'b list, 'e> =
        let folder (index, acc) item =
            match acc with
            | Error error -> index + 1, Error error
            | Ok values -> index + 1, (step index item |> Result.map (fun value -> value :: values))
        items |> List.fold folder (0, Ok []) |> snd |> Result.map List.rev

    let list (item: Codec<'T>) : Codec<'T list> =
        { Encode = fun values -> traverse (fun index value -> item.Encode value |> Result.mapError (fun problem -> { problem with Path = "$[" + ordinal index + "]" + problem.Path.TrimStart('$') })) values |> Result.map Json.Array
          Decode =
            fun path json ->
                match json with
                | Json.Array items -> traverse (fun index element -> item.Decode (path + "[" + ordinal index + "]") element) items
                | _ -> expected path "a list" }

    /// None is JSON null.
    let option (item: Codec<'T>) : Codec<'T option> =
        { Encode = fun value -> match value with Some inner -> item.Encode inner | None -> Ok Json.Null
          Decode = fun path json -> match json with Json.Null -> Ok None | other -> item.Decode path other |> Result.map Some }

    /// A codec for a record (or any type) through its own object form.
    let record (encode: 'T -> Result<(string * Json) list, EncodeProblem>) (decode: Fields -> Result<'T, DecodeProblem>) : Codec<'T> =
        { Encode = fun value -> encode value |> Result.map Json.Object
          Decode = fun path json -> match json with Json.Object members -> decode (Fields(path, members)) | _ -> expected path "an object" }

    /// One field for a record encoder.
    let field (name: string) (codec: Codec<'T>) (value: 'T) : Result<string * Json, EncodeProblem> =
        codec.Encode value |> Result.map (fun json -> name, json) |> Result.mapError (fun problem -> { problem with Path = "$." + name + problem.Path.TrimStart('$') })

    /// The fields of a record encoder, or the first that failed.
    let fields (items: Result<string * Json, EncodeProblem> list) : Result<(string * Json) list, EncodeProblem> = traverse (fun _ item -> item) items

    /// A required field for a record decoder.
    let required (name: string) (codec: Codec<'T>) (Fields(path, members)) : Result<'T, DecodeProblem> =
        match members |> List.tryFind (fun (key, _) -> key = name) with
        | Some(_, json) -> codec.Decode (path + "." + name) json
        | None -> expected (path + "." + name) "a value (the field is missing)"

    /// An optional field: absent and null are None.
    let optional (name: string) (codec: Codec<'T>) (Fields(path, members)) : Result<'T option, DecodeProblem> =
        match members |> List.tryFind (fun (key, _) -> key = name) with
        | Some(_, Json.Null)
        | None -> Ok None
        | Some(_, json) -> codec.Decode (path + "." + name) json |> Result.map Some

    let encode (codec: Codec<'T>) (value: 'T) : Result<RawJson, EncodeProblem> =
        match codec.Encode value with
        | Ok json when Json.finite json -> Ok(Json.render json)
        | Ok _ -> Error { Path = "$"; Problem = "a number that is not finite" }
        | Error problem -> Error problem

    let decode (codec: Codec<'T>) (raw: RawJson) : Result<'T, DecodeProblem> =
        match Json.parse raw with
        | Ok json -> codec.Decode "$" json
        | Error _ -> expected "$" "JSON"

// ---------------------------------------------------------------------------
// Keys, key paths, ranges and schemas (LCP-047, LCP-055)
// ---------------------------------------------------------------------------

/// A key: a string, a finite number, or a tuple of keys (a compound key).
[<RequireQualifiedAccess>]
type Key =
    | Text of string
    | Number of float
    | Tuple of Key list

module Key =
    let rec valid (key: Key) =
        match key with
        | Key.Text _ -> true
        | Key.Number number -> Double.IsFinite number
        | Key.Tuple parts -> parts |> List.forall valid

    let rec toJson (key: Key) : Json =
        match key with
        | Key.Text text -> Json.String text
        | Key.Number number -> Json.Number number
        | Key.Tuple parts -> Json.Array(parts |> List.map toJson)

    let rec ofJson (json: Json) : Key option =
        match json with
        | Json.String text -> Some(Key.Text text)
        | Json.Number number when Double.IsFinite number -> Some(Key.Number number)
        | Json.Array items ->
            let parts = items |> List.map ofJson
            if parts |> List.forall Option.isSome then Some(Key.Tuple(parts |> List.choose id)) else None
        | _ -> None

    /// How a key is named in an error: its JSON, with an invalid number
    /// spelled out. Keys are identifiers, not stored values. Total.
    let rec label (key: Key) : string =
        match key with
        | Key.Text _ -> Json.render (toJson key) |> fun (RawJson text) -> text
        | Key.Number number when Double.IsFinite number -> Json.render (toJson key) |> fun (RawJson text) -> text
        | Key.Number number -> if Double.IsNaN number then "NaN" elif number > 0.0 then "Infinity" else "-Infinity"
        | Key.Tuple parts -> "[" + String.Join(",", parts |> List.map label) + "]"

/// A key path: one dotted path, or a compound list of two or more.
[<RequireQualifiedAccess>]
type KeyPath =
    | Path of string
    | Compound of string list

type Index = { Name: string; KeyPath: KeyPath; Unique: bool; MultiEntry: bool }

type StoreDefinition = { Name: string; KeyPath: KeyPath; Indexes: Index list }

/// A database's declared schema: built only through Schema.create.
type Schema = private { Database: string; Version: int64; Stores: StoreDefinition list; Drop: string list }

/// A key range; build it with Range.
type Range = private { Lower: Key option; Upper: Key option; LowerOpen: bool; UpperOpen: bool }

/// Why a builder refused its input, before any request exists.
type BuildProblem = { Problem: string }

module private Rules =
    let problem text : Result<'T, BuildProblem> = Error { Problem = text }

    let name (what: string) (value: string) =
        if value = "" then problem (what + " needs a name")
        elif value.Contains "/" then problem (what + " " + value + " may not contain \"/\" (the namespace separator)")
        else Ok value

    let keyPath (owner: string) (path: KeyPath) =
        match path with
        | KeyPath.Path "" -> problem (owner + " needs a key path")
        | KeyPath.Path _ -> Ok path
        | KeyPath.Compound parts when parts.Length < 2 || parts |> List.exists ((=) "") -> problem (owner + " needs two or more non-empty compound key path parts")
        | KeyPath.Compound _ -> Ok path

    let duplicates (names: string list) = names |> List.countBy id |> List.filter (fun (_, count) -> count > 1) |> List.map fst

    let rec firstError (results: Result<unit, BuildProblem> list) =
        match results with
        | [] -> Ok()
        | Error error :: _ -> Error error
        | Ok() :: rest -> firstError rest

module Range =
    let private make lower upper lowerOpen upperOpen : Result<Range, BuildProblem> =
        let invalid = [ lower; upper ] |> List.choose id |> List.exists (Key.valid >> not)
        if invalid then Rules.problem "a range bound is not a valid key"
        elif lower.IsNone && upper.IsNone then Rules.problem "a range needs a lower or an upper bound"
        else Ok { Lower = lower; Upper = upper; LowerOpen = lowerOpen; UpperOpen = upperOpen }

    let between (lower: Key) (upper: Key) = make (Some lower) (Some upper) false false
    let atLeast (lower: Key) = make (Some lower) None false false
    let above (lower: Key) = make (Some lower) None true false
    let atMost (upper: Key) = make None (Some upper) false false
    let below (upper: Key) = make None (Some upper) false true
    let only (key: Key) = between key key

    /// Every compound key that starts with these parts: from [parts] to
    /// [parts, []], since a list sorts after every string and number.
    let prefix (parts: Key list) = make (Some(Key.Tuple parts)) (Some(Key.Tuple(parts @ [ Key.Tuple [] ]))) false false

module Schema =
    let private indexCheck (store: StoreDefinition) (index: Index) =
        if index.Name = "" then Rules.problem ("store " + store.Name + " has an unnamed index")
        else
            match Rules.keyPath ("index " + store.Name + "." + index.Name) index.KeyPath with
            | Error error -> Error error
            | Ok(KeyPath.Compound _) when index.MultiEntry -> Rules.problem ("index " + store.Name + "." + index.Name + " is compound and multiEntry; IndexedDB allows only one")
            | Ok _ -> Ok()

    let private storeCheck (store: StoreDefinition) =
        if store.Name = "" then Rules.problem "a store needs a name"
        else
            match Rules.keyPath ("store " + store.Name) store.KeyPath, Rules.duplicates (store.Indexes |> List.map (fun index -> index.Name)) with
            | Error error, _ -> Error error
            | Ok _, repeated :: _ -> Rules.problem ("store " + store.Name + " declares index " + repeated + " twice")
            | Ok _, [] -> Rules.firstError (store.Indexes |> List.map (indexCheck store))

    /// A schema the pack will accept, or why not (LCP-055: versions are
    /// positive integers; a store is never both declared and dropped).
    let create (database: string) (version: int64) (stores: StoreDefinition list) (drop: string list) : Result<Schema, BuildProblem> =
        match Rules.name "a database" database with
        | Error error -> Error error
        | Ok _ when version < 1L -> Rules.problem "version must be a positive integer"
        | Ok _ ->
            match Rules.duplicates (stores |> List.map (fun store -> store.Name)) with
            | repeated :: _ -> Rules.problem ("store " + repeated + " is declared twice")
            | [] when drop |> List.exists (fun name -> stores |> List.exists (fun store -> store.Name = name)) -> Rules.problem "a store cannot be both declared and dropped"
            | [] -> Rules.firstError (stores |> List.map storeCheck) |> Result.map (fun () -> { Database = database; Version = version; Stores = stores; Drop = drop })

    let database (schema: Schema) = schema.Database
    let version (schema: Schema) = schema.Version
    let stores (schema: Schema) = schema.Stores

// ---------------------------------------------------------------------------
// Operations and transactions: the mode is a type (LCP-052)
// ---------------------------------------------------------------------------

/// The mode of a transaction that only reads.
type ReadOnly = private | ReadOnlyMode

/// The mode of a transaction that may write.
type ReadWrite = private | ReadWriteMode

/// One operation, usable in a transaction of mode 'Mode. A read is generic
/// in its mode, so it fits either; a write is Op<ReadWrite> only, so putting
/// it into a readonly transaction does not compile.
type Op<'Mode> = private Op of Wire.Operation

/// A transaction of mode 'Mode on one database: build it with Transaction.
type Transaction<'Mode> = private { Database: string; Writes: bool; Operations: Wire.Operation list }

module Op =
    let private key (k: Key) = if Key.valid k then Ok(Json.render (Key.toJson k)) else Rules.problem ("a key is not valid: " + Key.label k)
    let private storeName store = Rules.name "a store" store
    let private range (value: Range option) : Limen.Contract.Store.Types.KeyRange option =
        value |> Option.map (fun r ->
            { Lower = r.Lower |> Option.map (Key.toJson >> Json.render)
              Upper = r.Upper |> Option.map (Key.toJson >> Json.render)
              LowerOpen = r.LowerOpen
              UpperOpen = r.UpperOpen })
    let private value (codec: Codec<'T>) (item: 'T) =
        match codec.Encode item with
        | Ok(Json.Object _ as json) when Json.finite json -> Ok(Json.render json)
        | Ok(Json.Object _) -> Rules.problem "a stored value contains a number that is not finite"
        | Ok _ -> Rules.problem "a stored value must encode to a JSON object (a record)"
        | Error problem -> Rules.problem ("the value does not encode at " + problem.Path + ": " + problem.Problem)
    let private both (left: Result<'a, BuildProblem>) (right: Result<'b, BuildProblem>) = match left, right with Ok a, Ok b -> Ok(a, b) | Error e, _ | _, Error e -> Error e

    let get (store: string) (k: Key) : Result<Op<'Mode>, BuildProblem> =
        both (storeName store) (key k) |> Result.map (fun (s, json) -> Op(Wire.Operation.Get(s, json)))

    /// Records in key order (of the index, when given), at most limit, 1 to 1000.
    let query (store: string) (index: string option) (r: Range option) (limit: int) (reverse: bool) : Result<Op<'Mode>, BuildProblem> =
        if limit < 1 || limit > 1000 then Rules.problem "limit must be 1 to 1000"
        else storeName store |> Result.map (fun s -> Op(Wire.Operation.Query(s, index, range r, int64 limit, reverse)))

    let count (store: string) (index: string option) (r: Range option) : Result<Op<'Mode>, BuildProblem> =
        storeName store |> Result.map (fun s -> Op(Wire.Operation.Count(s, index, range r)))

    let put (store: string) (codec: Codec<'T>) (item: 'T) : Result<Op<ReadWrite>, BuildProblem> =
        both (storeName store) (value codec item) |> Result.map (fun (s, json) -> Op(Wire.Operation.Put(s, json)))

    /// Compare-and-put: write item only if what is stored under its key is
    /// expected (None: only if absent); otherwise the transaction aborts as a
    /// conflict reporting what is stored.
    let putIf (store: string) (codec: Codec<'T>) (item: 'T) (expectedValue: 'T option) : Result<Op<ReadWrite>, BuildProblem> =
        let expectedJson =
            match expectedValue with
            | None -> Ok(RawJson "null")
            | Some current -> value codec current
        both (both (storeName store) (value codec item)) expectedJson
        |> Result.map (fun ((s, json), expectedRaw) -> Op(Wire.Operation.PutIf(s, json, expectedRaw)))

    let delete (store: string) (k: Key) : Result<Op<ReadWrite>, BuildProblem> =
        both (storeName store) (key k) |> Result.map (fun (s, json) -> Op(Wire.Operation.Delete(s, json)))

    /// Delete every record in the range; None clears the store.
    let deleteRange (store: string) (r: Range option) : Result<Op<ReadWrite>, BuildProblem> =
        storeName store |> Result.map (fun s -> Op(Wire.Operation.DeleteRange(s, range r)))

module Transaction =
    let private build (database: string) (writes: bool) (operations: Result<Op<'Mode>, BuildProblem> list) : Result<Transaction<'Mode>, BuildProblem> =
        match Rules.name "a database" database, operations with
        | Error error, _ -> Error error
        | Ok _, [] -> Rules.problem "a transaction needs at least one operation"
        | Ok _, _ ->
            let folder acc item =
                match acc, item with
                | Error error, _ -> Error error
                | Ok _, Error error -> Error error
                | Ok ops, Ok(Op op) -> Ok(op :: ops)
            operations |> List.fold folder (Ok []) |> Result.map (fun ops -> { Database = database; Writes = writes; Operations = List.rev ops })

    /// A readonly transaction: only reads type-check here.
    let readOnly (database: string) (operations: Result<Op<ReadOnly>, BuildProblem> list) = build database false operations

    /// A readwrite transaction: reads and writes.
    let readWrite (database: string) (operations: Result<Op<ReadWrite>, BuildProblem> list) = build database true operations

    let database (transaction: Transaction<'Mode>) = transaction.Database
    let writes (transaction: Transaction<'Mode>) = transaction.Writes

    let request (transaction: Transaction<'Mode>) : Wire.Request =
        Wire.Request.Transact(
            transaction.Database,
            (if transaction.Writes then Limen.Contract.Store.Types.TransactionMode.Readwrite else Limen.Contract.Store.Types.TransactionMode.Readonly),
            transaction.Operations)

// ---------------------------------------------------------------------------
// Outcomes: one closed union per request kind (LCP-053)
// ---------------------------------------------------------------------------

type Limits = { MaxValueBytes: int64; MaxTransactionBytes: int64 }

type Opened = { Version: int64; UpgradedFrom: int64; Created: bool option; Limits: Limits option }

/// Why an open did not open. A result kind the pack never sends for an open
/// is Unexpected, named, never thrown.
[<RequireQualifiedAccess>]
type OpenFailure =
    | VersionBlocked
    | Outdated of stored: int64
    | SchemaMismatch of problems: string list
    | Unavailable of reason: string
    | Invalid of problem: string
    | Cancelled
    | Unexpected of kind: string

[<RequireQualifiedAccess>]
type AbortCause =
    | Conflict
    | Constraint
    | InvalidKey
    | UnknownStore
    | Other

/// Why a transaction applied nothing. QuotaExceeded is its own case.
[<RequireQualifiedAccess>]
type TransactFailure =
    | Aborted of cause: AbortCause * operation: int option * current: RawJson option
    | QuotaExceeded
    | NotOpen
    | Cancelled
    | Invalid of problem: string
    | Unavailable of reason: string
    | Unexpected of kind: string

[<RequireQualifiedAccess>]
type CloseFailure =
    | NotOpen
    | Invalid of problem: string
    | Unavailable of reason: string
    | Cancelled
    | Unexpected of kind: string

[<RequireQualifiedAccess>]
type DeleteFailure =
    | VersionBlocked
    | Invalid of problem: string
    | Unavailable of reason: string
    | Cancelled
    | Unexpected of kind: string

/// The browser's estimate of usage and quota, in bytes. Advisory: no
/// decision in this library depends on it, and an unreported count is None.
type StorageEstimate = { UsageEstimate: int64 option; QuotaEstimate: int64 option }

[<RequireQualifiedAccess>]
type Availability =
    | Available
    | Missing
    | Refused of reason: string
    | Broken of reason: string

[<RequireQualifiedAccess>]
type DurabilityFailure =
    | Unsupported
    | Invalid of problem: string
    | Cancelled
    | Unexpected of kind: string

module Outcome =
    let private kind (result: Wire.Result) =
        match result with
        | Wire.Result.Opened _ -> "Opened"
        | Wire.Result.VersionConflict _ -> "VersionConflict"
        | Wire.Result.SchemaMismatch _ -> "SchemaMismatch"
        | Wire.Result.Blocked -> "Blocked"
        | Wire.Result.Committed _ -> "Committed"
        | Wire.Result.Aborted _ -> "Aborted"
        | Wire.Result.NotOpen -> "NotOpen"
        | Wire.Result.Closed -> "Closed"
        | Wire.Result.DatabaseDeleted -> "DatabaseDeleted"
        | Wire.Result.InvalidRequest _ -> "InvalidRequest"
        | Wire.Result.Unavailable _ -> "Unavailable"
        | Wire.Result.Cancelled -> "Cancelled"
        | Wire.Result.Persisted _ -> "Persisted"
        | Wire.Result.Persistence _ -> "Persistence"
        | Wire.Result.Estimate _ -> "Estimate"
        | Wire.Result.Availability _ -> "Availability"
        | Wire.Result.Unsupported -> "Unsupported"

    let ofOpen (result: Wire.Result) : Result<Opened, OpenFailure> =
        match result with
        | Wire.Result.Opened(version, upgradedFrom, limits, created) ->
            Ok { Version = version; UpgradedFrom = upgradedFrom; Created = created; Limits = limits |> Option.map (fun l -> { MaxValueBytes = l.MaxValueBytes; MaxTransactionBytes = l.MaxTransactionBytes }) }
        | Wire.Result.VersionConflict stored -> Error(OpenFailure.Outdated stored)
        | Wire.Result.SchemaMismatch problems -> Error(OpenFailure.SchemaMismatch problems)
        | Wire.Result.Blocked -> Error OpenFailure.VersionBlocked
        | Wire.Result.Unavailable reason -> Error(OpenFailure.Unavailable reason)
        | Wire.Result.InvalidRequest problem -> Error(OpenFailure.Invalid problem)
        | Wire.Result.Cancelled -> Error OpenFailure.Cancelled
        | Wire.Result.Committed _ | Wire.Result.Aborted _ | Wire.Result.NotOpen | Wire.Result.Closed | Wire.Result.DatabaseDeleted
        | Wire.Result.Persisted _ | Wire.Result.Persistence _ | Wire.Result.Estimate _ | Wire.Result.Availability _ | Wire.Result.Unsupported -> Error(OpenFailure.Unexpected(kind result))

    let private cause (reason: Limen.Contract.Store.Types.AbortReason) =
        match reason with
        | Limen.Contract.Store.Types.AbortReason.Conflict -> Some AbortCause.Conflict
        | Limen.Contract.Store.Types.AbortReason.Constraint -> Some AbortCause.Constraint
        | Limen.Contract.Store.Types.AbortReason.InvalidKey -> Some AbortCause.InvalidKey
        | Limen.Contract.Store.Types.AbortReason.UnknownStore -> Some AbortCause.UnknownStore
        | Limen.Contract.Store.Types.AbortReason.Other -> Some AbortCause.Other
        | Limen.Contract.Store.Types.AbortReason.Quota -> None

    let ofTransact (result: Wire.Result) : Result<Wire.OperationResult list, TransactFailure> =
        match result with
        | Wire.Result.Committed results -> Ok results
        | Wire.Result.Aborted(reason, operation, current) ->
            match cause reason with
            | Some abortCause -> Error(TransactFailure.Aborted(abortCause, operation |> Option.map int, current))
            | None -> Error TransactFailure.QuotaExceeded
        | Wire.Result.NotOpen -> Error TransactFailure.NotOpen
        | Wire.Result.Cancelled -> Error TransactFailure.Cancelled
        | Wire.Result.InvalidRequest problem -> Error(TransactFailure.Invalid problem)
        | Wire.Result.Unavailable reason -> Error(TransactFailure.Unavailable reason)
        | Wire.Result.Opened _ | Wire.Result.VersionConflict _ | Wire.Result.SchemaMismatch _ | Wire.Result.Blocked | Wire.Result.Closed | Wire.Result.DatabaseDeleted
        | Wire.Result.Persisted _ | Wire.Result.Persistence _ | Wire.Result.Estimate _ | Wire.Result.Availability _ | Wire.Result.Unsupported -> Error(TransactFailure.Unexpected(kind result))

    let ofClose (result: Wire.Result) : Result<unit, CloseFailure> =
        match result with
        | Wire.Result.Closed -> Ok()
        | Wire.Result.NotOpen -> Error CloseFailure.NotOpen
        | Wire.Result.InvalidRequest problem -> Error(CloseFailure.Invalid problem)
        | Wire.Result.Unavailable reason -> Error(CloseFailure.Unavailable reason)
        | Wire.Result.Cancelled -> Error CloseFailure.Cancelled
        | Wire.Result.Opened _ | Wire.Result.VersionConflict _ | Wire.Result.SchemaMismatch _ | Wire.Result.Blocked | Wire.Result.Committed _ | Wire.Result.Aborted _ | Wire.Result.DatabaseDeleted
        | Wire.Result.Persisted _ | Wire.Result.Persistence _ | Wire.Result.Estimate _ | Wire.Result.Availability _ | Wire.Result.Unsupported -> Error(CloseFailure.Unexpected(kind result))

    let ofDelete (result: Wire.Result) : Result<unit, DeleteFailure> =
        match result with
        | Wire.Result.DatabaseDeleted -> Ok()
        | Wire.Result.Blocked -> Error DeleteFailure.VersionBlocked
        | Wire.Result.InvalidRequest problem -> Error(DeleteFailure.Invalid problem)
        | Wire.Result.Unavailable reason -> Error(DeleteFailure.Unavailable reason)
        | Wire.Result.Cancelled -> Error DeleteFailure.Cancelled
        | Wire.Result.Opened _ | Wire.Result.VersionConflict _ | Wire.Result.SchemaMismatch _ | Wire.Result.Committed _ | Wire.Result.Aborted _ | Wire.Result.NotOpen | Wire.Result.Closed
        | Wire.Result.Persisted _ | Wire.Result.Persistence _ | Wire.Result.Estimate _ | Wire.Result.Availability _ | Wire.Result.Unsupported -> Error(DeleteFailure.Unexpected(kind result))

    let private durability (result: Wire.Result) : DurabilityFailure =
        match result with
        | Wire.Result.Unsupported -> DurabilityFailure.Unsupported
        | Wire.Result.InvalidRequest problem -> DurabilityFailure.Invalid problem
        | Wire.Result.Cancelled -> DurabilityFailure.Cancelled
        | other -> DurabilityFailure.Unexpected(kind other)

    /// persist: whether the browser granted persistent storage.
    let ofPersist (result: Wire.Result) : Result<bool, DurabilityFailure> =
        match result with
        | Wire.Result.Persisted granted -> Ok granted
        | other -> Error(durability other)

    /// persisted: whether storage is persistent now.
    let ofPersisted (result: Wire.Result) : Result<bool, DurabilityFailure> =
        match result with
        | Wire.Result.Persistence persistent -> Ok persistent
        | other -> Error(durability other)

    let ofEstimate (result: Wire.Result) : Result<StorageEstimate, DurabilityFailure> =
        match result with
        | Wire.Result.Estimate(usage, quota) -> Ok { UsageEstimate = usage; QuotaEstimate = quota }
        | other -> Error(durability other)

    let ofAvailability (result: Wire.Result) : Result<Availability, DurabilityFailure> =
        match result with
        | Wire.Result.Availability(Limen.Contract.Store.Types.AvailabilityClass.Available, _) -> Ok Availability.Available
        | Wire.Result.Availability(Limen.Contract.Store.Types.AvailabilityClass.Missing, _) -> Ok Availability.Missing
        | Wire.Result.Availability(Limen.Contract.Store.Types.AvailabilityClass.Refused, reason) -> Ok(Availability.Refused(defaultArg reason "unknown"))
        | Wire.Result.Availability(Limen.Contract.Store.Types.AvailabilityClass.Broken, reason) -> Ok(Availability.Broken(defaultArg reason "unknown"))
        | other -> Error(durability other)

// ---------------------------------------------------------------------------
// Structured errors (LCP-072) and redaction (LCP-068)
// ---------------------------------------------------------------------------

[<RequireQualifiedAccess>]
type ErrorClass =
    | Unavailable
    | Quota
    | Conflict
    | Version
    | Invalid
    | Undecodable
    | ConnectionLost
    | Protocol

/// A failure an application can show or classify: the operation, the
/// database and store, the class and a stable code. It never carries a stored
/// value: a conflict's current value stays in TransactFailure, not here.
type StoreError =
    { Operation: string
      Database: string
      Store: string option
      Class: ErrorClass
      Code: string
      Detail: string }

module StoreError =
    let code (errorClass: ErrorClass) (specific: string) =
        let family =
            match errorClass with
            | ErrorClass.Unavailable -> "unavailable"
            | ErrorClass.Quota -> "quota"
            | ErrorClass.Conflict -> "conflict"
            | ErrorClass.Version -> "version"
            | ErrorClass.Invalid -> "invalid"
            | ErrorClass.Undecodable -> "undecodable"
            | ErrorClass.ConnectionLost -> "connection-lost"
            | ErrorClass.Protocol -> "protocol"
        "limen.store." + family + "." + specific

    let private make operation database errorClass specific detail =
        { Operation = operation; Database = database; Store = None; Class = errorClass; Code = code errorClass specific; Detail = detail }

    let ofBuild (operation: string) (database: string) (problem: BuildProblem) = make operation database ErrorClass.Invalid "request" problem.Problem

    let ofOpen (database: string) (failure: OpenFailure) =
        match failure with
        | OpenFailure.VersionBlocked -> make "open" database ErrorClass.Version "blocked" "another page holds an older version open"
        | OpenFailure.Outdated stored -> make "open" database ErrorClass.Version "outdated" ("the stored version " + string stored + " is newer than this code's")
        | OpenFailure.SchemaMismatch problems -> make "open" database ErrorClass.Version "schema-mismatch" (String.Join("; ", problems))
        | OpenFailure.Unavailable reason -> make "open" database ErrorClass.Unavailable "open" reason
        | OpenFailure.Invalid problem -> make "open" database ErrorClass.Invalid "request" problem
        | OpenFailure.Cancelled -> make "open" database ErrorClass.Unavailable "cancelled" "cancelled"
        | OpenFailure.Unexpected kind -> make "open" database ErrorClass.Protocol "unexpected" kind

    /// The conflict's current value is dropped: errors carry names, counts
    /// and sizes only.
    let ofTransact (database: string) (failure: TransactFailure) =
        let abortCode cause =
            match cause with
            | AbortCause.Conflict -> ErrorClass.Conflict, "conflict"
            | AbortCause.Constraint -> ErrorClass.Conflict, "constraint"
            | AbortCause.InvalidKey -> ErrorClass.Invalid, "invalid-key"
            | AbortCause.UnknownStore -> ErrorClass.Invalid, "unknown-store"
            | AbortCause.Other -> ErrorClass.Unavailable, "aborted"
        match failure with
        | TransactFailure.Aborted(cause, operation, _) ->
            let errorClass, specific = abortCode cause
            make "transact" database errorClass specific (match operation with Some index -> "operation " + string index | None -> "the commit")
        | TransactFailure.QuotaExceeded -> make "transact" database ErrorClass.Quota "exceeded" "the browser's storage quota"
        | TransactFailure.NotOpen -> make "transact" database ErrorClass.ConnectionLost "not-open" "the database is not open on this page"
        | TransactFailure.Cancelled -> make "transact" database ErrorClass.Unavailable "cancelled" "cancelled"
        | TransactFailure.Invalid problem -> make "transact" database ErrorClass.Invalid "request" problem
        | TransactFailure.Unavailable reason -> make "transact" database ErrorClass.Unavailable "transact" reason
        | TransactFailure.Unexpected kind -> make "transact" database ErrorClass.Protocol "unexpected" kind

    /// A stored value that did not decode: names the store, the key and the
    /// field path, never the value.
    let undecodable (database: string) (store: string) (key: string) (problem: DecodeProblem) =
        { make "read" database ErrorClass.Undecodable "value" ("key " + key + " at " + problem.Path + ": expected " + problem.Expected) with Store = Some store }

// ---------------------------------------------------------------------------
// Reading results back
// ---------------------------------------------------------------------------

module Read =
    let private decodeAt (codec: Codec<'T>) database store keyLabel raw =
        match Json.parse raw with
        | Error _ -> Error(StoreError.undecodable database store keyLabel { Path = "$"; Expected = "JSON" })
        | Ok json -> codec.Decode "$" json |> Result.mapError (StoreError.undecodable database store keyLabel)

    /// A get's result: Some value, None when missing, or Undecodable.
    let value (codec: Codec<'T>) (database: string) (store: string) (key: Key) (result: Wire.OperationResult) : Result<'T option, StoreError> =
        match result with
        | Wire.OperationResult.Found raw -> decodeAt codec database store (Key.label key) raw |> Result.map Some
        | Wire.OperationResult.Missing -> Ok None
        | _ -> Error { StoreError.ofTransact database (TransactFailure.Unexpected "not a get result") with Store = Some store }

    /// A query's records, in order, or the first that does not decode.
    let values (codec: Codec<'T>) (database: string) (store: string) (result: Wire.OperationResult) : Result<'T list, StoreError> =
        match result with
        | Wire.OperationResult.Queried raws ->
            raws
            |> List.mapi (fun index raw -> decodeAt codec database store ("#" + string index) raw)
            |> List.fold (fun acc item -> match acc, item with Ok xs, Ok x -> Ok(x :: xs) | Error e, _ | _, Error e -> Error e) (Ok [])
            |> Result.map List.rev
        | _ -> Error { StoreError.ofTransact database (TransactFailure.Unexpected "not a query result") with Store = Some store }

    let count (result: Wire.OperationResult) : int64 option =
        match result with
        | Wire.OperationResult.Counted n -> Some n
        | _ -> None

// ---------------------------------------------------------------------------
// The connection, as a value the engine keeps (LCP-056, LCP-057, LCP-062)
// ---------------------------------------------------------------------------

/// What this page knows about one database's connection.
[<RequireQualifiedAccess>]
type Connection =
    | NotOpened
    | Open of Opened
    /// The stored version is newer than this code's: nothing may be written,
    /// and nothing here can delete or recreate the database.
    | Outdated of stored: int64
    /// Another page upgraded or deleted it; reopen at a version this code understands.
    | Changed of newVersion: int64
    /// The browser closed it under the page (storage cleared or evicted).
    | Lost
    | Closed

module Connection =
    let initial = Connection.NotOpened

    let afterOpen (outcome: Result<Opened, OpenFailure>) (current: Connection) : Connection =
        match outcome with
        | Ok opened -> Connection.Open opened
        | Error(OpenFailure.Outdated stored) -> Connection.Outdated stored
        | Error _ -> current

    /// A fact about this database moves the connection; a fact about another
    /// database leaves it.
    let afterFact (database: string) (fact: Wire.Fact) (current: Connection) : Connection =
        match fact with
        | Wire.Fact.VersionChanged(name, newVersion) when name = database -> Connection.Changed newVersion
        | Wire.Fact.ConnectionLost name when name = database -> Connection.Lost
        | Wire.Fact.VersionChanged _
        | Wire.Fact.ConnectionLost _ -> current

    let afterClose (current: Connection) : Connection =
        match current with
        | Connection.Open _ -> Connection.Closed
        | other -> other

    /// Only an open connection may send a transaction.
    let canTransact (current: Connection) =
        match current with
        | Connection.Open _ -> true
        | Connection.NotOpened | Connection.Outdated _ | Connection.Changed _ | Connection.Lost | Connection.Closed -> false

// ---------------------------------------------------------------------------
// Forward-only migration planning (LCP-055)
// ---------------------------------------------------------------------------

[<RequireQualifiedAccess>]
type PlanProblem =
    | NotPositive of version: int64
    | Repeat of version: int64
    | Gap of after: int64 * next: int64
    | NotIncreasing of after: int64 * next: int64

module Migration =
    /// The steps to run, in order, after the stored version. Versions are
    /// positive, consecutive and increasing; a repeat or a gap is refused.
    let plan (stored: int64) (steps: (int64 * 'Step) list) : Result<(int64 * 'Step) list, PlanProblem> =
        let versions = steps |> List.map fst
        match versions |> List.tryFind (fun version -> version < 1L) with
        | Some version -> Error(PlanProblem.NotPositive version)
        | None ->
            let pairs = List.pairwise versions
            match pairs |> List.tryFind (fun (a, b) -> a = b) with
            | Some(version, _) -> Error(PlanProblem.Repeat version)
            | None ->
                match pairs |> List.tryFind (fun (a, b) -> b < a) with
                | Some(a, b) -> Error(PlanProblem.NotIncreasing(a, b))
                | None ->
                    match pairs |> List.tryFind (fun (a, b) -> b <> a + 1L) with
                    | Some(a, b) -> Error(PlanProblem.Gap(a, b))
                    | None -> Ok(steps |> List.filter (fun (version, _) -> version > stored))

    /// Steps whose marker is already stored are skipped.
    let pending (done': Set<int64>) (planned: (int64 * 'Step) list) = planned |> List.filter (fun (version, _) -> not (done'.Contains version))

    type Marker = { Id: string; Version: int64 }

    let markerCodec : Codec<Marker> =
        Codec.record
            (fun marker -> Codec.fields [ Codec.field "id" Codec.string marker.Id; Codec.field "version" Codec.int64 marker.Version ])
            (fun fields ->
                match Codec.required "id" Codec.string fields, Codec.required "version" Codec.int64 fields with
                | Ok id, Ok version -> Ok { Id = id; Version = version }
                | Error e, _ | _, Error e -> Error e)

    let markerKey (version: int64) = Key.Text("migration/" + string version)

    /// One step and its marker in a single transaction: the marker is put
    /// only if absent, so a step that already committed aborts as a conflict
    /// instead of running twice.
    let step (database: string) (markerStore: string) (version: int64) (operations: Result<Op<ReadWrite>, BuildProblem> list) =
        Transaction.readWrite database (operations @ [ Op.putIf markerStore markerCodec { Id = "migration/" + string version; Version = version } None ])

// ---------------------------------------------------------------------------
// Diagnostics an application can show (LCP-073)
// ---------------------------------------------------------------------------

/// Every field a value; an unknown measurement is None, never zero.
type StoreDiagnostics =
    { UsageEstimate: int64 option
      QuotaEstimate: int64 option
      Persisted: bool option
      Databases: (string * Connection) list }

module Diagnostics =
    let empty = { UsageEstimate = None; QuotaEstimate = None; Persisted = None; Databases = [] }
    let withEstimate (estimate: StorageEstimate) (diagnostics: StoreDiagnostics) = { diagnostics with UsageEstimate = estimate.UsageEstimate; QuotaEstimate = estimate.QuotaEstimate }
    let withPersisted (persisted: bool) (diagnostics: StoreDiagnostics) = { diagnostics with Persisted = Some persisted }
    let withConnection (database: string) (connection: Connection) (diagnostics: StoreDiagnostics) =
        { diagnostics with Databases = (diagnostics.Databases |> List.filter (fun (name, _) -> name <> database)) @ [ database, connection ] }

// ---------------------------------------------------------------------------
// The API over a StoreExecutor
// ---------------------------------------------------------------------------

module Store =
    /// The identity an engine selects in its handshake to use this library.
    let capability : Limen.Contract.Core.Types.CapabilityOffer =
        { Id = Limen.Contract.Core.Types.CapabilityId Wire.unit; Version = Wire.version; Fingerprint = Wire.fingerprint }

    let openRequest (schema: Schema) : Wire.Request =
        Wire.Request.Open(
            schema.Database,
            schema.Version,
            schema.Stores |> List.map (fun store ->
                let path, paths =
                    match store.KeyPath with
                    | KeyPath.Path p -> p, None
                    | KeyPath.Compound ps -> "", Some ps
                { Name = store.Name
                  KeyPath = path
                  KeyPaths = paths
                  Indexes =
                    store.Indexes |> List.map (fun index ->
                        let ipath, ipaths =
                            match index.KeyPath with
                            | KeyPath.Path p -> p, None
                            | KeyPath.Compound ps -> "", Some ps
                        ({ Name = index.Name; KeyPath = ipath; KeyPaths = ipaths; Unique = index.Unique; MultiEntry = index.MultiEntry } : Limen.Contract.Store.Types.IndexSchema)) } : Limen.Contract.Store.Types.StoreSchema),
            schema.Drop)

    /// Open (and upgrade) a database. The connection is updated from the
    /// outcome; Outdated is remembered so later writes are refused locally.
    let openDatabase (execute: StoreExecutor) (schema: Schema) : Async<Result<Opened, OpenFailure>> =
        async {
            let! result = execute (openRequest schema)
            return Outcome.ofOpen result
        }

    /// Run a transaction. A connection that is not open never sends it: the
    /// answer is NotOpen at once (LCP-056, LCP-057).
    let transact (execute: StoreExecutor) (connection: Connection) (transaction: Transaction<'Mode>) : Async<Result<Wire.OperationResult list, TransactFailure>> =
        if not (Connection.canTransact connection) then async { return Error TransactFailure.NotOpen }
        else
            async {
                let! result = execute (Transaction.request transaction)
                return Outcome.ofTransact result
            }

    let close (execute: StoreExecutor) (database: string) : Async<Result<unit, CloseFailure>> =
        async {
            let! result = execute (Wire.Request.Close database)
            return Outcome.ofClose result
        }

    /// Delete a database. There is deliberately no path from Outdated to a
    /// delete: an Outdated connection refuses (LCP-056).
    let deleteDatabase (execute: StoreExecutor) (connection: Connection) (database: string) : Async<Result<unit, DeleteFailure>> =
        match connection with
        | Connection.Outdated _ -> async { return Error(DeleteFailure.Invalid "this page's code is older than the stored database; it may not delete it") }
        | Connection.NotOpened | Connection.Open _ | Connection.Changed _ | Connection.Lost | Connection.Closed ->
            async {
                let! result = execute (Wire.Request.DeleteDatabase database)
                return Outcome.ofDelete result
            }

    /// Ask for persistent storage. Call it after the first offline write is
    /// queued, never on first load (OQ-LIMEN-IDB-004).
    let persist (execute: StoreExecutor) = async { let! result = execute Wire.Request.Persist in return Outcome.ofPersist result }
    let persisted (execute: StoreExecutor) = async { let! result = execute Wire.Request.Persisted in return Outcome.ofPersisted result }
    let estimate (execute: StoreExecutor) = async { let! result = execute Wire.Request.Estimate in return Outcome.ofEstimate result }
    let availability (execute: StoreExecutor) = async { let! result = execute Wire.Request.Availability in return Outcome.ofAvailability result }
