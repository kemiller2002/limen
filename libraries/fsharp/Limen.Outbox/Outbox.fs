/// The F# reference implementation of Limen's offline outbox semantics
/// (kemiller2002/limen#40, LCP-034). conformance/outbox/README.md states the
/// rules and outbox.vectors.json states them as data.
///
/// An outbox is ordinary engine state: the user's pending domain operations,
/// in order, each with an idempotency id the engine chose. It sends one at a
/// time, only while online. A conflict or an unknown outcome stops the queue
/// until the engine decides; nothing is resent on its own, and an unknown
/// outcome is never treated as a failure. The engine persists the outbox with
/// its own storage; restoring it after a reload turns anything that was in
/// flight into unknown, because a reload loses the answer.
///
/// Pure: no browser, no clock, no I/O.
namespace Limen.Outbox

[<RequireQualifiedAccess>]
type OperationStatus =
    | Queued
    | Sending
    /// The server refused it against a newer version; the engine resolves.
    | Conflict of version: string
    /// Dispatched with no answer: it may or may not have been applied.
    | Unknown

type Operation = { Id: string; Kind: string; Payload: string; Status: OperationStatus }

type Notice = { Id: string; Reason: string }

[<RequireQualifiedAccess>]
type Outcome =
    | Confirmed
    | Rejected of reason: string
    | Conflict of version: string
    /// Known not applied (the request never reached the server).
    | Failed
    | Unknown

[<RequireQualifiedAccess>]
type Resolution =
    | Discard
    | Replace of payload: string

[<RequireQualifiedAccess>]
type Emitted = Send of id: string * kind: string * payload: string

type Outbox =
    private
        { Online: bool
          Held: bool
          Operations: Operation list
          Notices: Notice list }

module Outbox =
    /// A fresh outbox is offline until connectivity says otherwise.
    let empty = { Online = false; Held = false; Operations = []; Notices = [] }

    let online (outbox: Outbox) = outbox.Online
    let held (outbox: Outbox) = outbox.Held
    let operations (outbox: Outbox) = outbox.Operations
    let notices (outbox: Outbox) = outbox.Notices

    let private blocking (operation: Operation) =
        match operation.Status with
        | OperationStatus.Queued -> false
        | OperationStatus.Sending
        | OperationStatus.Conflict _
        | OperationStatus.Unknown -> true

    /// Sends the head of the queue when, and only when, nothing is in flight or
    /// awaiting the engine, the browser is online, and no failure holds it.
    let private pump (outbox: Outbox) =
        match outbox.Operations with
        | head :: _ when outbox.Online && not outbox.Held && not (outbox.Operations |> List.exists blocking) ->
            { outbox with Operations = outbox.Operations |> List.map (fun o -> if o.Id = head.Id then { o with Status = OperationStatus.Sending } else o) },
            [ Emitted.Send(head.Id, head.Kind, head.Payload) ]
        | _ -> outbox, []

    let private settled (outbox: Outbox) =
        let next, emitted = pump outbox
        next, emitted, None

    let private ignoring reason (outbox: Outbox) = outbox, [], Some reason

    let private find id (outbox: Outbox) = outbox.Operations |> List.tryFind (fun o -> o.Id = id)

    let private replace (operation: Operation) (outbox: Outbox) =
        { outbox with Operations = outbox.Operations |> List.map (fun o -> if o.Id = operation.Id then operation else o) }

    let private remove id (outbox: Outbox) =
        { outbox with Operations = outbox.Operations |> List.filter (fun o -> o.Id <> id) }

    let private notify id reason (outbox: Outbox) =
        { outbox with Notices = outbox.Notices @ [ { Id = id; Reason = reason } ] }

    /// A new user intent, identified by an id the engine chose; the id is the
    /// idempotency key every send of it carries.
    let enqueue (id: string) (kind: string) (payload: string) (outbox: Outbox) =
        match find id outbox with
        | Some _ -> ignoring "duplicate-operation" outbox
        | None -> settled { outbox with Operations = outbox.Operations @ [ { Id = id; Kind = kind; Payload = payload; Status = OperationStatus.Queued } ] }

    /// Evidence from the browser. Going offline cancels nothing: an operation
    /// in flight still gets its answer. Coming online releases a hold.
    let connectivity (isOnline: bool) (outbox: Outbox) =
        if isOnline then settled { outbox with Online = true; Held = false }
        else { outbox with Online = false }, [], None

    /// The engine's decision to try again after a failure.
    let flush (outbox: Outbox) =
        if not outbox.Online then ignoring "offline" outbox else settled { outbox with Held = false }

    let result (id: string) (outcome: Outcome) (outbox: Outbox) =
        match find id outbox with
        | None -> ignoring "unknown-operation" outbox
        | Some operation when operation.Status <> OperationStatus.Sending -> ignoring "not-sending" outbox
        | Some operation ->
            match outcome with
            | Outcome.Confirmed -> outbox |> remove id |> settled
            | Outcome.Rejected reason -> outbox |> remove id |> notify id reason |> settled
            | Outcome.Conflict version -> replace { operation with Status = OperationStatus.Conflict version } outbox, [], None
            | Outcome.Failed -> { (replace { operation with Status = OperationStatus.Queued } outbox) with Held = true }, [], None
            | Outcome.Unknown -> replace { operation with Status = OperationStatus.Unknown } outbox, [], None

    /// The engine learned whether an unknown operation was applied. Not
    /// applied sends it again, with the same id.
    let reconcile (id: string) (applied: bool) (outbox: Outbox) =
        match find id outbox with
        | Some operation when operation.Status = OperationStatus.Unknown ->
            if applied then outbox |> remove id |> settled
            else settled (replace { operation with Status = OperationStatus.Queued } outbox)
        | _ -> ignoring "not-unknown" outbox

    /// The engine's decision about a conflict: drop the intent, or send a
    /// rebased payload in its place, with the same id.
    let resolve (id: string) (resolution: Resolution) (outbox: Outbox) =
        match find id outbox with
        | Some operation ->
            match operation.Status, resolution with
            | OperationStatus.Conflict _, Resolution.Discard -> outbox |> remove id |> notify id "discarded" |> settled
            | OperationStatus.Conflict _, Resolution.Replace payload -> settled (replace { operation with Payload = payload; Status = OperationStatus.Queued } outbox)
            | _ -> ignoring "not-conflict" outbox
        | None -> ignoring "not-conflict" outbox

    /// Rebuilds the outbox the engine persisted. It starts offline, and an
    /// operation that was in flight is unknown: the reload lost its answer.
    let restore (persisted: Operation list) =
        let recovered (operation: Operation) =
            if operation.Status = OperationStatus.Sending then { operation with Status = OperationStatus.Unknown } else operation
        { empty with Operations = persisted |> List.map recovered }, [], None

    let dismiss (id: string) (outbox: Outbox) =
        { outbox with Notices = outbox.Notices |> List.filter (fun notice -> notice.Id <> id) }, [], None
