namespace Limen.Federation.Source.Engine

open System
open System.Text.Json.Nodes
open Limen.Contract

// The federation wire protocol comes from contract/federation.contract.json,
// through the generated F# bindings (WI-0141): the manifest, initialization,
// envelopes and results are the contract's types, decoded strictly and
// encoded by the generated codec. This module's own payloads and snapshot
// are its own.
module SourceModule =

    module F = Limen.Contract.Federation.Types
    module Codec = Limen.Contract.Federation.Codec

    [<Literal>]
    let ModuleId = "limen.proof.source"

    [<Literal>]
    let TargetModuleId = "limen.proof.target"

    [<Literal>]
    let RequestContract = "limen.proof.transition"

    [<Literal>]
    let ResultContract = "limen.proof.transition.result"

    [<Literal>]
    let FederationProtocolVersion = 1

    type SourceStatus =
        | Idle
        | Awaiting of correlationId: string
        | Completed of acceptedValue: int
        | Rejected of reason: string

    type SourceState =
        { Status: SourceStatus
          TargetStateVersion: int
          Sequence: int }

    type AcceptedPayload =
        { AcceptedValue: int
          StateVersion: int }

    type RejectedPayload =
        { Reason: string
          CurrentStateVersion: int }

    let private initialState =
        { Status = Idle
          TargetStateVersion = 0
          Sequence = 0 }

    let mutable private state = initialState
    let mutable private initialized = false
    let mutable private active = false

    let private stringNode (value: string) =
        JsonValue.Create(value) :> JsonNode

    let private intNode (value: int) =
        JsonValue.Create(value) :> JsonNode

    let private text (node: JsonNode) = node.ToJsonString()

    let private decodeOrFail what decoder json =
        match Limen.Contract.Wire.parse decoder json with
        | Ok value -> value
        | Error (error: DecodeError) ->
            failwith (what + " is outside the federation contract at " + error.Path + ": expected " + error.Expected + ", found " + error.Found + ".")

    let private range contract : F.ContractRange =
        { Contract = F.ContractId contract; MinVersion = 1L; MaxVersion = 1L }

    let manifest : F.ModuleManifest =
        { Id = F.ModuleId ModuleId
          Version = "1.0.0"
          Accepts = [ range ResultContract ]
          Emits = [ range RequestContract ]
          CapabilitiesRequired = []
          Dependencies = [ F.ModuleId TargetModuleId ]
          Routes = [ "/federation/source" ] }

    let manifestJson () = text (Codec.encodeModuleManifest manifest)

    // The decoder refuses any other federation protocol version.
    let initialize (contextJson: string) =
        let context = decodeOrFail "Initialization" Codec.decodeModuleInitialization contextJson
        let (F.ModuleId moduleId) = context.ModuleId

        if moduleId <> ModuleId then
            failwith ("Initialization module id '" + moduleId + "' does not match '" + ModuleId + "'.")

        initialized <- true
        active <- false

    let private statusName = function
        | Idle -> "Idle"
        | Awaiting _ -> "Awaiting"
        | Completed _ -> "Completed"
        | Rejected _ -> "Rejected"

    let snapshotJson () =
        let root = JsonObject()
        root["status"] <- stringNode (statusName state.Status)
        root["targetStateVersion"] <- intNode state.TargetStateVersion
        root["sequence"] <- intNode state.Sequence

        match state.Status with
        | Awaiting correlationId ->
            root["correlationId"] <- stringNode correlationId
        | Completed acceptedValue ->
            root["acceptedValue"] <- intNode acceptedValue
        | Rejected reason ->
            root["reason"] <- stringNode reason
        | Idle -> ()

        root.ToJsonString()

    let restore (snapshotJson: string) =
        if not initialized then
            failwith "Source module must be initialized before restore."

        if String.IsNullOrWhiteSpace(snapshotJson) || snapshotJson.Trim() = "null" then
            state <- initialState
        else
            let root = JsonNode.Parse(snapshotJson).AsObject()
            let version = root["targetStateVersion"].GetValue<int>()
            let sequence = root["sequence"].GetValue<int>()

            let status =
                match root["status"].GetValue<string>() with
                | "Idle" -> Idle
                | "Awaiting" -> Awaiting(root["correlationId"].GetValue<string>())
                | "Completed" -> Completed(root["acceptedValue"].GetValue<int>())
                | "Rejected" -> Rejected(root["reason"].GetValue<string>())
                | other -> failwithf "Unknown source snapshot status '%s'." other

            state <-
                { Status = status
                  TargetStateVersion = version
                  Sequence = sequence }

    let activate () =
        if not initialized then
            failwith "Source module must be initialized before activate."

        active <- true

    let suspend () =
        if not active then
            failwith "Source module must be active before suspend."

        active <- false

    let unload () =
        active <- false
        initialized <- false

    let private assertActive () =
        if not active then
            failwith "Source module is not active."

    let beginTransition () =
        assertActive ()

        match state.Status with
        | Awaiting _ ->
            failwith "A transition is already awaiting a response."
        | _ ->
            let sequence = state.Sequence + 1
            let correlationId = "proof-" + string sequence

            state <-
                { state with
                    Status = Awaiting correlationId
                    Sequence = sequence }

            let payload = JsonObject()
            payload["value"] <- intNode 41

            let request : F.FederationEnvelope =
                { Source = F.ModuleId ModuleId
                  Target = Some(F.ModuleId TargetModuleId)
                  CorrelationId = F.FederationCorrelationId correlationId
                  CausationId = None
                  IdempotencyKey = Some("source-" + string sequence)
                  Kind = F.FederationMessageKind.TransitionRequest
                  Contract = F.ContractId RequestContract
                  ContractVersion = 1L
                  ExpectedStateVersion = Some(int64 state.TargetStateVersion)
                  Capabilities = []
                  Evidence = [ "source-state-owned-by-fsharp" ]
                  Payload = RawJson(payload.ToJsonString()) }

            text (Codec.encodeFederationEnvelope request)

    let private parseAcceptedPayload (payload: JsonObject) =
        { AcceptedValue = payload["acceptedValue"].GetValue<int>()
          StateVersion = payload["stateVersion"].GetValue<int>() }

    let private parseRejectedPayload (payload: JsonObject) =
        { Reason = payload["reason"].GetValue<string>()
          CurrentStateVersion = payload["currentStateVersion"].GetValue<int>() }

    let dispatch (envelopeJson: string) =
        assertActive ()

        let envelope = decodeOrFail "Envelope" Codec.decodeFederationEnvelope envelopeJson

        if envelope.Target <> Some(F.ModuleId ModuleId) then
            failwith "Source received an envelope addressed to another module."

        if envelope.Contract <> F.ContractId ResultContract then
            failwith "Source received an unsupported result contract."

        if envelope.ContractVersion <> 1L then
            failwith "Source received an unsupported result contract version."

        let (F.FederationCorrelationId correlationId) = envelope.CorrelationId

        match state.Status with
        | Awaiting expected when expected = correlationId ->
            let (RawJson payloadText) = envelope.Payload
            let payload = JsonNode.Parse(payloadText).AsObject()

            match envelope.Kind with
            | F.FederationMessageKind.TransitionAccepted ->
                let decoded = parseAcceptedPayload payload
                state <-
                    { state with
                        Status = Completed decoded.AcceptedValue
                        TargetStateVersion = decoded.StateVersion }
            | F.FederationMessageKind.TransitionRejected ->
                let decoded = parseRejectedPayload payload
                state <-
                    { state with
                        Status = Rejected decoded.Reason
                        TargetStateVersion = decoded.CurrentStateVersion }
            | _ ->
                failwith "Source received an unsupported result kind."
        | Awaiting expected ->
            failwith ("Source rejected stale correlation '" + correlationId + "'; expected '" + expected + "'.")
        | _ ->
            failwith "Source received a result without an outstanding transition."

        text (Codec.encodeModuleDispatchResult { Emitted = [] })

    let resetForTests () =
        state <- initialState
        initialized <- false
        active <- false
