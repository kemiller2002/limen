// Limen localization: the F# reference implementation of the language-neutral
// semantics in conformance/localization/README.md (kemiller2002/limen#35).
//
// Choosing a locale, a message and its text is application meaning, so it is
// pure engine-side code. The browser facts it needs — the user's languages
// and the CLDR plural category for a number — arrive from the environment
// pack; nothing here reads a browser or formats numbers and dates.
namespace Limen.Localization

open System

[<RequireQualifiedAccess>]
type Direction =
    | Ltr
    | Rtl

[<RequireQualifiedAccess>]
type Message =
    | Text of template: string
    /// A template per CLDR category; "other" is the fallback.
    | Plural of templates: Map<string, string>

type Catalogues = Map<string, Map<string, Message>>

[<RequireQualifiedAccess>]
type Rendered =
    | Found of locale: string * text: string * missing: string list
    | NotFound of id: string

module Tag =
    let private lower (tag: string) = tag.ToLowerInvariant()

    let subtags (tag: string) = tag.Split('-') |> List.ofArray

    /// The tag without its last subtag; a single-letter subtag goes with the
    /// subtag after it (RFC 4647 lookup).
    let truncate (tag: string) : string option =
        let parts = subtags tag
        if parts.Length <= 1 then None
        else
            let shorter = parts |> List.take (parts.Length - 1)
            let trimmed =
                match List.rev shorter with
                | singleton :: rest when singleton.Length = 1 -> List.rev rest
                | _ -> shorter
            if trimmed.IsEmpty then None else Some(String.Join("-", trimmed))

    /// The tag, then each truncation, most specific first.
    let rec lookupOrder (tag: string) : string list =
        match truncate tag with
        | Some shorter -> tag :: lookupOrder shorter
        | None -> [ tag ]

    let sameAs (left: string) (right: string) = lower left = lower right

module Locale =
    /// RFC 4647 lookup over the user's preferred tags, in order.
    let negotiate (available: string list) (preferred: string list) (fallback: string) : string =
        preferred
        |> List.collect Tag.lookupOrder
        |> List.tryPick (fun candidate -> available |> List.tryFind (Tag.sameAs candidate))
        |> Option.defaultValue fallback

    /// The locale, its truncations, then the fallback, without duplicates.
    let chain (locale: string) (fallback: string) : string list =
        Tag.lookupOrder locale @ [ fallback ] |> List.distinctBy (fun tag -> tag.ToLowerInvariant())

    let private rtlScripts = set [ "arab"; "hebr"; "thaa"; "syrc"; "nkoo"; "adlm"; "rohg" ]
    let private rtlLanguages = set [ "ar"; "he"; "iw"; "fa"; "ur"; "ps"; "dv"; "yi"; "ckb"; "sd"; "ug" ]

    let direction (tag: string) : Direction =
        let parts = Tag.subtags tag |> List.map (fun part -> part.ToLowerInvariant())
        let script = parts |> List.skip 1 |> List.tryFind (fun part -> part.Length = 4 && part |> Seq.forall Char.IsLetter)
        match script, parts with
        | Some script, _ -> if rtlScripts.Contains script then Direction.Rtl else Direction.Ltr
        | None, language :: _ when rtlLanguages.Contains language -> Direction.Rtl
        | None, _ -> Direction.Ltr

module Messages =
    /// Fill {name} placeholders; {{ and }} are literal braces. A placeholder
    /// with no argument stays as written and is reported.
    let fill (template: string) (args: Map<string, string>) : string * string list =
        let rec go (index: int) (text: Text.StringBuilder) (missing: string list) =
            if index >= template.Length then text.ToString(), List.rev missing
            else
                let current = template[index]
                let next = if index + 1 < template.Length then Some template[index + 1] else None
                match current, next with
                | '{', Some '{' -> go (index + 2) (text.Append '{') missing
                | '}', Some '}' -> go (index + 2) (text.Append '}') missing
                | '{', _ ->
                    match template.IndexOf('}', index + 1) with
                    | -1 -> go (index + 1) (text.Append current) missing
                    | close ->
                        let name = template.Substring(index + 1, close - index - 1)
                        match args |> Map.tryFind name with
                        | Some value -> go (close + 1) (text.Append value) missing
                        | None -> go (close + 1) (text.Append('{').Append(name).Append('}')) (if List.contains name missing then missing else name :: missing)
                | _ -> go (index + 1) (text.Append current) missing
        go 0 (Text.StringBuilder()) []

    let private select (message: Message) (category: string option) : string =
        match message with
        | Message.Text template -> template
        | Message.Plural templates ->
            category
            |> Option.bind (fun wanted -> templates |> Map.tryFind wanted)
            |> Option.orElse (templates |> Map.tryFind "other")
            |> Option.defaultValue ""

    let render (catalogues: Catalogues) (chain: string list) (id: string) (args: Map<string, string>) (category: string option) : Rendered =
        chain
        |> List.tryPick (fun locale ->
            catalogues
            |> Map.tryFindKey (fun key _ -> Tag.sameAs key locale)
            |> Option.bind (fun key -> catalogues[key] |> Map.tryFind id |> Option.map (fun message -> key, message)))
        |> function
            | Some(locale, message) ->
                let text, missing = fill (select message category) args
                Rendered.Found(locale, text, missing)
            | None -> Rendered.NotFound id
