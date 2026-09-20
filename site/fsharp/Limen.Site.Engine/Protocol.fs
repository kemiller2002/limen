namespace Limen.Site.Engine

open System.Text.Json.Nodes

module Protocol =

    type SemanticEvent =
        { Name: string
          Key: string option
          Value: string option }

    type HttpOutcome =
        | HttpSuccess of status: int
        | HttpFailure of reason: string * status: int option
        | HttpCancelled
        | HttpOutcomeUnknown

    type BrowserToEngineMessage =
        | Initialize of protocolVersion: int
        | Event of SemanticEvent
        | HttpEffectResult of correlationId: string * outcome: HttpOutcome
        | LocationChanged

    type ViewValue =
        | VString of string
        | VNumber of int
        | VBool of bool
        | VItems of Map<string, ViewValue> list

    type EffectRequest =
        | HttpGet of correlationId: string * url: string * timeoutMs: int

    type EngineToBrowserMessage =
        { View: Map<string, ViewValue>
          Effects: EffectRequest list
          Cancellations: string list }

    let private optionalString (obj: JsonObject) key =
        match obj.[key] with
        | null -> None
        | node -> Some(node.GetValue<string>())

    let private optionalInt (obj: JsonObject) key =
        match obj.[key] with
        | null -> None
        | node -> Some(node.GetValue<int>())

    let parseMessage (json: string) : BrowserToEngineMessage =
        let root = JsonNode.Parse(json).AsObject()

        match root.["kind"].GetValue<string>() with
        | "Initialize" ->
            Initialize(root.["protocolVersion"].GetValue<int>())
        | "Event" ->
            let event = root.["event"].AsObject()
            Event
                { Name = event.["name"].GetValue<string>()
                  Key = optionalString event "key"
                  Value = optionalString event "value" }
        | "EffectResult" ->
            let result = root.["result"].AsObject()

            match result.["kind"].GetValue<string>() with
            | "HttpResult" ->
                let correlationId = result.["correlationId"].GetValue<string>()
                let outcome = result.["outcome"].AsObject()

                let parsed =
                    match outcome.["kind"].GetValue<string>() with
                    | "Success" -> HttpSuccess(outcome.["status"].GetValue<int>())
                    | "Failure" -> HttpFailure(outcome.["reason"].GetValue<string>(), optionalInt outcome "status")
                    | "Cancelled" -> HttpCancelled
                    | "OutcomeUnknown" -> HttpOutcomeUnknown
                    | other -> failwithf "Unknown Http outcome '%s'." other

                HttpEffectResult(correlationId, parsed)
            | other ->
                failwithf "The Limen site engine requests only Http effects; received '%s'." other
        | "LocationChanged" -> LocationChanged
        | other -> failwithf "Unknown browser message '%s'." other

    let rec private viewNode value : JsonNode =
        match value with
        | VString text -> JsonValue.Create(text) :> JsonNode
        | VNumber number -> JsonValue.Create(number) :> JsonNode
        | VBool flag -> JsonValue.Create(flag) :> JsonNode
        | VItems items ->
            let array = JsonArray()

            for item in items do
                let itemObject = JsonObject()

                for KeyValue(key, itemValue) in item do
                    match itemValue with
                    | VItems _ -> failwith "View items must be flat."
                    | _ -> itemObject.[key] <- viewNode itemValue

                array.Add(itemObject)

            array :> JsonNode

    let private effectNode effect : JsonNode =
        let node = JsonObject()

        match effect with
        | HttpGet(correlationId, url, timeoutMs) ->
            node.["kind"] <- JsonValue.Create("Http")
            node.["correlationId"] <- JsonValue.Create(correlationId)
            node.["method"] <- JsonValue.Create("GET")
            node.["url"] <- JsonValue.Create(url)
            node.["timeoutMs"] <- JsonValue.Create(timeoutMs)

        node :> JsonNode

    let serializeMessage (message: EngineToBrowserMessage) =
        let root = JsonObject()
        let view = JsonObject()

        for KeyValue(key, value) in message.View do
            view.[key] <- viewNode value

        root.["view"] <- view

        let effects = JsonArray()
        for effect in message.Effects do
            effects.Add(effectNode effect)

        root.["effects"] <- effects

        let cancellations = JsonArray()
        for correlationId in message.Cancellations do
            cancellations.Add(JsonValue.Create(correlationId))

        root.["cancellations"] <- cancellations
        root.ToJsonString()
