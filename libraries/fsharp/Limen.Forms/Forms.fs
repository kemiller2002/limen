// Limen forms: the F# reference implementation of the language-neutral form
// semantics in conformance/forms/README.md (kemiller2002/limen#21).
//
// The form is engine state with one owner: this value. The browser shows it
// through the projection and reports what the user did (input, blur, an
// autofill, a submit) as semantic events; there is no second, DOM-side form
// store to reconcile. Every command is a pure transition that returns the next
// form, what it emitted (an async validation to run, a submission to send),
// and — when it changed nothing — why.
namespace Limen.Forms

open System
open System.Globalization
open System.Text.RegularExpressions

[<RequireQualifiedAccess>]
type Kind =
    | Text
    | Integer
    | Number
    | Flag
    | Choice
    | Choices
    | Date
    | Time

type Condition = { Field: string; Equals: string }

type FieldSpec =
    { Name: string
      Kind: Kind
      Required: bool
      RequiredWhen: Condition option
      VisibleWhen: Condition option
      MinLength: int option
      MaxLength: int option
      Min: string option
      Max: string option
      Options: string list
      MinCount: int option
      MaxCount: int option
      AsyncValidator: string option
      Readonly: bool
      Disabled: bool }

type GroupSpec = { Name: string; Fields: FieldSpec list }

type Schema = { Fields: FieldSpec list; Groups: GroupSpec list }

/// A control's raw value as the browser reports it: one string, or several
/// (a checkbox group, a multi-select).
[<RequireQualifiedAccess>]
type Raw =
    | One of string
    | Many of string list

type FieldState =
    { Value: Raw
      Original: Raw
      Touched: bool
      AsyncError: string option
      ServerErrors: string list
      PendingToken: string option }

type Row = { Key: string; Fields: Map<string, FieldState> }

[<RequireQualifiedAccess>]
type Status =
    | Editing
    | Submitting of token: string
    | Submitted
    | Rejected
    | Failed
    | Unknown of token: string

/// A submitted value, typed by its field's kind.
[<RequireQualifiedAccess>]
type Typed =
    | Text of string
    | Integer of int64
    | Number of decimal
    | Flag of bool
    | List of string list

type Payload =
    { Values: (string * Typed) list
      Rows: (string * (string * (string * Typed) list) list) list }

type private Captured =
    { Fields: Map<string, Raw>
      Rows: Map<string, (string * Map<string, Raw>) list> }

type Form =
    private
        { Schema: Schema
          Fields: Map<string, FieldState>
          Rows: Map<string, Row list>
          OriginalRows: Map<string, (string * Map<string, Raw>) list>
          Global: string list
          Status: Status
          Validations: int
          Submissions: int
          InFlight: Captured option }

[<RequireQualifiedAccess>]
type Outcome =
    | Success
    | Rejected of fields: (string * string list) list * globalErrors: string list
    | Failed
    | Unknown

[<RequireQualifiedAccess>]
type Command =
    | Load of values: Map<string, Raw> * rows: Map<string, (string * Map<string, Raw>) list>
    | Input of path: string * Raw
    | Fill of (string * Raw) list
    | Blur of path: string
    | AddRow of group: string * key: string
    | RemoveRow of group: string * key: string
    | Submit of submitter: string
    | AsyncResult of path: string * token: string * error: string option
    | SubmitResult of token: string * Outcome
    | ResolveUnknown of applied: bool
    | Reset

[<RequireQualifiedAccess>]
type Emitted =
    | Validate of path: string * value: string * token: string
    | Submit of token: string * submitter: string * Payload

type FieldView =
    { Value: Raw
      Touched: bool
      Dirty: bool
      Errors: string list
      Pending: bool
      Visible: bool
      Required: bool }

module Field =
    let spec name kind =
        { Name = name
          Kind = kind
          Required = false
          RequiredWhen = None
          VisibleWhen = None
          MinLength = None
          MaxLength = None
          Min = None
          Max = None
          Options = []
          MinCount = None
          MaxCount = None
          AsyncValidator = None
          Readonly = false
          Disabled = false }

