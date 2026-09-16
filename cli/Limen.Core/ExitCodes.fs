/// The exit-code contract.
///
/// These numbers are public interface. CI jobs and agents branch on them, so a
/// value may be added but never reused for a different meaning. An unhandled
/// exception must never become the contract — `Program.fs` funnels everything
/// through these.
module Limen.Core.ExitCodes

/// The command did what it was asked to do.
[<Literal>]
let success = 0

/// The tool failed in a way it did not anticipate. Always accompanied by a
/// message on stderr.
[<Literal>]
let internalFailure = 1

/// The command line could not be understood.
[<Literal>]
let invalidArguments = 2

/// `verify` ran correctly and the installation is not valid.
[<Literal>]
let verificationFailed = 3

/// The capability is not installed, or is installed at a version this CLI
/// cannot work with.
[<Literal>]
let incompatibleInstallation = 4

/// An upgrade was refused because a precondition failed or a local change would
/// have been destroyed. Nothing was written.
[<Literal>]
let migrationBlocked = 5

/// The environment is missing something the tool needs (no repository, no write
/// access).
[<Literal>]
let prerequisiteFailure = 6

/// Reserved for the Node bootstrap: no binary ships for this platform.
[<Literal>]
let unsupportedPlatform = 7

let describe code =
    match code with
    | 0 -> "success"
    | 1 -> "internal failure"
    | 2 -> "invalid arguments"
    | 3 -> "verification failed"
    | 4 -> "incompatible installation"
    | 5 -> "migration blocked"
    | 6 -> "prerequisite failure"
    | 7 -> "unsupported platform"
    | _ -> "unknown"
