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
      Boundary = Declared defaultBoundary }

let toJson (configuration: Configuration) =
    let boundary =
        match configuration.Boundary with
        | Declared declared ->
            JObject
                [ "engine", declared.Engine |> List.map JString |> JArray
                  "kernel", declared.Kernel |> List.map JString |> JArray ]
        | NoBoundary rationale -> JObject [ "notApplicable", JObject [ "rationale", JString rationale ] ]

    JObject
        [ "configurationVersion", JInt configuration.ConfigurationVersion
          "boundary", boundary ]

/// Serialize with a leading comment? No — JSON has no comments, and inventing a
/// `"//"` key would put a fake field into a public schema. The explanation
/// lives in the documentation instead.
let serialize configuration = render (toJson configuration) + "\n"

/// The declared boundary paths, or none for a repository with no boundary.
let declaredPaths (configuration: Configuration) =
    match configuration.Boundary with
    | Declared declared -> declared
    | NoBoundary _ -> { Engine = []; Kernel = [] }

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

            let declared =
                { Engine = list "engine"
                  Kernel = list "kernel" }

            let rationale =
                boundary
                |> Option.bind (tryProperty "notApplicable")
                |> Option.map (fun notApplicable ->
                    tryProperty "rationale" notApplicable
                    |> Option.bind tryString
                    |> Option.map (fun text -> text.Trim())
                    |> Option.defaultValue "")

            // "No boundary" is a statement a reviewer must be able to read, so
            // it needs a reason, and it cannot be combined with a boundary.
            match rationale with
            | None ->
                Ok
                    { ConfigurationVersion = version
                      Boundary = Declared declared }
            | Some "" ->
                Error(
                    ConfigurationUnreadable(
                        path,
                        "\"boundary.notApplicable\" needs a non-empty \"rationale\" saying why this repository has no Limen boundary"
                    )
                )
            | Some _ when not (List.isEmpty declared.Engine && List.isEmpty declared.Kernel) ->
                Error(
                    ConfigurationUnreadable(
                        path,
                        "\"boundary.notApplicable\" cannot be combined with engine or kernel paths; declare one or the other"
                    )
                )
            | Some reason ->
                Ok
                    { ConfigurationVersion = version
                      Boundary = NoBoundary reason }