module Form =
    // ------------------------------------------------------------------
    // Paths: "name" or "group[key].field"
    // ------------------------------------------------------------------

    let private rowPath = Regex(@"^([^\[\].]+)\[([^\]]+)\]\.([^\[\].]+)$", RegexOptions.CultureInvariant)

    [<RequireQualifiedAccess>]
    type private Path =
        | Top of string
        | InRow of group: string * key: string * field: string

    let private parsePath (path: string) =
        let m = rowPath.Match path
        if m.Success then Path.InRow(m.Groups[1].Value, m.Groups[2].Value, m.Groups[3].Value) else Path.Top path

    let private rowPathOf group key field = $"{group}[{key}].{field}"

    // ------------------------------------------------------------------
    // Values and rules
    // ------------------------------------------------------------------

    let private emptyOf (spec: FieldSpec) = if spec.Kind = Kind.Choices then Raw.Many [] else Raw.One ""

    let private fresh (value: Raw) =
        { Value = value; Original = value; Touched = false; AsyncError = None; ServerErrors = []; PendingToken = None }

    let private text (raw: Raw) =
        match raw with
        | Raw.One value -> value
        | Raw.Many values -> String.concat "," values

    let private topValue (form: Form) (name: string) =
        form.Fields |> Map.tryFind name |> Option.map (fun state -> text state.Value) |> Option.defaultValue ""

    let private holds (form: Form) (condition: Condition option) =
        condition |> Option.map (fun c -> topValue form c.Field = c.Equals)

    let private visible (form: Form) (spec: FieldSpec) = holds form spec.VisibleWhen |> Option.defaultValue true

    let private required (form: Form) (spec: FieldSpec) =
        visible form spec && (spec.Required || (holds form spec.RequiredWhen |> Option.defaultValue false))

    let private validated (form: Form) (spec: FieldSpec) = visible form spec && not spec.Disabled && not spec.Readonly

    let private maxSafe = 9007199254740991L
    let private numberPattern = Regex(@"^-?(0|[1-9][0-9]*)(\.[0-9]+)?$", RegexOptions.CultureInvariant)
    let private datePattern = Regex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}$", RegexOptions.CultureInvariant)
    let private timePattern = Regex(@"^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$", RegexOptions.CultureInvariant)

    let private parseInteger (value: string) =
        let digits = if value.StartsWith "-" then value.Substring 1 else value
        let canonical = value = "0" || (digits.Length > 0 && digits.Length <= 16 && digits[0] <> '0' && digits |> Seq.forall Char.IsAsciiDigit)
        match canonical, Int64.TryParse(value, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture) with
        | true, (true, parsed) when abs parsed <= maxSafe -> Some parsed
        | _ -> None

    let private parseNumber (value: string) =
        if numberPattern.IsMatch value then
            match Decimal.TryParse(value, NumberStyles.AllowLeadingSign ||| NumberStyles.AllowDecimalPoint, CultureInfo.InvariantCulture) with
            | true, parsed -> Some parsed
            | _ -> None
        else None

    let private isDate (value: string) =
        datePattern.IsMatch value
        && fst (DateOnly.TryParseExact(value, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None))

    let private isEmpty (spec: FieldSpec) (raw: Raw) =
        match raw with
        | Raw.Many values -> List.isEmpty values
        | Raw.One value -> value = "" || (spec.Kind = Kind.Flag && value = "false")

    let private bounded below above compare (spec: FieldSpec) (parse: string -> 'a option) value =
        let under = spec.Min |> Option.bind parse |> Option.exists (fun min -> compare value min < 0)
        let over = spec.Max |> Option.bind parse |> Option.exists (fun max -> compare value max > 0)
        if under then Some below elif over then Some above else None

    /// The one synchronous error for a value, in a fixed order:
    /// required, then format, then bounds.
    let private syncError (form: Form) (spec: FieldSpec) (raw: Raw) =
        if isEmpty spec raw then
            (if required form spec then Some "required" else None)
        else
            match spec.Kind, raw with
            | Kind.Text, Raw.One value ->
                let length = value.EnumerateRunes() |> Seq.length
                if spec.MinLength |> Option.exists (fun min -> length < min) then Some "too-short"
                elif spec.MaxLength |> Option.exists (fun max -> length > max) then Some "too-long"
                else None
            | Kind.Integer, Raw.One value ->
                match parseInteger value with
                | None -> Some "not-an-integer"
                | Some number -> bounded "below-min" "above-max" compare spec parseInteger number
            | Kind.Number, Raw.One value ->
                match parseNumber value with
                | None -> Some "not-a-number"
                | Some number -> bounded "below-min" "above-max" compare spec parseNumber number
            | Kind.Date, Raw.One value ->
                if not (isDate value) then Some "not-a-date" else bounded "below-min" "above-max" (fun a b -> String.CompareOrdinal(a, b)) spec Some value
            | Kind.Time, Raw.One value ->
                if not (timePattern.IsMatch value) then Some "not-a-time" else bounded "below-min" "above-max" (fun a b -> String.CompareOrdinal(a, b)) spec Some value
            | Kind.Flag, Raw.One value -> if value = "true" || value = "false" then None else Some "not-a-flag"
            | Kind.Choice, Raw.One value -> if List.contains value spec.Options then None else Some "not-an-option"
            | Kind.Choices, Raw.Many values ->
                if values |> List.exists (fun value -> not (List.contains value spec.Options)) || List.length (List.distinct values) <> List.length values then Some "not-an-option"
                elif spec.MinCount |> Option.exists (fun min -> values.Length < min) then Some "too-few"
                elif spec.MaxCount |> Option.exists (fun max -> values.Length > max) then Some "too-many"
                else None
            | Kind.Choices, Raw.One _ -> Some "not-an-option"
            | _, Raw.Many _ -> Some "not-a-single-value"

    let private errorsOf (form: Form) (spec: FieldSpec) (state: FieldState) =
        if not (validated form spec) then []
        else Option.toList (syncError form spec state.Value) @ Option.toList state.AsyncError @ state.ServerErrors

    // ------------------------------------------------------------------
    // Addressing fields
    // ------------------------------------------------------------------

    let private groupSpec (form: Form) group = form.Schema.Groups |> List.tryFind (fun g -> g.Name = group)

    let private locate (form: Form) (path: string) =
        match parsePath path with
        | Path.Top name ->
            match form.Schema.Fields |> List.tryFind (fun spec -> spec.Name = name), Map.tryFind name form.Fields with
            | Some spec, Some state -> Some(spec, state)
            | _ -> None
        | Path.InRow(group, key, field) ->
            groupSpec form group
            |> Option.bind (fun g -> g.Fields |> List.tryFind (fun spec -> spec.Name = field))
            |> Option.bind (fun spec ->
                form.Rows
                |> Map.tryFind group
                |> Option.bind (List.tryFind (fun row -> row.Key = key))
                |> Option.bind (fun row -> Map.tryFind field row.Fields)
                |> Option.map (fun state -> spec, state))

    let private update (path: string) (change: FieldState -> FieldState) (form: Form) =
        match parsePath path with
        | Path.Top name -> { form with Fields = form.Fields |> Map.change name (Option.map change) }
        | Path.InRow(group, key, field) ->
            let rows =
                form.Rows
                |> Map.change group (Option.map (List.map (fun row -> if row.Key = key then { row with Fields = row.Fields |> Map.change field (Option.map change) } else row)))
            { form with Rows = rows }

    /// Every field in declaration order, rows after the top-level fields.
    let private everyField (form: Form) =
        let top = form.Schema.Fields |> List.map (fun spec -> spec.Name, spec, form.Fields[spec.Name])
        let rows =
            form.Schema.Groups
            |> List.collect (fun g ->
                form.Rows
                |> Map.tryFind g.Name
                |> Option.defaultValue []
                |> List.collect (fun row -> g.Fields |> List.map (fun spec -> rowPathOf g.Name row.Key spec.Name, spec, row.Fields[spec.Name])))
        top @ rows

    // ------------------------------------------------------------------
    // Queries
    // ------------------------------------------------------------------

    let field (form: Form) (path: string) : FieldView option =
        locate form path
        |> Option.map (fun (spec, state) ->
            { Value = state.Value
              Touched = state.Touched
              Dirty = state.Value <> state.Original
              Errors = errorsOf form spec state
              Pending = state.PendingToken.IsSome
              Visible = visible form spec
              Required = required form spec })

    let status (form: Form) = form.Status

    let globalErrors (form: Form) = form.Global

    let rows (form: Form) group = form.Rows |> Map.tryFind group |> Option.defaultValue [] |> List.map (fun row -> row.Key)

    let isValid (form: Form) =
        everyField form |> List.forall (fun (_, spec, state) -> List.isEmpty (errorsOf form spec state) && (not (validated form spec) || state.PendingToken.IsNone))

    let isDirty (form: Form) =
        let rowKeys (rows: Map<string, (string * Map<string, Raw>) list>) = rows |> Map.map (fun _ list -> List.map fst list)
        (everyField form |> List.exists (fun (_, _, state) -> state.Value <> state.Original))
        || rowKeys form.OriginalRows <> (form.Rows |> Map.map (fun _ list -> list |> List.map (fun row -> row.Key)))

    let canSubmit (form: Form) =
        match form.Status with
        | Status.Submitting _
        | Status.Unknown _ -> false
        | _ -> true

    // ------------------------------------------------------------------
    // Transitions
    // ------------------------------------------------------------------

    let private rowOf (g: GroupSpec) (key: string) (values: Map<string, Raw>) =
        { Key = key
          Fields = g.Fields |> List.map (fun spec -> spec.Name, fresh (values |> Map.tryFind spec.Name |> Option.defaultValue (emptyOf spec))) |> Map.ofList }

    let private loaded (form: Form) (values: Map<string, Raw>) (rowValues: Map<string, (string * Map<string, Raw>) list>) =
        let originalRows = form.Schema.Groups |> List.map (fun g -> g.Name, rowValues |> Map.tryFind g.Name |> Option.defaultValue []) |> Map.ofList
        { form with
            Fields = form.Schema.Fields |> List.map (fun spec -> spec.Name, fresh (values |> Map.tryFind spec.Name |> Option.defaultValue (emptyOf spec))) |> Map.ofList
            Rows = form.Schema.Groups |> List.map (fun g -> g.Name, originalRows[g.Name] |> List.map (fun (key, v) -> rowOf g key v)) |> Map.ofList
            OriginalRows = originalRows
            Global = []
            Status = Status.Editing
            InFlight = None }

    let create (schema: Schema) =
        loaded
            { Schema = schema
              Fields = Map.empty
              Rows = Map.empty
              OriginalRows = Map.empty
              Global = []
              Status = Status.Editing
              Validations = 0
              Submissions = 0
              InFlight = None }
            Map.empty
            Map.empty

    let private editable (form: Form) (spec: FieldSpec) = validated form spec

    let private reopen (form: Form) =
        match form.Status with
        | Status.Submitted
        | Status.Rejected
        | Status.Failed -> { form with Status = Status.Editing }
        | _ -> form

    /// A new value: clears that field's async and server errors, and starts an
    /// async validation when the field has one and its value is otherwise valid.
    let private setValue (path: string) (spec: FieldSpec) (raw: Raw) (form: Form) =
        let changed = form |> update path (fun state -> { state with Value = raw; AsyncError = None; ServerErrors = []; PendingToken = None }) |> reopen
        match spec.AsyncValidator with
        | Some _ when validated changed spec && not (isEmpty spec raw) && (syncError changed spec raw).IsNone ->
            let token = $"v{changed.Validations + 1}"
            { (changed |> update path (fun state -> { state with PendingToken = Some token })) with Validations = changed.Validations + 1 },
            [ Emitted.Validate(path, text raw, token) ]
        | _ -> changed, []

    let private touchAll (form: Form) =
        everyField form
        |> List.filter (fun (_, spec, _) -> validated form spec)
        |> List.fold (fun acc (path, _, _) -> acc |> update path (fun state -> { state with Touched = true })) form

    let private capture (form: Form) : Captured =
        { Fields = form.Fields |> Map.map (fun _ state -> state.Value)
          Rows = form.Rows |> Map.map (fun _ rows -> rows |> List.map (fun row -> row.Key, row.Fields |> Map.map (fun _ state -> state.Value))) }

    let private typed (spec: FieldSpec) (raw: Raw) =
        match spec.Kind, raw with
        | Kind.Integer, Raw.One value -> parseInteger value |> Option.map Typed.Integer
        | Kind.Number, Raw.One value -> parseNumber value |> Option.map Typed.Number
        | Kind.Flag, Raw.One value -> Some(Typed.Flag(value = "true"))
        | Kind.Choices, Raw.Many values -> Some(Typed.List values)
        | _, Raw.One value -> Some(Typed.Text value)
        | _, Raw.Many values -> Some(Typed.List values)

    /// Submitted: visible, not disabled, and not empty (a flag always is sent).
    let private payload (form: Form) : Payload =
        let sent (spec: FieldSpec) (state: FieldState) =
            visible form spec && not spec.Disabled && (spec.Kind = Kind.Flag || not (isEmpty spec state.Value))
        let pairs (specs: FieldSpec list) (fields: Map<string, FieldState>) =
            specs |> List.choose (fun spec -> let state = fields[spec.Name] in if sent spec state then typed spec state.Value |> Option.map (fun v -> spec.Name, v) else None)
        { Values = pairs form.Schema.Fields form.Fields
          Rows = form.Schema.Groups |> List.map (fun g -> g.Name, form.Rows[g.Name] |> List.map (fun row -> row.Key, pairs g.Fields row.Fields)) }

    /// The submitted values become the new originals; later edits stay dirty.
    let private accepted (form: Form) =
        match form.InFlight with
        | None -> { form with Status = Status.Submitted }
        | Some captured ->
            let withOriginal (original: Raw) (state: FieldState) = { state with Original = original; Touched = false }
            { form with
                Status = Status.Submitted
                InFlight = None
                Fields = form.Fields |> Map.map (fun name state -> withOriginal (captured.Fields |> Map.tryFind name |> Option.defaultValue state.Value) state)
                Rows =
                    form.Rows
                    |> Map.map (fun group rows ->
                        let sent = captured.Rows |> Map.tryFind group |> Option.defaultValue [] |> Map.ofList
                        rows |> List.map (fun row -> { row with Fields = row.Fields |> Map.map (fun name state -> withOriginal (sent |> Map.tryFind row.Key |> Option.bind (Map.tryFind name) |> Option.defaultValue state.Value) state) }))
                OriginalRows = captured.Rows }

    let private ignored reason (form: Form) = form, ([]: Emitted list), Some reason
    let private changed (form: Form, emitted: Emitted list) = form, emitted, (None: string option)

    /// One command, one pure transition: the next form, what it emitted, and
    /// why it changed nothing when it did not.
    let apply (command: Command) (form: Form) : Form * Emitted list * string option =
        match command with
        | Command.Load(values, rowValues) -> changed (loaded form values rowValues, [])
        | Command.Input(path, raw) ->
            match locate form path with
            | None -> ignored "unknown-field" form
            | Some(spec, _) when not (editable form spec) -> ignored "not-editable" form
            | Some(spec, _) -> changed (setValue path spec raw form)
        | Command.Fill values ->
            // An autofill or password manager: several values at once, no
            // touch. Fields it cannot edit are skipped, as a browser skips them.
            let order = everyField form |> List.map (fun (path, _, _) -> path)
            values
            |> List.sortBy (fun (path, _) -> order |> List.tryFindIndex ((=) path) |> Option.defaultValue Int32.MaxValue)
            |> List.fold (fun (acc, emitted) (path, raw) ->
                match locate acc path with
                | Some(spec, _) when editable acc spec -> let next, more = setValue path spec raw acc in next, emitted @ more
                | _ -> acc, emitted) (form, [])
            |> changed
        | Command.Blur path ->
            match locate form path with
            | None -> ignored "unknown-field" form
            | Some _ -> changed (update path (fun state -> { state with Touched = true }) form, [])
        | Command.AddRow(group, key) ->
            match groupSpec form group with
            | None -> ignored "unknown-group" form
            | Some _ when rows form group |> List.contains key -> ignored "duplicate-row" form
            | Some g -> changed ({ form with Rows = form.Rows |> Map.add group (form.Rows[group] @ [ rowOf g key Map.empty ]) } |> reopen, [])
        | Command.RemoveRow(group, key) ->
            if rows form group |> List.contains key then
                changed ({ form with Rows = form.Rows |> Map.add group (form.Rows[group] |> List.filter (fun row -> row.Key <> key)) } |> reopen, [])
            else ignored "unknown-row" form
        | Command.Submit submitter ->
            match form.Status with
            | Status.Submitting _ -> ignored "in-flight" form
            | Status.Unknown _ -> ignored "outcome-unknown" form
            | _ ->
                let hasErrors = everyField form |> List.exists (fun (_, spec, state) -> not (List.isEmpty (errorsOf form spec state)))
                let pending = everyField form |> List.exists (fun (_, spec, state) -> validated form spec && state.PendingToken.IsSome)
                if hasErrors then ignored "invalid" (touchAll form)
                elif pending then ignored "validation-pending" (touchAll form)
                else
                    let token = $"s{form.Submissions + 1}"
                    let next = { form with Submissions = form.Submissions + 1; Status = Status.Submitting token; Global = []; InFlight = Some(capture form) }
                    changed (next, [ Emitted.Submit(token, submitter, payload form) ])
        | Command.AsyncResult(path, token, error) ->
            match locate form path with
            | Some(_, state) when state.PendingToken = Some token -> changed (update path (fun s -> { s with PendingToken = None; AsyncError = error }) form, [])
            | _ -> ignored "stale-async" form
        | Command.SubmitResult(token, outcome) ->
            match form.Status with
            | Status.Submitting current when current = token ->
                match outcome with
                | Outcome.Success -> changed (accepted form, [])
                | Outcome.Failed -> changed ({ form with Status = Status.Failed; InFlight = None }, [])
                | Outcome.Unknown -> changed ({ form with Status = Status.Unknown token }, [])
                | Outcome.Rejected(fieldErrors, globalErrors) ->
                    let known, unknown = fieldErrors |> List.partition (fun (path, _) -> (locate form path).IsSome)
                    let withErrors = known |> List.fold (fun acc (path, messages) -> acc |> update path (fun s -> { s with ServerErrors = messages })) form
                    let orphaned = unknown |> List.collect (fun (path, messages) -> messages |> List.map (fun message -> $"{path}: {message}"))
                    changed ({ withErrors with Status = Status.Rejected; Global = globalErrors @ orphaned; InFlight = None }, [])
            | _ -> ignored "stale-submit" form
        | Command.ResolveUnknown applied ->
            match form.Status with
            | Status.Unknown _ when applied -> changed (accepted form, [])
            | Status.Unknown _ -> changed ({ form with Status = Status.Editing; InFlight = None }, [])
            | _ -> ignored "not-unknown" form
        | Command.Reset ->
            match form.Status with
            | Status.Submitting _ -> ignored "in-flight" form
            | Status.Unknown _ -> ignored "outcome-unknown" form
            | _ ->
                let values = form.Fields |> Map.map (fun _ state -> state.Original)
                changed (loaded form values form.OriginalRows, [])
