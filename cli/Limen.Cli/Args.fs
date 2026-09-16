/// Command-line parsing.
///
/// This is an adapter, not the application: its only job is to turn strings
/// into a `Command` value. Every decision the tool makes afterwards is made by
/// `Limen.Core`, which knows nothing about argv.
///
/// Unknown flags are rejected rather than ignored. A silently ignored `--dry-run`
/// would be the most expensive kind of bug this tool could have.
module Limen.Cli.Args

type GlobalOptions =
    { Json: bool
      Verbose: bool
      /// Where to look for the repository. Defaults to the current directory,
      /// from which the root is found by walking up to a `.git`.
      Root: string option }

type InitOptions =
    { Global: GlobalOptions
      DryRun: bool
      /// Report what would change and fail if anything would. For CI, where the
      /// question is "is this repository already initialized correctly?".
      Check: bool }

type StatusOptions = { Global: GlobalOptions }

type VerifyOptions =
    { Global: GlobalOptions
      Strict: bool }

type UpgradeOptions =
    { Global: GlobalOptions
      DryRun: bool
      Check: bool }

type DoctorOptions = { Global: GlobalOptions }

type Command =
    | Init of InitOptions
    | Status of StatusOptions
    | Verify of VerifyOptions
    | Upgrade of UpgradeOptions
    | Doctor of DoctorOptions
    | Help of topic: string option
    | Version

type ParseError =
    | UnknownCommand of string
    | UnknownFlag of command: string * flag: string
    | MissingValue of flag: string

let private emptyGlobal = { Json = false; Verbose = false; Root = None }

/// Pull the flags every command accepts out of the argument list, returning
/// what is left for the command itself to interpret.
let private takeGlobals (arguments: string list) =
    let rec loop remaining options rest =
        match remaining with
        | [] -> Ok(options, List.rev rest)
        | "--json" :: tail -> loop tail { options with Json = true } rest
        | "--verbose" :: tail -> loop tail { options with Verbose = true } rest
        | "--root" :: value :: tail -> loop tail { options with Root = Some value } rest
        | [ "--root" ] -> Error(MissingValue "--root")
        | other :: tail -> loop tail options (other :: rest)

    loop arguments emptyGlobal []

/// Parse the flags of one command, rejecting anything unrecognized.
let private parseFlags (commandName: string) (accepted: (string * (bool ref)) list) (arguments: string list) =
    let rec loop remaining =
        match remaining with
        | [] -> Ok()
        | flag :: tail ->
            match accepted |> List.tryFind (fun (name, _) -> name = flag) with
            | Some (_, target) ->
                target.Value <- true
                loop tail
            | None -> Error(UnknownFlag(commandName, flag))

    loop arguments

let parse (argv: string list) : Result<Command, ParseError> =
    match argv with
    | [] -> Ok(Help None)
    | _ ->
        match takeGlobals argv with
        | Error error -> Error error
        | Ok (globals, rest) ->
            match rest with
            | [] when globals.Json || globals.Verbose -> Ok(Help None)
            | [] -> Ok(Help None)
            | head :: tail ->
                // `--help` and `--version` win wherever they appear, including
                // after a command name: `limen init --help` must document init
                // rather than initialize anything.
                if tail |> List.contains "--help" || head = "--help" || head = "-h" then
                    let topic = if head.StartsWith "-" then None else Some head
                    Ok(Help topic)
                elif head = "--version" || head = "-v" then
                    Ok Version
                else
                    match head with
                    | "init" ->
                        let dryRun = ref false
                        let check = ref false

                        parseFlags "init" [ "--dry-run", dryRun; "--check", check ] tail
                        |> Result.map (fun () ->
                            Init
                                { Global = globals
                                  DryRun = dryRun.Value || check.Value
                                  Check = check.Value })

                    | "status" ->
                        parseFlags "status" [] tail
                        |> Result.map (fun () -> Status { Global = globals })

                    | "verify" ->
                        let strict = ref false

                        parseFlags "verify" [ "--strict", strict ] tail
                        |> Result.map (fun () ->
                            Verify
                                { Global = globals
                                  Strict = strict.Value })

                    | "upgrade" ->
                        let dryRun = ref false
                        let check = ref false

                        parseFlags "upgrade" [ "--dry-run", dryRun; "--check", check ] tail
                        |> Result.map (fun () ->
                            Upgrade
                                { Global = globals
                                  DryRun = dryRun.Value || check.Value
                                  Check = check.Value })

                    | "doctor" ->
                        parseFlags "doctor" [] tail
                        |> Result.map (fun () -> Doctor { Global = globals })

                    | "help" -> Ok(Help(List.tryHead tail))
                    | "version" -> Ok Version
                    | other -> Error(UnknownCommand other)

let describeError error =
    match error with
    | UnknownCommand name -> sprintf "unknown command '%s'" name
    | UnknownFlag (command, flag) -> sprintf "unknown option '%s' for command '%s'" flag command
    | MissingValue flag -> sprintf "option '%s' requires a value" flag
