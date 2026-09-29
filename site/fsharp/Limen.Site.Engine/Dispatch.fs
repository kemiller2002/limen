namespace Limen.Site.Engine

open Limen.Contract.Core
open Limen.Guest
open Limen.Site.Engine.Engine

module Dispatch =

    let private traceLimit = 50
    let mutable private state = initialState
    let mutable private correlationSequence = 0

    let private nextCorrelationId () =
        correlationSequence <- correlationSequence + 1
        $"effect-{correlationSequence}"

    let private apply result eventLabel =
        state <-
            match result.Step with
            | None -> result.State
            | Some step ->
                let sequence = result.State.Sequence + 1

                let entry =
                    { Id = string sequence
                      Event = eventLabel
                      Command = step.Command
                      From = step.From
                      To = step.To
                      Effect = step.Effect }

                { result.State with
                    Sequence = sequence
                    Trace = entry :: result.State.Trace |> List.truncate traceLimit }

        { View = project state
          Effects = result.Effects
          Cancellations = []
          Handshake = None }

    let private currentView handshake =
        { View = project state
          Effects = []
          Cancellations = []
          Handshake = handshake }

    // The wire contract is the generated binding (guests/fsharp/Limen.Contract):
    // this module owns no protocol types of its own. A message outside the
    // contract is a compatibility failure, not an application event.
    let handle (messageJson: string) =
        let message =
            match Codec.parseBrowserToEngineMessage messageJson with
            | Ok message -> message
            | Error error -> failwith $"Browser message outside the Limen contract at {error.Path}: expected {error.Expected}, found {error.Found}"

        let response =
            match message with
            | BrowserToEngineMessage.Initialize(_, _, offer) ->
                // An incompatible host gets the refusal; the kernel applies
                // nothing from a rejected Initialize.
                currentView (Some(Handshake.answer offer Handshake.coreOnly))
            | BrowserToEngineMessage.Event event ->
                let label =
                    match event.Key with
                    | Some key -> $"{event.Name}({key})"
                    | None -> event.Name

                apply (transition state (eventToCommand (nextCorrelationId ()) event)) label
            | BrowserToEngineMessage.EffectResult(EffectResult.HttpResult(CorrelationId correlationId, outcome)) ->
                apply (transition state (RecordDeploy(correlationId, outcome))) "EffectResult"
            | BrowserToEngineMessage.EffectResult(EffectResult.StorageResult _)
            | BrowserToEngineMessage.EffectResult(EffectResult.ClipboardResult _)
            | BrowserToEngineMessage.EffectResult(EffectResult.NavigationResult _)
            | BrowserToEngineMessage.EffectResult(EffectResult.CapabilityResult _) ->
                failwith "The Limen site engine requests only Http effects; a result for any other kind has no request behind it."
            | BrowserToEngineMessage.LocationChanged _
            | BrowserToEngineMessage.CapabilityFact _ ->
                currentView None

        Codec.serializeEngineToBrowserMessage response

    let resetForTests () =
        state <- initialState
        correlationSequence <- 0
