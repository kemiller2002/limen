/// The boundary check: does application code stay out of the browser?
///
/// This is the one invariant Limen exists to protect, and the only one a
/// machine can check cheaply. It is a lexical check, not a type-aware one — it
/// cannot prove the absence of browser access, only catch the ways it is
/// actually written. That limit is stated in the documentation rather than
/// implied away.
///
/// The rules are not written here. They are `architecture/boundary-rules.json`,
/// embedded into this assembly at build time — the same file Limen's own
/// repository guardrails read (`tools/guardrails/boundary.ts`). The matching
/// algorithm is implemented twice, once per language, and both
/// implementations are held to the same fixtures
/// (`test/fixtures/boundary-rules/cases.json`). A consumer therefore gets the
/// boundary Limen applies to itself, and `ruleSetSha256` says which one.
///
/// Comments and string literals are removed before matching: a comment cannot
/// reach the DOM, and a tool that flags prose trains its users to ignore it.
module Limen.Core.Boundary

open System
open System.Text.RegularExpressions
open Limen.Core.Types
open Limen.Core.Json

/// The languages a rule may name. A file in any other language is not checked.
type Language =
    | TypeScript
    | FSharp
    | CSharp
    | Rust

module Language =
    let all = [ TypeScript; FSharp; CSharp; Rust ]

    let key =
        function
        | TypeScript -> "typescript"
        | FSharp -> "fsharp"
        | CSharp -> "csharp"
        | Rust -> "rust"

/// Which rule a finding broke. The names match the repository guardrail's.
type Rule =
    | EngineAuthority
    | EngineModule
    | EngineDynamicType
    | EscapeHatch

module Rule =
    let id =
        function
        | EngineAuthority -> "engine-authority"
        | EngineModule -> "engine-module"
        | EngineDynamicType -> "engine-dynamic-type"
        | EscapeHatch -> "escape-hatch"

/// The parsed rule set. Every token list is keyed by language.
type Rules =
    { SchemaVersion: int
      Extensions: Map<string, Language>
      NeverWalked: Set<string>
      Authority: Map<Language, string list>
      ModuleSpecifierPrefixes: Map<Language, string list>
      DynamicTypes: Map<Language, string list>
      EscapeHatches: string list }

/// The embedded resource name. The project file sets it explicitly so it does
/// not depend on the directory the JSON happens to live in.
[<Literal>]
let resourceName = "Limen.Core.boundary-rules.json"

let private perLanguage (element: Text.Json.JsonElement option) =
    Language.all
    |> List.choose (fun language ->
        element
        |> Option.bind (tryProperty (Language.key language))
        |> Option.bind tryStringArray
        |> Option.map (fun tokens -> language, tokens))
    |> Map.ofList

/// Parse the rule set. Pure: the text comes from the caller.
let parseRules (text: string) : Result<Rules, string> =
    match tryParse text with
    | Error detail -> Error detail
    | Ok document ->
        use document = document
        let root = document.RootElement
        let engine = tryProperty "engine" root

        let strings name element =
            element |> Option.bind (tryProperty name) |> Option.bind tryStringArray

        match tryProperty "schemaVersion" root |> Option.bind tryInt with
        | Some 1 ->
            let extensions =
                Language.all
                |> List.collect (fun language ->
                    strings (Language.key language) (tryProperty "languages" root)
                    |> Option.defaultValue []
                    |> List.map (fun extension -> extension.ToLowerInvariant(), language))
                |> Map.ofList

            match strings "neverWalked" (Some root), strings "escapeHatches" (tryProperty "everywhere" root) with
            | Some neverWalked, Some escapeHatches when not (Map.isEmpty extensions) ->
                Ok
                    { SchemaVersion = 1
                      Extensions = extensions
                      NeverWalked = set neverWalked
                      Authority = perLanguage (engine |> Option.bind (tryProperty "authority"))
                      ModuleSpecifierPrefixes = perLanguage (engine |> Option.bind (tryProperty "moduleSpecifierPrefixes"))
                      DynamicTypes = perLanguage (engine |> Option.bind (tryProperty "dynamicTypes"))
                      EscapeHatches = escapeHatches }
            | _ -> Error "languages, neverWalked and everywhere.escapeHatches are required"
        | Some other -> Error(sprintf "unsupported rule-set schemaVersion %d" other)
        | None -> Error "missing or non-numeric schemaVersion"

let private embeddedBytes =
    lazy
        (use stream =
            Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream resourceName

         if isNull stream then
             failwith "the boundary rule set is not embedded in this build"

         use memory = new IO.MemoryStream()
         stream.CopyTo memory
         memory.ToArray())

