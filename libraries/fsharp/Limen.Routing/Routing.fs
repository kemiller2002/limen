// Limen routing: the F# reference implementation of the language-neutral
// semantics in conformance/routing/README.md (kemiller2002/limen#20).
//
// Routing is application meaning, so it lives in the engine. This module
// resolves a location the browser reported, builds the canonical location
// for a destination, and decides the one Navigation effect (push, replace or
// none) that keeps the browser's history consistent with the engine. It
// never touches the browser; the kernel performs the effect.
//
// The API shape is F#'s own; only the semantics are shared across languages.
namespace Limen.Routing

open System
open System.Text

[<RequireQualifiedAccess>]
type ParamType =
    | String
    | Int

[<RequireQualifiedAccess>]
type Segment =
    | Literal of string
    | Param of name: string * ParamType
    | Wildcard of name: string

type QueryParam = { Name: string; Type: ParamType; Required: bool }

/// A value in a route template: a source parameter to copy, or a literal.
[<RequireQualifiedAccess>]
type Template =
    | FromParam of string
    | Literal of string

type Route =
    { Name: string
      Path: Segment list
      Query: QueryParam list
      Children: Route list
      Redirect: (string * (string * Template) list) option
      Guard: string option
      Requires: string list }

[<RequireQualifiedAccess>]
type Value =
    | Text of string
    | Integer of int64

type Level = { Route: string; Params: Map<string, Value> }

type Match =
    { Route: string
      Chain: Level list
      Query: Map<string, Value>
      Requires: string list
      RedirectedFrom: string list }

[<RequireQualifiedAccess>]
type GuardDecision =
    | Allow
    | Deny
    | Redirect of route: string * parameters: Map<string, Value> * query: Map<string, Value>

[<RequireQualifiedAccess>]
type Resolution =
    | Matched of Match
    | NotFound
    | MalformedPath
    | MalformedQuery
    | Invalid of route: string * parameter: string * value: string * expected: string
    | RedirectLoop of chain: string list
    | Denied of route: string

[<RequireQualifiedAccess>]
type BuildError =
    | UnknownRoute
    | MissingParameter of string
    | InvalidParameter of string

[<RequireQualifiedAccess>]
type NavigationEffect =
    | Push of string
    | Replace of string

module Route =
    let private parseSegment (text: string) =
        if text.StartsWith "{*" && text.EndsWith "}" then Segment.Wildcard(text.Substring(2, text.Length - 3))
        elif text.StartsWith "{" && text.EndsWith "}" then
            match text.Substring(1, text.Length - 2).Split ':' with
            | [| name; "int" |] -> Segment.Param(name, ParamType.Int)
            | [| name; "string" |]
            | [| name |] -> Segment.Param(name, ParamType.String)
            | _ -> invalidArg "path" $"Unknown parameter segment {text}"
        else Segment.Literal text

    /// "invoices/{id:int}/lines/{line:int}" → segments. "" is an index.
    let path (text: string) =
        text.Split('/', StringSplitOptions.RemoveEmptyEntries) |> Array.map parseSegment |> List.ofArray

    let create name pathText =
        { Name = name
          Path = path pathText
          Query = []
          Children = []
          Redirect = None
          Guard = None
          Requires = [] }

module private Text =
    let private strict = UTF8Encoding(false, true)

    let private isUnreserved (b: byte) =
        (b >= byte 'A' && b <= byte 'Z') || (b >= byte 'a' && b <= byte 'z') || (b >= byte '0' && b <= byte '9')
        || b = byte '-' || b = byte '.' || b = byte '_' || b = byte '~'

    let encode (value: string) =
        strict.GetBytes value
        |> Array.map (fun b -> if isUnreserved b then string (char b) else $"%%{int b:X2}")
        |> String.concat ""

    let private hex (c: char) =
        if c >= '0' && c <= '9' then Some(int c - int '0')
        elif c >= 'A' && c <= 'F' then Some(int c - int 'A' + 10)
        elif c >= 'a' && c <= 'f' then Some(int c - int 'a' + 10)
        else None

    /// Strict percent-decoding as UTF-8: an invalid escape, a lone surrogate
    /// or invalid UTF-8 is None.
    let decode (plusIsSpace: bool) (value: string) =
        let isPlain (c: char) = c <> '%' && not (plusIsSpace && c = '+')

        let rec bytes index (acc: byte list) =
            if index >= value.Length then Some(List.rev acc)
            else
                match value[index] with
                | '%' when index + 2 < value.Length ->
                    match hex value[index + 1], hex value[index + 2] with
                    | Some high, Some low -> bytes (index + 3) (byte (high * 16 + low) :: acc)
                    | _ -> None
                | '%' -> None
                | '+' when plusIsSpace -> bytes (index + 1) (byte ' ' :: acc)
                | _ ->
                    let run = value.Substring(index) |> Seq.takeWhile isPlain |> Seq.length
                    bytes (index + run) (List.rev (List.ofArray (strict.GetBytes(value.Substring(index, run)))) @ acc)

        try
            bytes 0 [] |> Option.map (fun decoded -> strict.GetString(Array.ofList decoded))
        with
        | :? EncoderFallbackException
        | :? DecoderFallbackException -> None

