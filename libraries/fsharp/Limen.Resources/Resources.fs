// Limen resources: the F# reference implementation of the language-neutral
// semantics in conformance/resources/README.md (kemiller2002/limen#22).
//
// Two patterns, both plain engine state with no hidden cache and no renderer
// state: a read that is loading, ready, refreshing over its previous value,
// failed or uncertain; and optimistic mutations layered over the confirmed
// value until the server answers. Every command is a pure transition that
// returns the next state, what to ask the kernel for, and — when nothing
// changed — why. Reads and mutations are different things and are modelled
// separately: a mutation is never treated as a read.
namespace Limen.Resources

[<RequireQualifiedAccess>]
type ReadOutcome =
    | Success of value: string
    | Failure of reason: string
    | Cancelled
    /// The read was dispatched and no answer came (OutcomeUnknown). For a read
    /// this is uncertainty, not failure: nothing changed on the server.
    | Unknown

[<RequireQualifiedAccess>]
type ReadState =
    | NotRequested
    | Loading of request: string
    | Ready of value: string
    | Refreshing of request: string * previous: string
    | Failed of reason: string * previous: string option
    | Uncertain of previous: string option

[<RequireQualifiedAccess>]
type ReadEmitted =
    | Fetch of request: string
    | Cancel of request: string

type Read = private { State: ReadState; Requests: int }

module Read =
    let initial = { State = ReadState.NotRequested; Requests = 0 }

    let state (read: Read) = read.State

    /// What the user can see: the value, or the previous value kept during a
    /// refresh, a failure or an uncertain answer.
    let visible (read: Read) =
        match read.State with
        | ReadState.Ready value
        | ReadState.Refreshing(_, value) -> Some value
        | ReadState.Failed(_, previous)
        | ReadState.Uncertain previous -> previous
        | ReadState.NotRequested
        | ReadState.Loading _ -> None

    let inFlight (read: Read) =
        match read.State with
        | ReadState.Loading request
        | ReadState.Refreshing(request, _) -> Some request
        | _ -> None

    /// A new request supersedes one in flight: the old one is cancelled and
    /// its answer, should it still arrive, is stale.
    let request (read: Read) =
        let id = $"r{read.Requests + 1}"
        let superseded = inFlight read |> Option.map ReadEmitted.Cancel |> Option.toList
        let next =
            match visible read with
            | Some previous -> ReadState.Refreshing(id, previous)
            | None -> ReadState.Loading id
        { State = next; Requests = read.Requests + 1 }, superseded @ [ ReadEmitted.Fetch id ], None

    let private settleCancelled (read: Read) =
        match read.State with
        | ReadState.Refreshing(_, previous) -> { read with State = ReadState.Ready previous }
        | _ -> { read with State = ReadState.NotRequested }

    let cancel (read: Read) =
        match inFlight read with
        | None -> read, [], Some "nothing-in-flight"
        | Some request -> settleCancelled read, [ ReadEmitted.Cancel request ], None

    let result (request: string) (outcome: ReadOutcome) (read: Read) =
        if inFlight read <> Some request then read, [], Some "stale"
        else
            let previous = visible read
            let next =
                match outcome with
                | ReadOutcome.Success value -> { read with State = ReadState.Ready value }
                | ReadOutcome.Failure reason -> { read with State = ReadState.Failed(reason, previous) }
                | ReadOutcome.Cancelled -> settleCancelled read
                | ReadOutcome.Unknown -> { read with State = ReadState.Uncertain previous }
            next, [], None

[<RequireQualifiedAccess>]
type MutationStatus =
    | Pending
    | Superseded
    /// Dispatched, no answer (OutcomeUnknown): kept, and still shown, until
    /// the engine reconciles it. Never rolled back silently.
    | Unresolved
    | SupersededUnresolved

type Mutation = { Id: string; Sequence: int; Key: string; Value: string; Status: MutationStatus }

type Notice = { Id: string; Key: string; Reason: string }

[<RequireQualifiedAccess>]
type MutationOutcome =
    | Confirmed of value: string
    | Rejected of reason: string
    | Failed
    | Unknown

[<RequireQualifiedAccess>]
type OptimisticEmitted = Send of id: string * key: string * value: string

type Optimistic =
    private
        { Confirmed: Map<string, string>
          ConfirmedSequence: Map<string, int>
          Mutations: Mutation list
          Notices: Notice list
          Next: int }

