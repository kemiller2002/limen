/// How an engine is expected to handle contract unions: every case named, no
/// wildcard. A new variant in the contract must break this file's build.
module Limen.Contract.Pressure.Consumer

open Limen.Contract.Core

let describeOutcome (outcome: EffectOutcome) : string =
    match outcome with
    | EffectOutcome.Success(status, _, _) -> $"success {status}"
    | EffectOutcome.Failure(reason, _) ->
        match reason with
        | HttpFailureReason.Network -> "network"
        | HttpFailureReason.Aborted -> "aborted"
        | HttpFailureReason.InvalidResponse -> "invalid response"
        | HttpFailureReason.TooLarge -> "too large"
    | EffectOutcome.Cancelled -> "cancelled"
    | EffectOutcome.OutcomeUnknown reason ->
        match reason with
        | OutcomeUnknownReason.TimeoutAfterDispatch -> "unknown (timed out): reconcile before retrying"
        | OutcomeUnknownReason.ConnectionLost -> "unknown (connection lost): reconcile before retrying"

let describeResult (result: EffectResult) : string =
    match result with
    | EffectResult.HttpResult(_, outcome) -> describeOutcome outcome
    | EffectResult.StorageResult _ -> "storage"
    | EffectResult.ClipboardResult _ -> "clipboard"
    | EffectResult.NavigationResult _ -> "navigation"
    | EffectResult.CapabilityResult _ -> "capability"