module Router =
    let private maxSafe = 9007199254740991L

    let private parseInt (text: string) =
        let canonical =
            text = "0"
            || (text.Length > 0
                && (let digits = if text.StartsWith "-" then text.Substring 1 else text
                    digits.Length > 0 && digits.Length <= 16 && digits[0] <> '0' && digits |> Seq.forall Char.IsAsciiDigit))

        if not canonical then None
        else
            match Int64.TryParse text with
            | true, value when abs value <= maxSafe -> Some value
            | _ -> None

    let private convert kind (raw: string) =
        match kind with
        | ParamType.String -> Some(Value.Text raw)
        | ParamType.Int -> parseInt raw |> Option.map Value.Integer

    let private typeName kind =
        match kind with
        | ParamType.String -> "string"
        | ParamType.Int -> "int"

    let private full (prefix: string) (name: string) = if prefix = "" then name else $"{prefix}.{name}"

    // ------------------------------------------------------------------
    // Structural matching: literals and segment counts only; types later.
    // ------------------------------------------------------------------

    type private Binding = { Level: string; Name: string; Type: ParamType; Raw: string }

    let rec private consume (level: string) (pattern: Segment list) (segments: string list) (bound: Binding list) =
        match pattern, segments with
        | [], rest -> Some(List.rev bound, rest)
        | [ Segment.Wildcard name ], rest -> Some(List.rev ({ Level = level; Name = name; Type = ParamType.String; Raw = String.concat "/" rest } :: bound), [])
        | Segment.Literal literal :: pattern, segment :: rest when segment = literal -> consume level pattern rest bound
        | Segment.Param(name, kind) :: pattern, segment :: rest -> consume level pattern rest ({ Level = level; Name = name; Type = kind; Raw = segment } :: bound)
        | _ -> None

    let rec private matchRoute (prefix: string) (route: Route) (segments: string list) : ((string * Route) list * Binding list) option =
        let name = full prefix route.Name

        consume name route.Path segments []
        |> Option.bind (fun (bound, rest) ->
            if List.isEmpty route.Children then
                if List.isEmpty rest then Some([ name, route ], bound) else None
            else
                route.Children
                |> List.tryPick (fun child -> matchRoute name child rest)
                |> Option.map (fun (chain, childBound) -> (name, route) :: chain, bound @ childBound))

    let private matchTable (table: Route list) segments =
        table |> List.tryPick (fun route -> matchRoute "" route segments)

    let private findDestination (table: Route list) (fullName: string) =
        let rec walk (routes: Route list) (names: string list) (prefix: string) acc =
            match names with
            | [] -> None
            | name :: rest ->
                routes
                |> List.tryFind (fun route -> route.Name = name)
                |> Option.bind (fun route ->
                    let chain = acc @ [ full prefix name, route ]
                    if List.isEmpty rest then (if List.isEmpty route.Children then Some chain else None)
                    else walk route.Children rest (full prefix name) chain)

        walk table (List.ofArray (fullName.Split '.')) "" []

    // ------------------------------------------------------------------
    // Building
    // ------------------------------------------------------------------

    let private render kind (name: string) (value: Value) =
        match kind, value with
        | ParamType.String, Value.Text text -> Ok text
        | ParamType.Int, Value.Integer number when abs number <= maxSafe -> Ok(string number)
        | ParamType.Int, Value.Text text when (parseInt text).IsSome -> Ok text
        | _ -> Error(BuildError.InvalidParameter name)

    let private sequence (results: Result<'a, 'e> list) =
        List.foldBack (fun item acc -> Result.bind (fun items -> Result.map (fun value -> value :: items) item) acc) results (Ok [])

    let build (table: Route list) (fullName: string) (parameters: Map<string, Value>) (query: Map<string, Value>) : Result<string, BuildError> =
        match findDestination table fullName with
        | None -> Error BuildError.UnknownRoute
        | Some chain ->
            let routes = chain |> List.map snd

            let segment piece =
                match piece with
                | Segment.Literal literal -> Ok(Text.encode literal)
                | Segment.Param(name, kind) ->
                    match Map.tryFind name parameters with
                    | None -> Error(BuildError.MissingParameter name)
                    | Some value -> render kind name value |> Result.map Text.encode
                | Segment.Wildcard name ->
                    match Map.tryFind name parameters with
                    | Some(Value.Text text) -> Ok(text.Split('/', StringSplitOptions.RemoveEmptyEntries) |> Array.map Text.encode |> String.concat "/")
                    | Some _ -> Error(BuildError.InvalidParameter name)
                    | None -> Ok ""

            let pair (declared: QueryParam) =
                match Map.tryFind declared.Name query with
                | None when declared.Required -> Some(Error(BuildError.MissingParameter declared.Name))
                | None -> None
                | Some value -> Some(render declared.Type declared.Name value |> Result.map (fun text -> $"{Text.encode declared.Name}={Text.encode text}"))

            let path = routes |> List.collect (fun route -> route.Path) |> List.map segment |> sequence
            let pairs = routes |> List.collect (fun route -> route.Query) |> List.choose pair |> sequence

            match path, pairs with
            | Error error, _
            | _, Error error -> Error error
            | Ok segments, Ok pairs ->
                let joined = "/" + (segments |> List.filter (fun piece -> piece <> "") |> String.concat "/")
                Ok(if List.isEmpty pairs then joined else joined + "?" + String.concat "&" pairs)

    // ------------------------------------------------------------------
    // Resolving
    // ------------------------------------------------------------------

    let private decodePath (path: string) =
        let pieces = path.Split('/', StringSplitOptions.RemoveEmptyEntries) |> List.ofArray |> List.map (Text.decode false)
        if pieces |> List.forall Option.isSome then Some(pieces |> List.choose id) else None

    let private decodeQuery (query: string) =
        let raw = if query.StartsWith "?" then query.Substring 1 else query

        let pieces =
            raw.Split('&', StringSplitOptions.RemoveEmptyEntries)
            |> List.ofArray
            |> List.map (fun part ->
                let index = part.IndexOf '='
                let key, value = if index < 0 then part, "" else part.Substring(0, index), part.Substring(index + 1)
                match Text.decode true key, Text.decode true value with
                | Some key, Some value -> Some(key, value)
                | _ -> None)

        if pieces |> List.forall Option.isSome then Some(pieces |> List.choose id) else None

    let private splitLocation (location: string) =
        let index = location.IndexOf '?'
        if index < 0 then location, "" else location.Substring(0, index), location.Substring index

    let private redirectRoute (route: Route) = route.Redirect

    /// Step 4: typed path parameters, per chain level.
    let private typedLevels (chain: (string * Route) list) (bindings: Binding list) =
        let converted =
            bindings
            |> List.map (fun binding ->
                match convert binding.Type binding.Raw with
                | Some value -> Ok(binding.Level, binding.Name, value)
                | None -> Error(Resolution.Invalid(binding.Level, binding.Name, binding.Raw, typeName binding.Type)))

        match converted |> List.tryPick (function Error e -> Some e | Ok _ -> None) with
        | Some invalid -> Error invalid
        | None ->
            let values = converted |> List.choose (function Ok v -> Some v | Error _ -> None)
            Ok(chain |> List.map (fun (name, route) -> { Route = route.Name; Params = values |> List.filter (fun (level, _, _) -> level = name) |> List.map (fun (_, key, value) -> key, value) |> Map.ofList }), values)

    /// Step 6: declared query parameters along the chain, parent first.
    let private typedQuery (chain: (string * Route) list) (pairs: (string * string) list) =
        let declared = chain |> List.collect (fun (name, route) -> route.Query |> List.map (fun parameter -> name, parameter))

        let check (level, parameter: QueryParam) =
            match pairs |> List.filter (fun (key, _) -> key = parameter.Name) |> List.map snd with
            | [] when parameter.Required -> Error(Resolution.Invalid(level, parameter.Name, "", $"{typeName parameter.Type} (required)"))
            | [] -> Ok None
            | [ raw ] ->
                match convert parameter.Type raw with
                | Some value -> Ok(Some(parameter.Name, value))
                | None -> Error(Resolution.Invalid(level, parameter.Name, raw, typeName parameter.Type))
            | many -> Error(Resolution.Invalid(level, parameter.Name, String.concat "," many, "a single value"))

        declared |> List.map check |> sequence |> Result.map (List.choose id >> Map.ofList)

    let rec private resolveFrom (table: Route list) (guard: string -> Match -> GuardDecision) (visited: string list) (path: string) (query: string) =
        match decodePath path, decodeQuery query with
        | None, _ -> Resolution.MalformedPath
        | _, None -> Resolution.MalformedQuery
        | Some segments, Some pairs ->
            match matchTable table segments with
            | None -> Resolution.NotFound
            | Some(chain, bindings) ->
                match typedLevels chain bindings with
                | Error invalid -> invalid
                | Ok(levels, values) ->
                    let destination = chain |> List.last |> fst
                    let visited = visited @ [ destination ]

                    if List.contains destination (List.take (visited.Length - 1) visited) then
                        Resolution.RedirectLoop visited
                    else
                        let follow target (parameters: Map<string, Value>) (targetQuery: string) =
                            match build table target parameters Map.empty with
                            | Error _ -> Resolution.Invalid(destination, target, "", "a buildable redirect target")
                            | Ok location -> resolveFrom table guard visited (fst (splitLocation location)) targetQuery

                        match chain |> List.last |> snd |> redirectRoute with
                        | Some(target, templates) ->
                            let lookup = values |> List.map (fun (_, key, value) -> key, value) |> Map.ofList

                            let parameters =
                                templates
                                |> List.choose (fun (key, template) ->
                                    match template with
                                    | Template.FromParam source -> Map.tryFind source lookup |> Option.map (fun value -> key, value)
                                    | Template.Literal literal -> Some(key, Value.Text literal))
                                |> Map.ofList

                            follow target parameters query
                        | None ->
                            match typedQuery chain pairs with
                            | Error invalid -> invalid
                            | Ok typed ->
                                let candidate =
                                    { Route = destination
                                      Chain = levels
                                      Query = typed
                                      Requires = chain |> List.collect (fun (_, route) -> route.Requires) |> List.distinct
                                      RedirectedFrom = List.take (visited.Length - 1) visited }

                                let decision =
                                    chain
                                    |> List.tryPick (fun (name, route) ->
                                        route.Guard
                                        |> Option.bind (fun guardName ->
                                            match guard guardName candidate with
                                            | GuardDecision.Allow -> None
                                            | other -> Some(name, other)))

                                match decision with
                                | None -> Resolution.Matched candidate
                                | Some(name, GuardDecision.Deny) -> Resolution.Denied name
                                | Some(_, GuardDecision.Redirect(target, parameters, guardQuery)) ->
                                    match build table target parameters guardQuery with
                                    | Error _ -> Resolution.Invalid(destination, target, "", "a buildable guard redirect target")
                                    | Ok location ->
                                        let path, query = splitLocation location
                                        resolveFrom table guard visited path query
                                | Some(_, GuardDecision.Allow) -> Resolution.Matched candidate

    /// Resolves a reported location. `guard` is the engine's decision for a
    /// named guard; it is interface policy, never an authorization boundary.
    let resolve (table: Route list) (guard: string -> Match -> GuardDecision) (path: string) (query: string) =
        resolveFrom table guard [] path query

    /// The canonical location of a match.
    let canonical (table: Route list) (matched: Match) =
        let parameters = matched.Chain |> List.collect (fun level -> Map.toList level.Params) |> Map.ofList
        build table matched.Route parameters matched.Query

