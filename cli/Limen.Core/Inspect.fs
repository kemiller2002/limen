/// Reading the repository.
///
/// This is the only module that looks at the filesystem for the purpose of
/// deciding anything. It produces a `RepositorySnapshot` — plain data — and
/// every decision after this point is a pure function of that snapshot. That
/// is what lets `--dry-run` share its entire code path with a real run, and
/// what lets the tests build situations that would be tedious to create on
/// disk.
module Limen.Core.Inspect

open System
open System.IO
open Limen.Core.Types

/// A file the tool cares about, as it exists right now.
type FileSnapshot =
    { Path: string
      Exists: bool
      Content: string option }

/// Everything the tool read, in one value.
type RepositorySnapshot =
    { Root: string
      ManifestText: string option
      ConfigurationText: string option
      ManagedFiles: Map<string, FileSnapshot>
      EngineFiles: (string * string) list
      KernelFiles: (string * string) list
      /// Directories the configuration names that do not exist. Not an error by
      /// itself — a repository may be adopting Limen before writing any code.
      MissingConfiguredPaths: string list }

/// Files this large are not hand-written source. Reading them would cost time
/// and prove nothing.
let private maximumFileBytes = 2L * 1024L * 1024L

let private directoriesNeverWalked =
    set [ "node_modules"; ".git"; "dist"; "dist-site"; "bin"; "obj"; "runtimes"; ".echelon" ]

let private readTextIfExists (fullPath: string) =
    try
        if File.Exists fullPath then
            let info = FileInfo fullPath
            if info.Length > maximumFileBytes then None else Some(File.ReadAllText fullPath)
        else
            None
    with :? IOException ->
        None

/// Walk one configured directory, returning (repository-relative path, content)
/// for each source file inside it.
let private readSourceTree (root: string) (relative: string) =
    let full = Path.Combine(root, relative)

    if not (Directory.Exists full) then
        []
    else
        let results = ResizeArray()

        let rec walk (directory: string) =
            for file in Directory.EnumerateFiles directory do
                let relativePath =
                    Path.GetRelativePath(root, file) |> Paths.normalize

                if Boundary.isSourceFile relativePath then
                    match readTextIfExists file with
                    | Some content -> results.Add(relativePath, content)
                    | None -> ()

            for child in Directory.EnumerateDirectories directory do
                let name = Path.GetFileName child

                if not (directoriesNeverWalked.Contains name) then
                    walk child

        walk full
        results |> List.ofSeq

/// Find the repository root by walking up from a starting directory looking for
/// a `.git` directory, falling back to the starting directory itself.
///
/// Falling back rather than failing means the tool works in a directory that is
/// not yet a git repository, which is a legitimate place to run `init`.
let findRoot (startDirectory: string) =
    let rec ascend (directory: DirectoryInfo option) =
        match directory with
        | None -> None
        | Some current ->
            if Directory.Exists(Path.Combine(current.FullName, ".git"))
               || File.Exists(Path.Combine(current.FullName, ".git")) then
                Some current.FullName
            else
                ascend (Option.ofObj current.Parent)

    ascend (Some(DirectoryInfo startDirectory))
    |> Option.defaultValue (Path.GetFullPath startDirectory)

/// Read everything the lifecycle commands need.
///
/// Note what this does *not* do: it never creates, moves or writes anything.
/// `status`, `verify` and `doctor` are read-only because the only function they
/// call that touches disk is this one.
let repository (root: string) : RepositorySnapshot =
    let manifestText = readTextIfExists (Path.Combine(root, Paths.manifest))
    let configurationText = readTextIfExists (Path.Combine(root, Paths.configuration))

    let configuration =
        configurationText
        |> Option.bind (fun text ->
            match Configuration.parse Paths.configuration text with
            | Ok value -> Some value
            | Error _ -> None)

    let boundary =
        configuration
        |> Option.map (fun c -> c.Boundary)
        |> Option.defaultValue Configuration.defaultBoundary

    // Managed paths come from two places: what the manifest says was installed,
    // and what this version of the tool would install. The union is what the
    // planner has to reason about, because a file can be in one and not the
    // other during an upgrade.
    let manifestPaths =
        manifestText
        |> Option.bind (fun text ->
            match Manifest.parse text with
            | Ok manifest -> Some(manifest.ManagedArtifacts |> List.map (fun a -> a.Path))
            | Error _ -> None)
        |> Option.defaultValue []

    let assetPaths = Assets.managed |> List.map (fun (path, _, _) -> path)

    let managedFiles =
        (manifestPaths @ assetPaths @ [ Paths.configuration ])
        |> List.distinct
        |> List.map (fun relativePath ->
            let full = Path.Combine(root, relativePath)
            let content = readTextIfExists full

            relativePath,
            { Path = relativePath
              Exists = File.Exists full
              Content = content })
        |> Map.ofList

    let missing =
        boundary.Engine @ boundary.Kernel
        |> List.filter (fun relative -> not (Directory.Exists(Path.Combine(root, relative))))

    { Root = root
      ManifestText = manifestText
      ConfigurationText = configurationText
      ManagedFiles = managedFiles
      EngineFiles = boundary.Engine |> List.collect (readSourceTree root)
      KernelFiles = boundary.Kernel |> List.collect (readSourceTree root)
      MissingConfiguredPaths = missing }

// ------------------------------------------------- pure views on a snapshot --

/// The manifest, if there is one. `None` means not installed; `Some (Error _)`
/// means installed and broken. Collapsing those two would lose the distinction
/// between "run init" and "something is wrong".
let manifest (snapshot: RepositorySnapshot) =
    snapshot.ManifestText |> Option.map Manifest.parse

let configuration (snapshot: RepositorySnapshot) =
    snapshot.ConfigurationText
    |> Option.map (Configuration.parse Paths.configuration)

let fileContent path (snapshot: RepositorySnapshot) =
    snapshot.ManagedFiles |> Map.tryFind (Paths.normalize path) |> Option.bind (fun f -> f.Content)

let fileExists path (snapshot: RepositorySnapshot) =
    snapshot.ManagedFiles
    |> Map.tryFind (Paths.normalize path)
    |> Option.map (fun f -> f.Exists)
    |> Option.defaultValue false
