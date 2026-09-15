/// Configuration migrations.
///
/// Upgrades are expressed as an ordered chain of single-step transitions —
/// 1 → 2, then 2 → 3 — rather than one function that tries to understand every
/// historical shape at once. Going from 1 to 3 runs both steps in order, and
/// stops at the first one whose precondition fails.
///
/// The registry is passed in rather than read from a global, so tests can drive
/// the engine over invented version chains without the shipped tool having to
/// contain invented migrations.
module Limen.Core.Migrations

open Limen.Core.Types

/// One version transition.
///
/// It holds functions, so it has no meaningful structural equality or ordering;
/// saying so explicitly is better than letting the compiler refuse the type.
[<NoComparison; NoEquality>]
type Migration =
    { From: int
      To: int
      Description: string
      /// Refuse rather than guess: returning `Error` leaves the repository
      /// untouched and reports why.
      Precondition: Configuration -> Result<unit, string>
      Apply: Configuration -> Configuration }

/// The migrations this CLI ships.
///
/// It is empty, and that is not an omission: configuration version 1 is the
/// only version that has ever existed, so there is no transition to describe.
/// Inventing one to make the list look populated would put a migration into the
/// public contract that no repository will ever need.
let shipped: Migration list = []

/// The ordered chain from one version to another, or an explanation of why no
/// chain exists.
let rec private chainFrom (registry: Migration list) (current: int) (target: int) (accumulated: Migration list) =
    if current = target then
        Ok(List.rev accumulated)
    elif current > target then
        Error(sprintf "configuration version %d is newer than this tool supports (%d)" current target)
    else
        match registry |> List.tryFind (fun migration -> migration.From = current) with
        | None -> Error(sprintf "no migration is defined from configuration version %d" current)
        | Some migration -> chainFrom registry migration.To target (migration :: accumulated)

let plan (registry: Migration list) (current: int) (target: int) = chainFrom registry current target []

/// Run a chain, stopping at the first failed precondition.
///
/// Because this operates on the configuration value rather than on files, a
/// failure part-way through leaves nothing half-written: the caller only
/// persists a configuration that every step accepted.
let run (chain: Migration list) (configuration: Configuration) =
    let rec step remaining current =
        match remaining with
        | [] -> Ok current
        | migration :: rest ->
            match migration.Precondition current with
            | Error reason ->
                Error(sprintf "migration %d -> %d cannot run: %s" migration.From migration.To reason)
            | Ok () -> step rest (migration.Apply current)

    step chain configuration