/// The engine's navigation state: the location it last adopted or pushed.
type RouterState = { Current: string option }

module Navigation =
    let initial = { Current = None }

    let private split (location: string) =
        let index = location.IndexOf '?'
        if index < 0 then location, "" else location.Substring(0, index), location.Substring index

    /// A location the browser reported (a deep link in Initialize, or Back and
    /// Forward in LocationChanged). Never answered with a push: at most a
    /// replace that corrects the entry to its canonical form.
    let adopt (table: Route list) guard (state: RouterState) (location: string) =
        let path, query = split location
        let resolution = Router.resolve table guard path query

        match resolution with
        | Resolution.Matched matched ->
            match Router.canonical table matched with
            | Ok canonical when canonical <> location -> { Current = Some canonical }, resolution, Some(NavigationEffect.Replace canonical)
            | Ok canonical -> { Current = Some canonical }, resolution, None
            | Error _ -> { state with Current = Some location }, resolution, None
        | _ -> { Current = Some location }, resolution, None

    /// An in-app navigation: push the built location unless it is already current.
    let navigate (table: Route list) (state: RouterState) route parameters query =
        Router.build table route parameters query
        |> Result.map (fun location ->
            if state.Current = Some location then state, None
            else { Current = Some location }, Some(NavigationEffect.Push location))