/// SHA-256 of the embedded rule set, as lowercase hex. `verify --json` reports
/// it so a result names exactly the rules it ran.
let ruleSetSha256 () =
    Security.Cryptography.SHA256.HashData(embeddedBytes.Force())
    |> Array.map (fun b -> b.ToString("x2"))
    |> String.concat ""

let private embedded =
    lazy
        (match parseRules (Text.Encoding.UTF8.GetString(embeddedBytes.Force())) with
         | Ok rules -> rules
         | Error detail -> failwithf "the embedded boundary rule set is invalid: %s" detail)

/// The rule set this CLI was built with.
let rules () = embedded.Force()

let languageOf (rules: Rules) (path: string) =
    rules.Extensions |> Map.tryFind (IO.Path.GetExtension(path).ToLowerInvariant())

let isSourceFile (path: string) = (languageOf (rules ()) path).IsSome

/// Directory names never walked when reading a configured boundary path.
let neverWalked () = (rules ()).NeverWalked

// ------------------------------------------------------ lexical normalization --

let private blank (character: char) = if character = '\n' then '\n' else ' '

/// Remove comments, and string literals unless `keepStrings`, preserving length
/// and line structure so positions still line up with the original file.
///
/// Mirrors `stripCode` in tools/guardrails/boundary.ts; the shared fixtures
/// hold the two together. Template-literal substitutions stay code. A single
/// quote is a string only in TypeScript: elsewhere it is a character literal
/// ('x', '\n') or code (an F# type parameter, a Rust lifetime).
let stripCode (language: Language) (source: string) (keepStrings: bool) =
    let length = source.Length
    let output = Text.StringBuilder(length)

    let at index =
        if index < length then source.[index] else '\000'

    let copy from upTo asCode =
        for index in from .. (min upTo length) - 1 do
            output.Append(if asCode then source.[index] else blank source.[index]) |> ignore

    let indexOf (text: string) from =
        if from >= length then -1 else source.IndexOf(text, from, StringComparison.Ordinal)

    let rec stringEnd quote cursor =
        if cursor >= length || source.[cursor] = quote then cursor
        elif source.[cursor] = '\\' then stringEnd quote (cursor + 2)
        else stringEnd quote (cursor + 1)

    // `braces` is a stack of brace depths, one per open template substitution.
    let rec scan index inTemplate (braces: int list) =
        if index < length then
            let current = source.[index]

            if inTemplate then
                if current = '\\' then
                    copy index (index + 2) keepStrings
                    scan (index + 2) true braces
                elif current = '`' then
                    copy index (index + 1) keepStrings
                    scan (index + 1) false braces
                elif current = '$' && at (index + 1) = '{' then
                    copy index (index + 2) true
                    scan (index + 2) false (0 :: braces)
                else
                    copy index (index + 1) keepStrings
                    scan (index + 1) true braces
            elif current = '/' && at (index + 1) = '/' then
                let stop = match indexOf "\n" index with -1 -> length | e -> e
                copy index stop false
                scan stop false braces
            elif current = '/' && at (index + 1) = '*' then
                let stop = match indexOf "*/" (index + 2) with -1 -> length | e -> e + 2
                copy index stop false
                scan stop false braces
            elif language = FSharp && current = '(' && at (index + 1) = '*' && at (index + 2) <> ')' then
                let stop = match indexOf "*)" (index + 2) with -1 -> length | e -> e + 2
                copy index stop false
                scan stop false braces
            elif current = '"' && (language = FSharp || language = CSharp) && at (index + 1) = '"' && at (index + 2) = '"' then
                let stop = match indexOf "\"\"\"" (index + 3) with -1 -> length | e -> e + 3
                copy index stop keepStrings
                scan stop false braces
            elif current = '"' || (current = '\'' && language = TypeScript) then
                let stop = min (stringEnd current (index + 1) + 1) length
                copy index stop keepStrings
                scan stop false braces
            elif current = '\'' then
                let close =
                    if at (index + 1) = '\\' then indexOf "'" (index + 2)
                    elif at (index + 2) = '\'' then index + 2
                    else -1

                if close > index && close - index <= 10 then
                    copy index (close + 1) keepStrings
                    scan (close + 1) false braces
                else
                    copy index (index + 1) true
                    scan (index + 1) false braces
            elif current = '`' && language = TypeScript then
                copy index (index + 1) keepStrings
                scan (index + 1) true braces
            else
                copy index (index + 1) true

                match braces, current with
                | depth :: rest, '{' -> scan (index + 1) false ((depth + 1) :: rest)
                | 0 :: rest, '}' -> scan (index + 1) true rest
                | depth :: rest, '}' -> scan (index + 1) false ((depth - 1) :: rest)
                | _ -> scan (index + 1) false braces

    scan 0 false []
    output.ToString()

