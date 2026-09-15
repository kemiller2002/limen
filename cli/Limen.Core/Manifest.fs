/// Reading and writing `.echelon/limen.json`.
///
/// The manifest is the source of truth for what Limen installed. It records no
/// secrets, nothing machine-specific, and no timestamps — a timestamp would
/// make two identical installations differ, which would defeat the idempotency
/// guarantee the tool makes about `init`.
module Limen.Core.Manifest

open Limen.Core.Types
open Limen.Core.Json

let private artifactToJson (artifact: ManagedArtifact) =
    JObject
        [ "path", JString artifact.Path
          "ownership", JString(Ownership.toString artifact.Ownership)
          "disposition", JString(Disposition.toString artifact.Disposition)
          "sha256", JString artifact.Sha256 ]

/// Serialize a manifest. Artifacts are sorted by path so that the same
/// installation always produces byte-identical output regardless of the order
/// the planner happened to emit changes in.
let toJson (manifest: Manifest) =
    JObject
        [ "schemaVersion", JInt manifest.SchemaVersion
          "tool", JString manifest.Tool
          "package", JString manifest.Package
          "installedVersion", JString manifest.InstalledVersion
          "configurationVersion", JInt manifest.ConfigurationVersion
          "managedArtifacts",
          manifest.ManagedArtifacts
          |> List.sortBy (fun artifact -> artifact.Path)
          |> List.map artifactToJson
          |> JArray ]

let serialize manifest = render (toJson manifest) + "\n"

let private parseArtifact element =
    match tryProperty "path" element |> Option.bind tryString,
          tryProperty "ownership" element |> Option.bind tryString |> Option.bind Ownership.parse,
          tryProperty "sha256" element |> Option.bind tryString
        with
    | Some path, Some ownership, Some sha256 ->
        // A manifest written before dispositions existed records none. Treating
        // the absent case as "installed by the tool" matches what those older
        // installations actually did, and the upgrade tests cover it.
        let disposition =
            tryProperty "disposition" element
            |> Option.bind tryString
            |> Option.bind Disposition.parse
            |> Option.defaultValue InstalledByTool

        Some
            { Path = Paths.normalize path
              Ownership = ownership
              Disposition = disposition
              Sha256 = sha256 }
    | _ -> None

/// Parse a manifest.
///
/// A manifest that cannot be read is reported as a problem rather than treated
/// as "not installed": the difference matters, because one means `init` and the
/// other means something is wrong that a human should look at.
let parse (text: string) : Result<Manifest, InstallationProblem> =
    match tryParse text with
    | Error detail -> Error(ManifestUnreadable detail)
    | Ok document ->
        use document = document
        let root = document.RootElement

        let schemaVersion = tryProperty "schemaVersion" root |> Option.bind tryInt

        match schemaVersion with
        | None -> Error(ManifestUnreadable "missing or non-numeric \"schemaVersion\"")
        | Some version when version <> Paths.supportedSchemaVersion ->
            Error(ManifestSchemaUnsupported(version, Paths.supportedSchemaVersion))
        | Some version ->
            let requiredString name =
                tryProperty name root |> Option.bind tryString

            match requiredString "tool", requiredString "package", requiredString "installedVersion" with
            | Some tool, Some packageName, Some installedVersion ->
                let configurationVersion =
                    tryProperty "configurationVersion" root
                    |> Option.bind tryInt
                    |> Option.defaultValue Paths.supportedConfigurationVersion

                let artifacts =
                    tryProperty "managedArtifacts" root
                    |> Option.map arrayItems
                    |> Option.defaultValue []
                    |> List.choose parseArtifact

                Ok
                    { SchemaVersion = version
                      Tool = tool
                      Package = packageName
                      InstalledVersion = installedVersion
                      ConfigurationVersion = configurationVersion
                      ManagedArtifacts = artifacts }
            | _ -> Error(ManifestUnreadable "missing \"tool\", \"package\" or \"installedVersion\"")

let tryFindArtifact path (manifest: Manifest) =
    let wanted = Paths.normalize path
    manifest.ManagedArtifacts |> List.tryFind (fun artifact -> artifact.Path = wanted)
