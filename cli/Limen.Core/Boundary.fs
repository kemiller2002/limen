/// The boundary check: does application code stay out of the browser?
///
/// This is the one invariant Limen exists to protect, and the only one a
/// machine can check cheaply. It is a lexical check, not a type-aware one — it
/// cannot prove the absence of browser access, only catch the ways it is
/// actually written. That limit is stated in the documentation rather than
/// implied away.
///
/// It differs deliberately from the repository's own legacy
/// `scripts/check-architecture.ts` in one respect: comments and string
/// literals are removed before matching. The legacy checker matches raw text,
/// so a comment reading "never touches document" fails it. A comment cannot
/// reach the DOM, and a tool that flags prose trains its users to ignore it.
module Limen.Core.Boundary

open System
open Limen.Core.Types

/// Browser capabilities the engine side must not name.
let forbiddenBrowserTokens =
    [ "document"; "window"; "fetch("; "localStorage"; "sessionStorage"; "JsValue"; "IJSRuntime" ]

/// Ways to defeat the type system, which is how meaning leaks across the
/// boundary without anyone noticing.
let dynamicTypeTokens = [ "any"; "dynamic" ]

/// Ways to hand the browser something to execute. Banned on both sides.
let escapeHatchTokens = [ "SetInnerHtml"; "ExecuteScript"; "eval" ]

let private sourceExtensions =
    set [ ".ts"; ".tsx"; ".mts"; ".cts"; ".js"; ".jsx"; ".mjs"; ".cjs"; ".fs"; ".fsx"; ".cs" ]

let isSourceFile (path: string) =
    sourceExtensions.Contains(IO.Path.GetExtension(path).ToLowerInvariant())

/// Replace comments and string literals with spaces, preserving length and line
/// structure so that reported positions still line up with the original file.
///
/// Spaces rather than deletion matters: deleting `"a" + "b"` would join tokens
/// that were never adjacent and could manufacture a match.
let stripCommentsAndStrings (source: string) =
    let output = Text.StringBuilder(source.Length)
    let mutable index = 0
    let length = source.Length

    let peek offset =
        if index + offset < length then source.[index + offset] else '\000'

    while index < length do
        let current = source.[index]

        if current = '/' && peek 1 = '/' then
            while index < length && source.[index] <> '\n' do
                output.Append ' ' |> ignore
                index <- index + 1
        elif current = '/' && peek 1 = '*' then
            let mutable finished = false

            while index < length && not finished do
                if source.[index] = '*' && peek 1 = '/' then
                    output.Append "  " |> ignore
                    index <- index + 2
                    finished <- true
                else
                    output.Append(if source.[index] = '\n' then '\n' else ' ') |> ignore
                    index <- index + 1
        elif current = '"' || current = '\'' || current = '`' then
            let quote = current
            output.Append ' ' |> ignore
            index <- index + 1
            let mutable closed = false

            while index < length && not closed do
                let character = source.[index]

                if character = '\\' then
                    // Skip the escape and whatever it escapes, so a trailing
                    // backslash cannot swallow the closing quote.
                    output.Append "  " |> ignore
                    index <- index + 2
                elif character = quote then
                    output.Append ' ' |> ignore
                    index <- index + 1
                    closed <- true
                else
                    output.Append(if character = '\n' then '\n' else ' ') |> ignore
                    index <- index + 1
        else
            output.Append current |> ignore
            index <- index + 1

    output.ToString()

let private isWordCharacter character =
    Char.IsLetterOrDigit character || character = '_' || character = '$'

/// Whole-word containment, so `windowWidth` does not read as `window` and a
/// property called `documentation` does not read as `document`.
let containsWord (token: string) (text: string) =
    let mutable index = text.IndexOf(token, StringComparison.Ordinal)
    let mutable found = false

    while index >= 0 && not found do
        let beforeOk = index = 0 || not (isWordCharacter text.[index - 1])
        let afterIndex = index + token.Length

        let afterOk =
            afterIndex >= text.Length
            || not (isWordCharacter text.[afterIndex])
            // A token that already ends in punctuation, such as `fetch(`,
            // carries its own right-hand boundary.
            || not (isWordCharacter token.[token.Length - 1])

        if beforeOk && afterOk then
            found <- true
        else
            index <- text.IndexOf(token, index + 1, StringComparison.Ordinal)

    found

/// Check one file against the rules for the side of the boundary it is on.
let checkFile (isEngineSide: bool) (path: string) (content: string) =
    if not (isSourceFile path) then
        []
    else
        let code = stripCommentsAndStrings content

        let browser =
            if isEngineSide then
                forbiddenBrowserTokens
                |> List.filter (fun token -> containsWord token code)
                |> List.map (fun token -> BoundaryViolation(path, sprintf "engine code references the browser capability '%s'" token))
            else
                []

        let dynamicTypes =
            if isEngineSide then
                dynamicTypeTokens
                |> List.filter (fun token -> containsWord token code)
                |> List.map (fun token -> BoundaryViolation(path, sprintf "engine code uses the dynamic type escape '%s'" token))
            else
                []

        let escapes =
            escapeHatchTokens
            |> List.filter (fun token -> containsWord token code)
            |> List.map (fun token -> BoundaryViolation(path, sprintf "code uses the escape hatch '%s'" token))

        browser @ dynamicTypes @ escapes

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
