/// The codec is hand-written, so it is tested rather than trusted.
module Limen.Engine.Tests.JsonTests

open Xunit
open Limen.Engine.Json

[<Fact>]
let ``a value survives a round trip through the codec`` () =
    let original =
        JObject
            [ "view", JObject [ "counter", JNumber 3.0; "label", JString "Copy"; "busy", JBool false ]
              "effects", JArray [ JObject [ "kind", JString "Http" ] ]
              "cancellations", JArray [] ]
    Assert.Equal(original, parse (stringify original))

[<Theory>]
[<InlineData("\"plain\"")>]
[<InlineData("\"with \\\"quotes\\\"\"")>]
[<InlineData("\"with \\\\ backslash\"")>]
[<InlineData("\"with \\n newline\"")>]
[<InlineData("\"café — em dash\"")>]
let ``strings round-trip, including the ones that break naive escaping`` (json: string) =
    Assert.Equal(json |> parse |> stringify, json |> parse |> stringify)
    Assert.Equal<Value>(parse json, parse (stringify (parse json)))

[<Fact>]
let ``an integer is written without a decimal point`` () =
    // JavaScript would accept 3.0, but the TypeScript side declares these as
    // numbers used for counts and indexes; keeping them integral avoids a
    // surprising "3.0" appearing in the DOM via data-text.
    Assert.Equal("3", stringify (JNumber 3.0))

[<Fact>]
let ``a malformed document raises rather than guessing at a repair`` () =
    Assert.Throws<JsonError>(fun () -> parse "{\"a\":" |> ignore) |> ignore
    Assert.Throws<JsonError>(fun () -> parse "{} trailing" |> ignore) |> ignore

[<Fact>]
let ``field lookups are total`` () =
    let value = JObject [ "present", JString "yes" ]
    Assert.Equal(Some(JString "yes"), field "present" value)
    Assert.Equal(None, field "absent" value)
    // Looking a field up on a non-object is an absence, not a crash: the
    // engine decides what a missing field means.
    Assert.Equal(None, field "any" (JNumber 1.0))
