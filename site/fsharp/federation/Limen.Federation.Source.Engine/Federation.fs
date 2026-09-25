namespace Limen.Federation.Source.Engine

open System
open System.Text.Json.Nodes

module SourceModule =

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

    let private valueNode value = JsonValue.Create(value) :> JsonNode

    let private strings values =
        let array = JsonArray()
        values |> Seq.iter (fun value -> array.Add(JsonValue.Create(value)))
        array :> JsonNode

    let private contractRange contract =
        let item = JsonObject()
        item["contract"] <- valueNode contract
        item["minVersion"] <- valueNode 1
        item["maxVersion"] <- valueNode 1
        item :> JsonNode

    let private contractRanges contracts =
        let array = JsonArray()
        contracts |> Seq.iter (fun contract -> array.Add(contractRange contract))
        array :> JsonNode

    let manifestJson () =
        let root = JsonObject()
        root["id"] <- valueNode ModuleId
        root["version"] <- valueNode "1.0.0"
        root["federationProtocolVersion"] <- valueNode FederationProtocolVersion
        root["accepts"] <- contractRanges [ ResultContract ]
        root["emits"] <- contractRanges [ RequestContract ]
        root["capabilitiesRequired"] <- strings []
        root["dependencies"] <- strings [ TargetModuleId ]
        root["routes"] <- strings [ "/federation/source" ]
        root.ToJsonString()

    let initialize (contextJson: string) =
        let root = JsonNode.Parse(contextJson).AsObject()
        let version = root["federationProtocolVersion"].GetValue<int>()
        let moduleId = root["moduleId"].GetValue<string>()

        if version <> FederationProtocolVersion then
            failwithf "Federation protocol %d is unsupported; expected %d." version FederationProtocolVersion

        if moduleId <> ModuleId then
            failwithf "Initialization module id '%s' does not match '%s'." moduleId ModuleId

        initialized <- true
        active <- false

    let private statusName = function
        | Idle -> "Idle"
        | Awaiting _ -> "Awaiting"
        | Completed _ -> "Completed"
        | Rejected _ -> "Rejected"

    let snapshotJson () =
        let root = JsonObject()
        root["status"] <- valueNode (statusName state.Status)
        root["targetStateVersion"] <- valueNode state.TargetStateVersion
        root["sequence"] <- valueNode state.Sequence

        match state.Status with
        | Awaiting correlationId ->
            root["correlationId"] <- valueNode correlationId
        | Completed acceptedValue ->
            root["acceptedValue"] <- valueNode acceptedValue
        | Rejected reason ->
            root["reason"] <- valueNode reason
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
            let correlationId = $"proof-{sequence}"

            state <-
                { state with
                    Status = Awaiting correlationId
                    Sequence = sequence }

            let payload = JsonObject()
            payload["value"] <- valueNode 41

            let root = JsonObject()
            root["protocolVersion"] <- valueNode FederationProtocolVersion
            root["source"] <- valueNode ModuleId
            root["target"] <- valueNode TargetModuleId
            root["correlationId"] <- valueNode correlationId
            root["idempotencyKey"] <- valueNode $"source-{sequence}"
            root["kind"] <- valueNode "TransitionRequest"
            root["contract"] <- valueNode RequestContract
            root["contractVersion"] <- valueNode 1
            root["expectedStateVersion"] <- valueNode state.TargetStateVersion
            root["capabilities"] <- strings []
            root["evidence"] <- strings [ "source-state-owned-by-fsharp" ]
            root["payload"] <- payload
            root.ToJsonString()

    let private parseAcceptedPayload (payload: JsonObject) =
        { AcceptedValue = payload["acceptedValue"].GetValue<int>()
          StateVersion = payload["stateVersion"].GetValue<int>() }

    let private parseRejectedPayload (payload: JsonObject) =
        { Reason = payload["reason"].GetValue<string>()
          CurrentStateVersion = payload["currentStateVersion"].GetValue<int>() }

    let dispatch (envelopeJson: string) =
        assertActive ()

        let root = JsonNode.Parse(envelopeJson).AsObject()

        if root["protocolVersion"].GetValue<int>() <> FederationProtocolVersion then
            failwith "Source received an incompatible federation protocol."

        if root["target"].GetValue<string>() <> ModuleId then
            failwith "Source received an envelope addressed to another module."

        if root["contract"].GetValue<string>() <> ResultContract then
            failwith "Source received an unsupported result contract."

        if root["contractVersion"].GetValue<int>() <> 1 then
            failwith "Source received an unsupported result contract version."

        let correlationId = root["correlationId"].GetValue<string>()

        match state.Status with
        | Awaiting expected when expected = correlationId ->
            let payload = root["payload"].AsObject()

            match root["kind"].GetValue<string>() with
            | "TransitionAccepted" ->
                let decoded = parseAcceptedPayload payload
                state <-
                    { state with
                        Status = Completed decoded.AcceptedValue
                        TargetStateVersion = decoded.StateVersion }
            | "TransitionRejected" ->
                let decoded = parseRejectedPayload payload
                state <-
                    { state with
                        Status = Rejected decoded.Reason
                        TargetStateVersion = decoded.CurrentStateVersion }
            | other ->
                failwithf "Source received unsupported result kind '%s'." other
        | Awaiting expected ->
            failwithf "Source rejected stale correlation '%s'; expected '%s'." correlationId expected
        | _ ->
            failwith "Source received a result without an outstanding transition."

        """{"emitted":[]}"""

    let resetForTests () =
        state <- initialState
        initialized <- false
        active <- false
