namespace Limen.Federation.Target.Engine

open System
open System.Text.Json.Nodes

module TargetModule =

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

    let private stringNode (value: string) =
        JsonValue.Create(value) :> JsonNode

    let private intNode (value: int) =
        JsonValue.Create(value) :> JsonNode

    let private strings (values: seq<string>) =
        let array = JsonArray()
        values |> Seq.iter (fun value -> array.Add(JsonValue.Create(value)))
        array :> JsonNode

    let private contractRange (contract: string) =
        let item = JsonObject()
        item["contract"] <- stringNode contract
        item["minVersion"] <- intNode 1
        item["maxVersion"] <- intNode 1
        item :> JsonNode

    let private contractRanges (contracts: seq<string>) =
        let array = JsonArray()
        contracts |> Seq.iter (fun contract -> array.Add(contractRange contract))
        array :> JsonNode

    let manifestJson () =
        let root = JsonObject()
        root["id"] <- stringNode ModuleId
        root["version"] <- stringNode "1.0.0"
        root["federationProtocolVersion"] <- intNode FederationProtocolVersion
        root["accepts"] <- contractRanges [ RequestContract ]
        root["emits"] <- contractRanges [ ResultContract ]
        root["capabilitiesRequired"] <- strings []
        root["dependencies"] <- strings []
        root["routes"] <- strings [ "/federation/target" ]
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

    let private decodeRequest (root: JsonObject) =
        if root["kind"].GetValue<string>() <> "TransitionRequest" then
            failwith "Target accepts only TransitionRequest envelopes."

        if root["contract"].GetValue<string>() <> RequestContract then
            failwith "Target received an unsupported request contract."

        if root["contractVersion"].GetValue<int>() <> 1 then
            failwith "Target received an unsupported request contract version."

        if root["target"].GetValue<string>() <> ModuleId then
            failwith "Target received an envelope addressed to another module."

        let payload = root["payload"].AsObject()

        { Value = payload["value"].GetValue<int>()
          ExpectedStateVersion = root["expectedStateVersion"].GetValue<int>() }

    let private resultEnvelope
        (sourceModuleId: string)
        (correlationId: string)
        (kind: string)
        (payload: JsonObject)
        =
        let root = JsonObject()
        root["protocolVersion"] <- intNode FederationProtocolVersion
        root["source"] <- stringNode ModuleId
        root["target"] <- stringNode sourceModuleId
        root["correlationId"] <- stringNode correlationId
        root["causationId"] <- stringNode correlationId
        root["kind"] <- stringNode kind
        root["contract"] <- stringNode ResultContract
        root["contractVersion"] <- intNode 1
        root["capabilities"] <- strings []
        root["evidence"] <- strings [ $"target-state-version:{state.StateVersion}" ]
        root["payload"] <- payload
        root :> JsonNode

    let private emittedResult envelope =
        let emitted = JsonArray()
        emitted.Add(envelope)
        let root = JsonObject()
        root["emitted"] <- emitted
        root.ToJsonString()

    let dispatch (envelopeJson: string) =
        assertActive ()

        let root = JsonNode.Parse(envelopeJson).AsObject()

        if root["protocolVersion"].GetValue<int>() <> FederationProtocolVersion then
            failwith "Target received an incompatible federation protocol."

        let sourceModuleId = root["source"].GetValue<string>()
        let correlationId = root["correlationId"].GetValue<string>()
        let request = decodeRequest root

        if request.ExpectedStateVersion <> state.StateVersion then
            let payload = JsonObject()
            payload["reason"] <- stringNode "state-version-mismatch"
            payload["currentStateVersion"] <- intNode state.StateVersion
            resultEnvelope sourceModuleId correlationId "TransitionRejected" payload
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
            resultEnvelope sourceModuleId correlationId "TransitionAccepted" payload
            |> emittedResult

    let resetForTests () =
        state <- initialState
        initialized <- false
        active <- false
