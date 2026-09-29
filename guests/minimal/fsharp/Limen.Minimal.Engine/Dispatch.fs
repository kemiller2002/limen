/// The one stateful edge: holds the engine's state between WASM calls and
/// speaks JSON through the generated codec. No decision is made here.
module Limen.Minimal.Dispatch

open Limen.Contract.Core

let mutable private state = Engine.initial

let private incompatibleWireData (error: Limen.Contract.DecodeError) =
    // A message outside the contract is a compatibility failure, not an
    // application event: the engine does not transition on it.
    failwith $"Browser message outside the Limen contract at {error.Path}: expected {error.Expected}, found {error.Found}"

let handle (json: string) : string =
    match Codec.parseBrowserToEngineMessage json with
    | Error error -> incompatibleWireData error
    | Ok message ->
        let next, response = Engine.handle state message
        state <- next
        Codec.serializeEngineToBrowserMessage response

let reset () = state <- Engine.initial
