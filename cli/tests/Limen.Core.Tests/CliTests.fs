module Limen.Core.Tests.CliTests

open Xunit
open Limen.Core
open Limen.Core.Types
open Limen.Cli

// ------------------------------------------------------------------ parsing --

[<Fact>]
let ``no arguments shows help rather than doing something`` () =
    match Args.parse [] with
    | Ok (Args.Help None) -> ()
    | other -> failwithf "expected general help, got %A" other

[<Theory>]
[<InlineData("init")>]
[<InlineData("status")>]
[<InlineData("verify")>]
[<InlineData("upgrade")>]
[<InlineData("doctor")>]
let ``every documented command parses`` (name: string) =
    match Args.parse [ name ] with
    | Ok _ -> ()
    | Error error -> failwithf "expected %s to parse, got %s" name (Args.describeError error)

[<Theory>]
[<InlineData("init")>]
[<InlineData("status")>]
[<InlineData("verify")>]
[<InlineData("upgrade")>]
[<InlineData("doctor")>]
let ``every command has its own help page`` (name: string) =
    // Help is public documentation; a command without it is an undocumented
    // part of the public interface.
    match Args.parse [ name; "--help" ] with
    | Ok (Args.Help (Some topic)) ->
        Assert.Equal(name, topic)
        Assert.NotEqual<string>(Help.general, Help.forTopic (Some topic))
    | other -> failwithf "expected help for %s, got %A" name other

[<Fact>]
let ``help for every command names the command`` () =
    for topic in Help.topics do
        Assert.Contains("limen " + topic, Help.forTopic (Some topic))

[<Fact>]
let ``an unknown command is an error, not a default`` () =
    match Args.parse [ "frobnicate" ] with
    | Error (Args.UnknownCommand name) -> Assert.Equal("frobnicate", name)
    | other -> failwithf "expected UnknownCommand, got %A" other

[<Fact>]
let ``an unknown flag is rejected rather than ignored`` () =
    // A silently ignored --dry-run would be the most expensive possible bug.
    match Args.parse [ "init"; "--drynru" ] with
    | Error (Args.UnknownFlag (command, flag)) ->
        Assert.Equal("init", command)
        Assert.Equal("--drynru", flag)
    | other -> failwithf "expected UnknownFlag, got %A" other

[<Fact>]
let ``a flag that belongs to another command is rejected`` () =
    match Args.parse [ "status"; "--strict" ] with
    | Error (Args.UnknownFlag _) -> ()
    | other -> failwithf "expected UnknownFlag, got %A" other

[<Fact>]
let ``root requires a value`` () =
    match Args.parse [ "status"; "--root" ] with
    | Error (Args.MissingValue flag) -> Assert.Equal("--root", flag)
    | other -> failwithf "expected MissingValue, got %A" other

[<Fact>]
let ``global flags are accepted before and after the command`` () =
    match Args.parse [ "--json"; "verify"; "--strict" ] with
    | Ok (Args.Verify options) ->
        Assert.True options.Global.Json
        Assert.True options.Strict
    | other -> failwithf "unexpected %A" other

[<Fact>]
let ``check implies dry run so it can never write`` () =
    match Args.parse [ "init"; "--check" ] with
    | Ok (Args.Init options) ->
        Assert.True options.Check
        Assert.True(options.DryRun, "--check must imply --dry-run")
    | other -> failwithf "unexpected %A" other

[<Fact>]
let ``version is recognised in both spellings`` () =
    Assert.Equal(Ok Args.Version, Args.parse [ "--version" ])
    Assert.Equal(Ok Args.Version, Args.parse [ "version" ])

[<Fact>]
let ``help wins over the command it is attached to`` () =
    // `limen init --help` must document init, not initialize anything.
    match Args.parse [ "init"; "--help" ] with
    | Ok (Args.Help _) -> ()
    | other -> failwithf "expected help, got %A" other

// ----------------------------------------------------------------- output --

let private parseJson (text: string) =
    let document = System.Text.Json.JsonDocument.Parse text
    document.RootElement

