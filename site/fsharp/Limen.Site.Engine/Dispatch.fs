namespace Limen.Site.Engine

open Limen.Site.Engine.Protocol
open Limen.Site.Engine.Engine

module Dispatch =

    let private protocolVersion = 1
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
          Cancellations = [] }

    let private currentView () =
        { View = project state
          Effects = []
          Cancellations = [] }

    let handle (messageJson: string) =
        let response =
            match Protocol.parseMessage messageJson with
            | Initialize version ->
                if version <> protocolVersion then
                    failwithf "Protocol version %d is unsupported; expected %d." version protocolVersion

                currentView ()
            | Event event ->
                let label =
                    match event.Key with
                    | Some key -> $"{event.Name}({key})"
                    | None -> event.Name

                apply (transition state (eventToCommand (nextCorrelationId ()) event)) label
            | HttpEffectResult(correlationId, outcome) ->
                apply (transition state (RecordDeploy(correlationId, outcome))) "EffectResult"
            | LocationChanged ->
                currentView ()

        Protocol.serializeMessage response

    let resetForTests () =
        state <- initialState
        correlationSequence <- 0
