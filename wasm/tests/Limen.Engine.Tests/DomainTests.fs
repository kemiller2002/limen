/// Engine behaviour, tested without a browser and without WebAssembly.
///
/// This is half the argument for moving the engine out of the browser at all:
/// these are pure functions over discriminated unions, so the tests are
/// ordinary F# and run in milliseconds.
module Limen.Engine.Tests.DomainTests

open Xunit
open Limen.Engine.Json
open Limen.Engine.Protocol
open Limen.Engine.Domain
open Limen.Engine.Projection

let private run state command = transition state command

[<Fact>]
let ``the counter never goes below zero`` () =
    let state = (run initialState Decrement).State
    Assert.Equal(0, state.Counter)

[<Fact>]
let ``save advances only along the legal path`` () =
    let advance state = (run state AdvanceSave).State
    let editing = advance initialState
    let saving = advance editing
    let saved = advance saving
    Assert.Equal<SaveState>(Editing, editing.Save)
    Assert.Equal<SaveState>(Saving, saving.Save)
    Assert.Equal<SaveState>(Saved, saved.Save)
    // And stops. There is no arrangement of these commands reaching two
    // states at once — the union makes it unrepresentable.
    Assert.Equal<SaveState>(Saved, (advance saved).Save)

[<Fact>]
let ``a save can only fail while it is in flight`` () =
    Assert.Equal<SaveState>(SaveIdle, (run initialState FailSave).State.Save)
    let saving = { initialState with Save = Saving }
    match (run saving FailSave).State.Save with
    | SaveFailed _ -> ()
    | other -> failwithf "expected SaveFailed, got %A" other

[<Fact>]
let ``loading twice at once is refused`` () =
    let first = run initialState (Load(SuccessCase, CorrelationId "a"))
    Assert.Single(first.Effects) |> ignore
    let second = run first.State (Load(SuccessCase, CorrelationId "b"))
    Assert.Empty(second.Effects)
    Assert.True(second.Step.IsNone)

[<Fact>]
let ``a 404 is a transport Success, and the engine decides what it means`` () =
    // The kernel received a response, so it reports Success. Turning that into
    // "rejected" is an application decision, and this is where it happens.
    let loading = { initialState with Load = Loading(CorrelationId "c", NotFound) }
    let result = run loading (RecordLoad(CorrelationId "c", Success(404, JNull)))
    match result.State.Load with
    | Rejected(reason, retryable) ->
        Assert.Contains("404", reason)
        Assert.False(retryable, "a 404 is not worth retrying")
    | other -> failwithf "expected Rejected, got %A" other

[<Fact>]
let ``a 503 is retryable where a 404 is not`` () =
    let loading = { initialState with Load = Loading(CorrelationId "c", NotFound) }
    match (run loading (RecordLoad(CorrelationId "c", Success(503, JNull)))).State.Load with
    | Rejected(_, retryable) -> Assert.True retryable
    | other -> failwithf "expected Rejected, got %A" other

[<Fact>]
let ``a timeout is OutcomeUnknown, never a failure`` () =
    let loading = { initialState with Load = Loading(CorrelationId "c", TimedOut) }
    let result = run loading (RecordLoad(CorrelationId "c", OutcomeUnknown "timeout-after-dispatch"))
    Assert.Equal<LoadState>(LoadOutcomeUnknown, result.State.Load)
    // And the projection must not offer a retry: the request may already have
    // been acted on.
    let view = project result.State
    Assert.Contains(("needsReconciliation", VBool true), view)
    Assert.Contains(("canRetryLoad", VBool false), view)

[<Fact>]
let ``a result for a request we are no longer waiting on is discarded`` () =
    let loading = { initialState with Load = Loading(CorrelationId "current", SuccessCase) }
    let result = run loading (RecordLoad(CorrelationId "stale", Success(200, JArray [ JNull ])))
    // Stale evidence must never overwrite newer state.
    Assert.Equal<LoadState>(Loading(CorrelationId "current", SuccessCase), result.State.Load)
    Assert.True(result.Step.IsNone)

[<Fact>]
let ``a well-formed response of the wrong shape is rejected, not decoded`` () =
    let loading = { initialState with Load = Loading(CorrelationId "c", SuccessCase) }
    match (run loading (RecordLoad(CorrelationId "c", Success(200, JObject [])))).State.Load with
    | Rejected(reason, retryable) ->
        Assert.Contains("shape", reason)
        Assert.False retryable
    | other -> failwithf "expected Rejected, got %A" other

[<Fact>]
let ``copying twice at once is refused`` () =
    let first = run initialState (CopyInstall(CorrelationId "c1"))
    Assert.Single(first.Effects) |> ignore
    Assert.Empty((run first.State (CopyInstall(CorrelationId "c2"))).Effects)

[<Fact>]
let ``a refused copy becomes a sentence the visitor can act on`` () =
    let copying = { initialState with Copy = Copying }
    match (run copying (RecordCopy(ClipboardFailure "not-secure-context"))).State.Copy with
    | CopyFailed reason -> Assert.Contains("manually", reason)
    | other -> failwithf "expected CopyFailed, got %A" other

[<Fact>]
let ``the quiz scores one answer per question and will not double-count`` () =
    let task = List.head placementTasks
    let answered = (run initialState (Pick task.Answer)).State
    Assert.Equal(1, answered.Answered)
    Assert.Equal(1, answered.Correct)
    // A second pick before advancing changes nothing.
    let again = run answered (Pick Css)
    Assert.True(again.Step.IsNone)
    Assert.Equal(1, again.State.Answered)

[<Fact>]
let ``an unrecognized event is refused by name rather than guessed at`` () =
    let event = { Name = "somethingElse"; Key = None; Value = None }
    match eventToCommand event (CorrelationId "x") with
    // The reason names the event, because the thing that produced it is a
    // typo in an HTML attribute and the message is how anyone finds it.
    | Error reason -> Assert.Equal("Unrecognized event: somethingElse", reason)
    | Ok command -> failwithf "guessed a command: %A" command

[<Fact>]
let ``a pick with an unrecognized key is refused`` () =
    // The key is a string off the DOM. It is validated, never trusted.
    let event = { Name = "pick"; Key = Some "not-a-placement"; Value = None }
    match eventToCommand event (CorrelationId "x") with
    | Error reason -> Assert.Equal("Unknown placement: not-a-placement", reason)
    | Ok command -> failwithf "accepted an untrusted key: %A" command

[<Fact>]
let ``the trace is capped so it cannot grow without bound`` () =
    let mutable state = initialState
    for _ in 1..40 do
        state <- apply state "increment" (run state Increment)
    Assert.True(List.length state.Trace <= 12, "the trace is projected on every round trip")
