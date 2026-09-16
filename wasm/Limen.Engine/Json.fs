/// A small, hand-written JSON reader and writer.
///
/// Hand-written on purpose. SDE's `architecture/BOUNDARY-PRESERVATION.md`
/// requires that "every boundary-crossing value gets an explicit, hand-written
/// tagged-JSON rendering function, never a host language's or framework's
/// default serializer", and the Wire Contract Rule says a wire representation
/// "must not depend on incidental host-language or framework serialization
/// behavior". `System.Text.Json` would serialize an F# discriminated union
/// however its own conventions happen to fall, which is exactly the dependency
/// that rule forbids.
///
/// It is also the smaller choice: this is the entire codec, and it has no
/// reflection, no attributes, and nothing to configure.
module Limen.Engine.Json

open System
open System.Text
open System.Globalization

type Value =
    | JNull
    | JBool of bool
    | JNumber of float
    | JString of string
    | JArray of Value list
    | JObject of (string * Value) list

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

let private escape (sb: StringBuilder) (s: string) =
    sb.Append '"' |> ignore
    for ch in s do
        match ch with
        | '"' -> sb.Append "\\\"" |> ignore
        | '\\' -> sb.Append "\\\\" |> ignore
        | '\n' -> sb.Append "\\n" |> ignore
        | '\r' -> sb.Append "\\r" |> ignore
        | '\t' -> sb.Append "\\t" |> ignore
        | c when c < ' ' -> sb.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", int c) |> ignore
        | c -> sb.Append c |> ignore
    sb.Append '"' |> ignore

let rec private write (sb: StringBuilder) (value: Value) =
    match value with
    | JNull -> sb.Append "null" |> ignore
    | JBool true -> sb.Append "true" |> ignore
    | JBool false -> sb.Append "false" |> ignore
    | JNumber n ->
        // Round-trip formatting, invariant culture: a decimal comma here would
        // produce JSON the browser cannot parse.
        if Double.IsFinite n && n = Math.Floor n && abs n < 1e15 then
            sb.Append((int64 n).ToString(CultureInfo.InvariantCulture)) |> ignore
        else
            sb.Append(n.ToString("R", CultureInfo.InvariantCulture)) |> ignore
    | JString s -> escape sb s
    | JArray items ->
        sb.Append '[' |> ignore
        items |> List.iteri (fun i item ->
            if i > 0 then sb.Append ',' |> ignore
            write sb item)
        sb.Append ']' |> ignore
    | JObject fields ->
        sb.Append '{' |> ignore
        fields |> List.iteri (fun i (key, item) ->
            if i > 0 then sb.Append ',' |> ignore
            escape sb key
            sb.Append ':' |> ignore
            write sb item)
        sb.Append '}' |> ignore

let stringify (value: Value) : string =
    let sb = StringBuilder()
    write sb value
    sb.ToString()

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

exception JsonError of string

/// Parses JSON into `Value`. Deliberately strict: anything it does not
/// understand raises, and the caller turns that into a failed dispatch rather
/// than guessing at a repair.
let parse (input: string) : Value =
    let mutable i = 0
    let len = input.Length

    let fail message = raise (JsonError(sprintf "%s at offset %d" message i))
    let peek () = if i < len then input.[i] else '\000'

    let rec skipWhitespace () =
        while i < len && (input.[i] = ' ' || input.[i] = '\t' || input.[i] = '\n' || input.[i] = '\r') do
            i <- i + 1

    and expect (c: char) =
        skipWhitespace ()
        if peek () <> c then fail (sprintf "expected '%c'" c)
        i <- i + 1

    and readLiteral (literal: string) (value: Value) =
        if i + literal.Length > len || input.Substring(i, literal.Length) <> literal then fail "invalid literal"
        i <- i + literal.Length
        value

    and readString () : string =
        expect '"'
        let sb = StringBuilder()
        let mutable finished = false
        while not finished do
            if i >= len then fail "unterminated string"
            match input.[i] with
            | '"' -> i <- i + 1; finished <- true
            | '\\' ->
                i <- i + 1
                if i >= len then fail "unterminated escape"
                let c = input.[i]
                i <- i + 1
                match c with
                | '"' -> sb.Append '"' |> ignore
                | '\\' -> sb.Append '\\' |> ignore
                | '/' -> sb.Append '/' |> ignore
                | 'b' -> sb.Append '\b' |> ignore
                | 'f' -> sb.Append '\f' |> ignore
                | 'n' -> sb.Append '\n' |> ignore
                | 'r' -> sb.Append '\r' |> ignore
                | 't' -> sb.Append '\t' |> ignore
                | 'u' ->
                    if i + 4 > len then fail "truncated \\u escape"
                    let code = Convert.ToInt32(input.Substring(i, 4), 16)
                    i <- i + 4
                    sb.Append(char code) |> ignore
                | _ -> fail "unknown escape"
            | c -> sb.Append c |> ignore; i <- i + 1
        sb.ToString()

    and readNumber () : Value =
        let start = i
        if peek () = '-' then i <- i + 1
        while i < len && Char.IsDigit input.[i] do i <- i + 1
        if peek () = '.' then
            i <- i + 1
            while i < len && Char.IsDigit input.[i] do i <- i + 1
        if peek () = 'e' || peek () = 'E' then
            i <- i + 1
            if peek () = '+' || peek () = '-' then i <- i + 1
            while i < len && Char.IsDigit input.[i] do i <- i + 1
        if i = start then fail "expected a number"
        JNumber(Double.Parse(input.Substring(start, i - start), CultureInfo.InvariantCulture))

    and readValue () : Value =
        skipWhitespace ()
        match peek () with
        | '{' ->
            i <- i + 1
            skipWhitespace ()
            if peek () = '}' then (i <- i + 1; JObject [])
            else
                let fields = ResizeArray()
                let mutable more = true
                while more do
                    skipWhitespace ()
                    let key = readString ()
                    expect ':'
                    fields.Add(key, readValue ())
                    skipWhitespace ()
                    if peek () = ',' then i <- i + 1 else more <- false
                expect '}'
                JObject(List.ofSeq fields)
        | '[' ->
            i <- i + 1
            skipWhitespace ()
            if peek () = ']' then (i <- i + 1; JArray [])
            else
                let items = ResizeArray()
                let mutable more = true
                while more do
                    items.Add(readValue ())
                    skipWhitespace ()
                    if peek () = ',' then i <- i + 1 else more <- false
                expect ']'
                JArray(List.ofSeq items)
        | '"' -> JString(readString ())
        | 't' -> readLiteral "true" (JBool true)
        | 'f' -> readLiteral "false" (JBool false)
        | 'n' -> readLiteral "null" JNull
        | _ -> readNumber ()

    let result = readValue ()
    skipWhitespace ()
    if i <> len then fail "trailing content"
    result

// ---------------------------------------------------------------------------
// Lookups — total, so a malformed message is a modelled absence, not a crash
// ---------------------------------------------------------------------------

let field (name: string) (value: Value) : Value option =
    match value with
    | JObject fields -> fields |> List.tryPick (fun (k, v) -> if k = name then Some v else None)
    | _ -> None

let asString (value: Value option) : string option =
    match value with
    | Some(JString s) -> Some s
    | _ -> None

let asInt (value: Value option) : int option =
    match value with
    | Some(JNumber n) -> Some(int n)
    | _ -> None
