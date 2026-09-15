module Limen.Core.Tests.ManifestTests

open Xunit
open Limen.Core
open Limen.Core.Types

let private sample =
    { SchemaVersion = Paths.supportedSchemaVersion
      Tool = Paths.toolName
      Package = Paths.packageName
      InstalledVersion = "1.2.3"
      ConfigurationVersion = 1
      ManagedArtifacts =
        [ { Path = "b.txt"
            Ownership = ToolOwned
            Disposition = InstalledByTool
            Sha256 = "bb" }
          { Path = "a.txt"
            Ownership = UserOwned
            Disposition = PreservedExisting
            Sha256 = "aa" } ] }

[<Fact>]
let ``a manifest survives a round trip`` () =
    match Manifest.parse (Manifest.serialize sample) with
    | Ok parsed ->
        Assert.Equal(sample.InstalledVersion, parsed.InstalledVersion)
        Assert.Equal(sample.Tool, parsed.Tool)
        Assert.Equal(2, List.length parsed.ManagedArtifacts)
    | Error problem -> failwithf "expected a parseable manifest, got %A" problem

[<Fact>]
let ``artifacts are serialized in a stable order`` () =
    // Two manifests describing the same installation must produce identical
    // bytes, or `init` would report a change on every run.
    let reversed =
        { sample with ManagedArtifacts = List.rev sample.ManagedArtifacts }

    Assert.Equal(Manifest.serialize sample, Manifest.serialize reversed)

[<Fact>]
let ``ownership and disposition survive a round trip`` () =
    match Manifest.parse (Manifest.serialize sample) with
    | Ok parsed ->
        let a = parsed.ManagedArtifacts |> List.find (fun x -> x.Path = "a.txt")
        Assert.Equal(UserOwned, a.Ownership)
        Assert.Equal(PreservedExisting, a.Disposition)
    | Error problem -> failwithf "unexpected %A" problem

[<Fact>]
let ``a manifest without dispositions is read as tool-installed`` () =
    // Older manifests predate the field. Defaulting to what those installs
    // actually did keeps them upgradeable.
    let text =
        """{"schemaVersion":1,"tool":"limen","package":"p","installedVersion":"1.0.0",
            "configurationVersion":1,
            "managedArtifacts":[{"path":"a.txt","ownership":"tool-owned","sha256":"aa"}]}"""

    match Manifest.parse text with
    | Ok parsed -> Assert.Equal(InstalledByTool, parsed.ManagedArtifacts.Head.Disposition)
    | Error problem -> failwithf "unexpected %A" problem

[<Fact>]
let ``malformed JSON is reported as unreadable rather than missing`` () =
    match Manifest.parse "{ not json" with
    | Error (ManifestUnreadable _) -> ()
    | other -> failwithf "expected ManifestUnreadable, got %A" other

[<Fact>]
let ``a newer schema version is refused rather than guessed at`` () =
    let text = """{"schemaVersion":99,"tool":"limen","package":"p","installedVersion":"1.0.0"}"""

    match Manifest.parse text with
    | Error (ManifestSchemaUnsupported (found, supported)) ->
        Assert.Equal(99, found)
        Assert.Equal(Paths.supportedSchemaVersion, supported)
    | other -> failwithf "expected ManifestSchemaUnsupported, got %A" other

[<Fact>]
let ``a manifest missing required fields is unreadable`` () =
    match Manifest.parse """{"schemaVersion":1}""" with
    | Error (ManifestUnreadable _) -> ()
    | other -> failwithf "expected ManifestUnreadable, got %A" other

[<Fact>]
let ``the manifest carries no timestamp`` () =
    // A timestamp would make two identical installations differ and would
    // silently break the idempotency guarantee.
    let text = Manifest.serialize sample
    Assert.DoesNotContain("installedOn", text)
    Assert.DoesNotContain("timestamp", text)

[<Fact>]
let ``configuration rejects a version newer than the tool understands`` () =
    match Configuration.parse "limen.config.json" """{"configurationVersion":99}""" with
    | Error (ConfigurationVersionUnsupported (found, _)) -> Assert.Equal(99, found)
    | other -> failwithf "expected ConfigurationVersionUnsupported, got %A" other

[<Fact>]
let ``configuration round trips its boundary`` () =
    let text = Configuration.serialize Configuration.defaultConfiguration

    match Configuration.parse "limen.config.json" text with
    | Ok parsed ->
        Assert.Equal<string list>([ "src/engine" ], parsed.Boundary.Engine)
        Assert.Equal<string list>([ "src/kernel" ], parsed.Boundary.Kernel)
    | Error problem -> failwithf "unexpected %A" problem

[<Theory>]
[<InlineData("../escape.txt")>]
[<InlineData("/etc/passwd")>]
[<InlineData("a/../../b")>]
[<InlineData("")>]
let ``paths that leave the repository are refused`` (path: string) =
    Assert.False(Paths.isSafeRelative path)

[<Theory>]
[<InlineData(".echelon/limen.json")>]
[<InlineData("src/engine/domain.ts")>]
let ``ordinary repository paths are accepted`` (path: string) =
    Assert.True(Paths.isSafeRelative path)

[<Fact>]
let ``hashing ignores line-ending style`` () =
    // Otherwise a Windows checkout reports every tool-owned file as modified
    // and blocks its own upgrade.
    Assert.Equal(Hashing.sha256OfString "a\nb\n", Hashing.sha256OfString "a\r\nb\r\n")
