/// The message boundary: JSON in, JSON out.
///
/// These are the tests docs/17-wasm-migration.md said did not exist — "nothing
/// currently proves the protocol survives a round trip through a codec". They
/// do now, on the F# side; test/wasm.test.ts proves the other half by driving
/// the real BrowserKernel against the real module.
module Limen.Engine.Tests.EngineTests

open Xunit
open Limen.Engine.Json
open Limen.Engine.Engine

/// Each test gets a fresh engine: the module holds one mutable cell.
let private fresh () = reset ()

let private send raw =
    let reply = handle raw
    parse reply

let private view reply = field "view" reply |> Option.defaultValue JNull
let private key name reply = view reply |> field name

[<Fact>]
let ``Initialize produces a complete projection and requests nothing`` () =
    fresh ()
    let reply = send """{"kind":"Initialize","protocolVersion":1,"capabilities":["Http","Storage","Clipboard"]}"""
    Assert.Equal(Some(JNumber 0.0), key "counter" reply)
    Assert.Equal(Some(JBool true), key "resetDisabled" reply)
    Assert.Equal(Some(JArray []), field "effects" reply)

[<Fact>]
let ``an event transitions state and the next projection reflects it`` () =
    fresh ()
    send """{"kind":"Initialize","protocolVersion":1,"capabilities":[]}""" |> ignore
    let reply = send """{"kind":"Event","event":{"kind":"Event","name":"increment"}}"""
    Assert.Equal(Some(JNumber 1.0), key "counter" reply)
    Assert.Equal(Some(JBool false), key "resetDisabled" reply)

[<Fact>]
let ``every response carries a complete view, never a patch`` () =
    fresh ()
    let reply = send """{"kind":"Event","event":{"kind":"Event","name":"increment"}}"""
    // A handful of keys from every demo on the page must be present in every
    // single response, or a data-text binding somewhere throws.
    for name in [ "counter"; "saveState"; "loadState"; "flagVerdict"; "taskPrompt"; "copyLabel"; "installCommand" ] do
        Assert.True((key name reply).IsSome, sprintf "the projection omitted '%s'" name)

[<Fact>]
let ``an event that requests an effect emits it in the wire shape the kernel expects`` () =
    fresh ()
    let reply = send """{"kind":"Event","event":{"kind":"Event","name":"loadSuccess"}}"""
    match field "effects" reply with
    | Some(JArray [ effect ]) ->
        Assert.Equal(Some(JString "Http"), field "kind" effect)
        Assert.Equal(Some(JString "GET"), field "method" effect)
        Assert.Equal(Some(JString "./demo/customers.json"), field "url" effect)
        Assert.True((field "correlationId" effect).IsSome)
        Assert.True((field "timeoutMs" effect).IsSome)
    | other -> failwithf "expected exactly one Http effect, got %A" other

[<Fact>]
let ``an effect result is decoded and folded back into state`` () =
    fresh ()
    let started = send """{"kind":"Event","event":{"kind":"Event","name":"loadSuccess"}}"""
    let correlationId =
        match field "effects" started with
        | Some(JArray [ effect ]) -> (asString (field "correlationId" effect)).Value
        | other -> failwithf "expected an effect, got %A" other

    let reply =
        send (sprintf
                """{"kind":"EffectResult","result":{"kind":"HttpResult","correlationId":"%s","outcome":{"kind":"Success","status":200,"body":[1,2,3]}}}"""
                correlationId)
    Assert.Equal(Some(JString "Loaded"), key "loadState" reply)
    Assert.Equal(Some(JString "Loaded 3 record(s)."), key "loadMessage" reply)

[<Fact>]
let ``a clipboard failure becomes a projected message`` () =
    fresh ()
    send """{"kind":"Event","event":{"kind":"Event","name":"copyInstall"}}""" |> ignore
    let reply =
        send """{"kind":"EffectResult","result":{"kind":"ClipboardResult","correlationId":"wasm-1","outcome":{"kind":"Failure","reason":"permission-denied"}}}"""
    Assert.Equal(Some(JBool true), key "copyFailed" reply)
    match key "copyError" reply with
    | Some(JString message) -> Assert.Contains("manually", message)
    | other -> failwithf "expected a message, got %A" other

[<Fact>]
let ``a malformed message raises rather than returning a stale view`` () =
    fresh ()
    // The kernel turns a rejected dispatch into BridgeError { phase:
    // "dispatch" } and leaves the DOM untouched. Returning the previous view
    // here would look like success and quietly freeze the page.
    Assert.ThrowsAny<exn>(fun () -> handle "{ not json" |> ignore) |> ignore
    Assert.ThrowsAny<exn>(fun () -> handle """{"kind":"Nonsense"}""" |> ignore) |> ignore

[<Fact>]
let ``an unrecognized event name is refused, not quietly ignored`` () =
    fresh ()
    // The wire shape was valid here — unlike a malformed message — so this is
    // a different failure, but not a lesser one. A `data-event` the engine has
    // no command for is a typo in the markup, and the only way anyone finds
    // a typo is if something says so. Ignoring it produces a page whose
    // buttons do nothing, with no error anywhere to explain why.
    let error =
        Assert.ThrowsAny<exn>(fun () ->
            handle """{"kind":"Event","event":{"kind":"Event","name":"notAnEvent"}}""" |> ignore)
    Assert.Contains("notAnEvent", error.Message)

[<Fact>]
let ``a refused event leaves the engine exactly as it was`` () =
    fresh ()
    send """{"kind":"Event","event":{"kind":"Event","name":"increment"}}""" |> ignore
    Assert.ThrowsAny<exn>(fun () ->
        handle """{"kind":"Event","event":{"kind":"Event","name":"notAnEvent"}}""" |> ignore)
    |> ignore
    // Refusal is total: nothing half-applied, no trace entry written for a
    // command that never existed. The next real event continues from where
    // the last one left off.
    let reply = send """{"kind":"Event","event":{"kind":"Event","name":"increment"}}"""
    Assert.Equal(Some(JNumber 2.0), key "counter" reply)

[<Fact>]
let ``a list projection crosses as an array of flat objects`` () =
    fresh ()
    let reply = send """{"kind":"Event","event":{"kind":"Event","name":"increment"}}"""
    match key "trace" reply with
    | Some(JArray (JObject fields :: _)) ->
        // data-each requires flat items with a stable key field.
        Assert.True(fields |> List.exists (fst >> (=) "id"))
        Assert.True(fields |> List.forall (fun (_, v) -> match v with JObject _ | JArray _ -> false | _ -> true))
    | other -> failwithf "expected a non-empty trace array, got %A" other