[<Fact>]
let ``status JSON is valid and carries a schema version`` () =
    let report =
        { Tool = Paths.toolName
          Package = Paths.packageName
          CliVersion = "1.0.0"
          State = NotInstalled
          ConfigurationVersion = None
          ManagedArtifactCount = 0
          Verification = Some { Ok = false; Strict = false; Problems = [ ManifestMissing ] } }

    let root = parseJson (Json.render (Render.statusToJson report))

    Assert.Equal(Render.outputSchemaVersion, root.GetProperty("schemaVersion").GetInt32())
    Assert.Equal("not-installed", root.GetProperty("state").GetString())
    Assert.Equal(System.Text.Json.JsonValueKind.Null, root.GetProperty("installedVersion").ValueKind)

[<Fact>]
let ``verify JSON lists every problem with a code and a remedy`` () =
    let verification =
        { Ok = false
          Strict = true
          Problems = [ BoundaryViolation("src/engine/a.ts", "reaches the DOM"); ManifestMissing ] }

    let root = parseJson (Json.render (Render.verifyToJson verification))
    let problems = root.GetProperty("problems")

    Assert.Equal(2, problems.GetArrayLength())

    for problem in problems.EnumerateArray() do
        Assert.StartsWith("LIMEN", problem.GetProperty("code").GetString())
        Assert.NotEqual(System.Text.Json.JsonValueKind.Undefined, problem.GetProperty("severity").ValueKind)

[<Fact>]
let ``a boundary problem reports the file it is about`` () =
    let verification =
        { Ok = false
          Strict = false
          Problems = [ BoundaryViolation("src/engine/a.ts", "reaches the DOM") ] }

    let root = parseJson (Json.render (Render.verifyToJson verification))
    let first = root.GetProperty("problems").EnumerateArray() |> Seq.head

    Assert.Equal("src/engine/a.ts", first.GetProperty("path").GetString())

[<Fact>]
let ``every problem case can be explained`` () =
    // A problem with no explanation would reach a user as a bare enum name.
    let every =
        [ ManifestMissing
          ManifestUnreadable "x"
          ManifestSchemaUnsupported(2, 1)
          ConfigurationMissing "c"
          ConfigurationUnreadable("c", "x")
          ConfigurationVersionUnsupported(2, 1)
          ManagedArtifactMissing "a"
          ManagedArtifactModified "a"
          BoundaryViolation("a", "r")
          ConfiguredPathMissing "a"
          InstalledVersionOutdated("1.0.0", "2.0.0") ]

    for problem in every do
        let finding = Diagnose.explain problem
        Assert.False(System.String.IsNullOrWhiteSpace finding.Title)
        Assert.False(System.String.IsNullOrWhiteSpace finding.Detail)
        Assert.StartsWith("LIMEN", finding.Code)

[<Fact>]
let ``problem codes are unique`` () =
    let codes =
        [ ManifestMissing
          ManifestUnreadable "x"
          ManifestSchemaUnsupported(2, 1)
          ConfigurationMissing "c"
          ConfigurationUnreadable("c", "x")
          ConfigurationVersionUnsupported(2, 1)
          ManagedArtifactMissing "a"
          ManagedArtifactModified "a"
          BoundaryViolation("a", "r")
          ConfiguredPathMissing "a"
          InstalledVersionOutdated("1.0.0", "2.0.0") ]
        |> List.map (fun problem -> (Diagnose.explain problem).Code)

    Assert.Equal(List.length codes, codes |> List.distinct |> List.length)

[<Fact>]
let ``JSON escaping survives control characters and quotes`` () =
    let awkward = "a\"b\\c\nd\tef"
    let rendered = Json.render (Json.JObject [ "value", Json.JString awkward ])
    let root = parseJson rendered

    Assert.Equal(awkward, root.GetProperty("value").GetString())

[<Fact>]
let ``verbose actually changes what verify prints`` () =
    // A documented flag that does nothing is a lie in the public interface.
    let verification =
        { Ok = false
          Strict = false
          Problems = [ BoundaryViolation("src/engine/a.ts", "reaches the DOM") ] }

    let plain = Render.verifyToText verification false
    let verbose = Render.verifyToText verification true

    Assert.NotEqual<string>(plain, verbose)
    Assert.Contains("fix:", verbose)
    Assert.DoesNotContain("fix:", plain)

[<Fact>]
let ``the help text documents every exit code the CLI can return`` () =
    for code in [ 0; 1; 2; 3; 4; 5; 6; 7 ] do
        Assert.Contains(string code, Help.general)
