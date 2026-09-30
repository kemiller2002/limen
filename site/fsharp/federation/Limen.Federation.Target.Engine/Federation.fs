namespace Limen.Federation.Target.Engine

open System
open System.Text.Json.Nodes
open Limen.Contract

// The federation wire protocol comes from contract/federation.contract.json,
// through the generated F# bindings (WI-0141): the manifest, initialization,
// envelopes and results are the contract's types, decoded strictly and
// encoded by the generated codec. This module's own payloads and snapshot
// are its own.
module TargetModule =

    module F = Limen.Contract.Federation.Types
    module Codec = Limen.Contract.Federation.Codec

    [<Literal>]
    let ModuleId = "limen.proof.target"

    [<Literal>]
    let SourceModuleId = "limen.proof.source"

    [<Literal>]
    let RequestContract = "limen.proof.transition"

    [<Literal>]
    let ResultContract = "limen.proof.transition.result"

    [<Literal>]
    let FederationProtocolVersion = 1

    type TransitionRequest =
        { Value: int
          ExpectedStateVersion: int }

    type TargetState =
        { StateVersion: int
          AcceptedCount: int
          LastValue: int option }

    let private initialState =
        { StateVersion = 0
          AcceptedCount = 0
          LastValue = None }

    let mutable private state = initialState
    let mutable private initialized = false
    let mutable private active = false

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
          Accepts = [ range RequestContract ]
          Emits = [ range ResultContract ]
          CapabilitiesRequired = []
          Dependencies = []
          Routes = [ "/federation/target" ] }

    let manifestJson () = text (Codec.encodeModuleManifest manifest)

    // The decoder refuses any other federation protocol version.
    let initialize (contextJson: string) =
        let context = decodeOrFail "Initialization" Codec.decodeModuleInitialization contextJson
        let (F.ModuleId moduleId) = context.ModuleId

        if moduleId <> ModuleId then
            failwith ("Initialization module id '" + moduleId + "' does not match '" + ModuleId + "'.")

        initialized <- true
        active <- false

    let snapshotJson () =
        let root = JsonObject()
        root["stateVersion"] <- intNode state.StateVersion
        root["acceptedCount"] <- intNode state.AcceptedCount

        match state.LastValue with
        | Some value -> root["lastValue"] <- intNode value
        | None -> root["lastValue"] <- null

        root.ToJsonString()

    let restore (snapshotJson: string) =
        if not initialized then
            failwith "Target module must be initialized before restore."

        if String.IsNullOrWhiteSpace(snapshotJson) || snapshotJson.Trim() = "null" then
            state <- initialState
        else
            let root = JsonNode.Parse(snapshotJson).AsObject()

            state <-
                { StateVersion = root["stateVersion"].GetValue<int>()
                  AcceptedCount = root["acceptedCount"].GetValue<int>()
                  LastValue =
                    match root["lastValue"] with
                    | null -> None
                    | node -> Some(node.GetValue<int>()) }

    let activate () =
        if not initialized then
            failwith "Target module must be initialized before activate."

        active <- true

    let suspend () =
        if not active then
            failwith "Target module must be active before suspend."

        active <- false

    let unload () =
        active <- false
        initialized <- false

    let private assertActive () =
        if not active then
            failwith "Target module is not active."

    let private decodeRequest (envelope: F.FederationEnvelope) =
        if envelope.Kind <> F.FederationMessageKind.TransitionRequest then
            failwith "Target accepts only TransitionRequest envelopes."

        if envelope.Contract <> F.ContractId RequestContract then
            failwith "Target received an unsupported request contract."

        if envelope.ContractVersion <> 1L then
            failwith "Target received an unsupported request contract version."

        if envelope.Target <> Some(F.ModuleId ModuleId) then
            failwith "Target received an envelope addressed to another module."

        let (RawJson payloadText) = envelope.Payload
        let payload = JsonNode.Parse(payloadText).AsObject()

        { Value = payload["value"].GetValue<int>()
          ExpectedStateVersion =
            match envelope.ExpectedStateVersion with
            | Some version -> int version
            | None -> failwith "Target requires the expected state version." }

    let private resultEnvelope
        (source: F.ModuleId)
        (correlationId: F.FederationCorrelationId)
        (kind: F.FederationMessageKind)
        (payload: JsonObject)
        : F.FederationEnvelope =
        { Source = F.ModuleId ModuleId
          Target = Some source
          CorrelationId = correlationId
          CausationId = Some correlationId
          IdempotencyKey = None
          Kind = kind
          Contract = F.ContractId ResultContract
          ContractVersion = 1L
          ExpectedStateVersion = None
          Capabilities = []
          Evidence = [ "target-state-version:" + string state.StateVersion ]
          Payload = RawJson(payload.ToJsonString()) }

    let private emittedResult envelope =
        text (Codec.encodeModuleDispatchResult { Emitted = [ envelope ] })

    let dispatch (envelopeJson: string) =
        assertActive ()

        let envelope = decodeOrFail "Envelope" Codec.decodeFederationEnvelope envelopeJson
        let request = decodeRequest envelope

        if request.ExpectedStateVersion <> state.StateVersion then
            let payload = JsonObject()
            payload["reason"] <- JsonValue.Create("state-version-mismatch")
            payload["currentStateVersion"] <- intNode state.StateVersion
            resultEnvelope envelope.Source envelope.CorrelationId F.FederationMessageKind.TransitionRejected payload
            |> emittedResult
        else
            let acceptedValue = request.Value + 1
            let nextVersion = state.StateVersion + 1

            state <-
                { StateVersion = nextVersion
                  AcceptedCount = state.AcceptedCount + 1
                  LastValue = Some acceptedValue }

            let payload = JsonObject()
            payload["acceptedValue"] <- intNode acceptedValue
            payload["stateVersion"] <- intNode nextVersion
            resultEnvelope envelope.Source envelope.CorrelationId F.FederationMessageKind.TransitionAccepted payload
            |> emittedResult

    let resetForTests () =
        state <- initialState
        initialized <- false
        active <- false