module Optimistic =
    let load (values: Map<string, string>) =
        { Confirmed = values; ConfirmedSequence = Map.empty; Mutations = []; Notices = []; Next = 0 }

    let confirmed (store: Optimistic) = store.Confirmed
    let mutations (store: Optimistic) = store.Mutations
    let notices (store: Optimistic) = store.Notices

    let private current (mutation: Mutation) =
        mutation.Status = MutationStatus.Pending || mutation.Status = MutationStatus.Unresolved

    /// The confirmed values with each key's newest un-superseded mutation on top.
    let displayed (store: Optimistic) =
        store.Mutations
        |> List.filter current
        |> List.fold (fun values mutation -> Map.add mutation.Key mutation.Value values) store.Confirmed

    /// A new intent for a key supersedes every earlier one for that key,
    /// explicitly: they stay listed, marked, until their answers arrive.
    let propose (key: string) (value: string) (store: Optimistic) =
        let id = $"m{store.Next + 1}"
        let supersede (mutation: Mutation) =
            if mutation.Key <> key then mutation
            else
                match mutation.Status with
                | MutationStatus.Pending -> { mutation with Status = MutationStatus.Superseded }
                | MutationStatus.Unresolved -> { mutation with Status = MutationStatus.SupersededUnresolved }
                | _ -> mutation
        let added = { Id = id; Sequence = store.Next + 1; Key = key; Value = value; Status = MutationStatus.Pending }
        { store with Mutations = (store.Mutations |> List.map supersede) @ [ added ]; Next = store.Next + 1 },
        [ OptimisticEmitted.Send(id, key, value) ],
        None

    /// A confirmation never regresses a key: an older mutation confirmed after
    /// a newer one does not overwrite it.
    let private confirm (mutation: Mutation) (value: string) (store: Optimistic) =
        let newer = store.ConfirmedSequence |> Map.tryFind mutation.Key |> Option.exists (fun sequence -> sequence > mutation.Sequence)
        if newer then store
        else { store with Confirmed = Map.add mutation.Key value store.Confirmed; ConfirmedSequence = Map.add mutation.Key mutation.Sequence store.ConfirmedSequence }

    let private without (mutation: Mutation) (store: Optimistic) =
        { store with Mutations = store.Mutations |> List.filter (fun m -> m.Id <> mutation.Id) }

    /// Only the user's current intent produces a notice; a superseded one was
    /// already replaced by the user.
    let private notify (mutation: Mutation) reason (store: Optimistic) =
        if current mutation then { store with Notices = store.Notices @ [ { Id = mutation.Id; Key = mutation.Key; Reason = reason } ] } else store

    let result (id: string) (outcome: MutationOutcome) (store: Optimistic) =
        match store.Mutations |> List.tryFind (fun m -> m.Id = id) with
        | None -> store, [], Some "unknown-mutation"
        | Some mutation when mutation.Status = MutationStatus.Unresolved || mutation.Status = MutationStatus.SupersededUnresolved -> store, [], Some "not-pending"
        | Some mutation ->
            let next =
                match outcome with
                | MutationOutcome.Confirmed value -> store |> confirm mutation value |> without mutation
                | MutationOutcome.Rejected reason -> store |> notify mutation reason |> without mutation
                | MutationOutcome.Failed -> store |> notify mutation "failed" |> without mutation
                | MutationOutcome.Unknown ->
                    let status = if mutation.Status = MutationStatus.Superseded then MutationStatus.SupersededUnresolved else MutationStatus.Unresolved
                    { store with Mutations = store.Mutations |> List.map (fun m -> if m.Id = id then { m with Status = status } else m) }
            next, [], None

    /// The engine learned what happened to an unresolved mutation.
    let reconcile (id: string) (applied: bool) (value: string option) (store: Optimistic) =
        match store.Mutations |> List.tryFind (fun m -> m.Id = id) with
        | Some mutation when mutation.Status = MutationStatus.Unresolved || mutation.Status = MutationStatus.SupersededUnresolved ->
            let next =
                if applied then store |> confirm mutation (value |> Option.defaultValue mutation.Value) |> without mutation
                else store |> notify mutation "not-applied" |> without mutation
            next, [], None
        | _ -> store, [], Some "not-unresolved"

    /// An authoritative snapshot from the server. Pending and unresolved
    /// mutations stay: a refresh is evidence, not a reconciliation.
    let refresh (values: Map<string, string>) (store: Optimistic) =
        { store with Confirmed = values |> Map.fold (fun acc key value -> Map.add key value acc) store.Confirmed }, [], None

    let dismiss (id: string) (store: Optimistic) =
        { store with Notices = store.Notices |> List.filter (fun notice -> notice.Id <> id) }, [], None
