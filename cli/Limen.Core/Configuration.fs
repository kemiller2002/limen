/// Reading and writing `limen.config.json`.
///
/// This file is user-owned: it is created once by `init` and then belongs to
/// the repository. The tool reads it on every run and never rewrites it except
/// through an explicit migration, because a repository's boundary is a
/// statement about its own architecture, not about Limen.
module Limen.Core.Configuration

open Limen.Core.Types
open Limen.Core.Json

/// The boundary a repository gets before anyone has told the tool anything.
///
/// These are the conventional Limen locations. A repository that puts its
/// engine somewhere else edits the file; that is what "user-owned" means here.
let defaultBoundary =
    { Engine = [ "src/engine" ]
      Kernel = [ "src/kernel" ] }

let defaultConfiguration =
    { ConfigurationVersion = Paths.supportedConfigurationVersion
      Boundary = defaultBoundary }

let toJson (configuration: Configuration) =
    JObject
        [ "configurationVersion", JInt configuration.ConfigurationVersion
          "boundary",
          JObject
              [ "engine", configuration.Boundary.Engine |> List.map JString |> JArray
                "kernel", configuration.Boundary.Kernel |> List.map JString |> JArray ] ]

/// Serialize with a leading comment? No — JSON has no comments, and inventing a
/// `"//"` key would put a fake field into a public schema. The explanation
/// lives in the documentation instead.
let serialize configuration = render (toJson configuration) + "\n"

let parse (path: string) (text: string) : Result<Configuration, InstallationProblem> =
    match tryParse text with
    | Error detail -> Error(ConfigurationUnreadable(path, detail))
    | Ok document ->
        use document = document
        let root = document.RootElement

        match tryProperty "configurationVersion" root |> Option.bind tryInt with
        | None -> Error(ConfigurationUnreadable(path, "missing or non-numeric \"configurationVersion\""))
        | Some version when version > Paths.supportedConfigurationVersion ->
            // A newer configuration than this CLI understands. Refusing is the
            // safe direction: an older tool guessing at a newer schema is how
            // configuration gets silently downgraded.
            Error(ConfigurationVersionUnsupported(version, Paths.supportedConfigurationVersion))
        | Some version ->
            let boundary = tryProperty "boundary" root

            let list name =
                boundary
                |> Option.bind (tryProperty name)
                |> Option.bind tryStringArray
                |> Option.defaultValue []
                |> List.map Paths.normalize

            Ok
                { ConfigurationVersion = version
                  Boundary =
                    { Engine = list "engine"
                      Kernel = list "kernel" } }