// ------------------------------------------------------------- token matching --

let private isWordCharacter (character: char) =
    Char.IsLetter character || Char.IsDigit character || character = '_' || character = '$'

let private isSpace (character: char) =
    character = ' ' || character = '\t' || character = '\n' || character = '\r'

/// Whole-word containment, so `windowWidth` does not read as `window`. A token
/// ending in `(` is a call: the word, optional whitespace, then `(`.
let containsToken (token: string) (code: string) =
    let call = token.EndsWith "("
    let word = if call then token.Substring(0, token.Length - 1) else token
    let wordEndsInWordCharacter = isWordCharacter word.[word.Length - 1]

    let leftOk index = index = 0 || not (isWordCharacter code.[index - 1])

    let rightOk index =
        if call then
            let rec skip cursor =
                if cursor < code.Length && isSpace code.[cursor] then skip (cursor + 1) else cursor

            let cursor = skip index
            cursor < code.Length && code.[cursor] = '('
        else
            index >= code.Length || not wordEndsInWordCharacter || not (isWordCharacter code.[index])

    let rec search from =
        match (if from > code.Length then -1 else code.IndexOf(word, from, StringComparison.Ordinal)) with
        | -1 -> false
        | index -> (leftOk index && rightOk (index + word.Length)) || search (index + 1)

    search 0

let private specifier =
    Regex("\\b(?:from|import)\\s*\\(?\\s*([\"'`])([^\"'`\\r\\n]*)\\1", RegexOptions.CultureInvariant)

/// The specifier text of static and dynamic imports, from code whose strings
/// were kept.
let moduleSpecifiers (codeWithStrings: string) =
    specifier.Matches codeWithStrings |> Seq.map (fun m -> m.Groups.[2].Value) |> List.ofSeq

// ------------------------------------------------------------------ the check --

/// Every (rule, token) a file breaks, in rule-set order.
let findings (rules: Rules) (isEngineSide: bool) (path: string) (content: string) =
    match languageOf rules path with
    | None -> []
    | Some language ->
        let code = stripCode language content false
        let tokensFor table = table |> Map.tryFind language |> Option.defaultValue []

        let found rule tokens =
            tokens |> List.filter (fun token -> containsToken token code) |> List.map (fun token -> rule, token)

        let prefixes = tokensFor rules.ModuleSpecifierPrefixes

        let modules =
            if isEngineSide && not (List.isEmpty prefixes) then
                let specifiers = moduleSpecifiers (stripCode language content true)

                prefixes
                |> List.filter (fun prefix -> specifiers |> List.exists (fun s -> s.StartsWith(prefix, StringComparison.Ordinal)))
                |> List.map (fun prefix -> EngineModule, prefix)
            else
                []

        [ if isEngineSide then yield! found EngineAuthority (tokensFor rules.Authority)
          yield! modules
          if isEngineSide then yield! found EngineDynamicType (tokensFor rules.DynamicTypes)
          yield! found EscapeHatch rules.EscapeHatches ]

/// The sentence for a finding — the same one the repository guardrail prints.
let describe (rule: Rule) (token: string) =
    match rule with
    | EngineAuthority -> sprintf "engine code references the browser or host capability '%s'" token
    | EngineModule -> sprintf "engine code imports a host module ('%s…')" token
    | EngineDynamicType -> sprintf "engine code uses the dynamic type escape '%s'" token
    | EscapeHatch -> sprintf "code uses the escape hatch '%s'" token

/// Check one file against the rules for the side of the boundary it is on.
let checkFile (isEngineSide: bool) (path: string) (content: string) =
    findings (rules ()) isEngineSide path content
    |> List.map (fun (rule, token) -> BoundaryViolation(path, describe rule token))

/// Check every file in a snapshot of the configured boundary directories.
///
/// `engineFiles` and `kernelFiles` are already-read (path, content) pairs: this
/// function performs no IO, so the rules can be tested without a filesystem.
let check (engineFiles: (string * string) list) (kernelFiles: (string * string) list) =
    let engineProblems =
        engineFiles |> List.collect (fun (path, content) -> checkFile true path content)

    let kernelProblems =
        kernelFiles |> List.collect (fun (path, content) -> checkFile false path content)

    engineProblems @ kernelProblems
