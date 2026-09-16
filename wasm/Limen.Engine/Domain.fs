/// The Limen site's application engine, in F#.
///
/// A port of `site/app/engine.ts`, kept deliberately close to it so the two can
/// be read side by side. Everything here is pure: state, legal transitions, and
/// a projection. No browser API, no JS interop, no I/O.
///
/// What F# adds over the TypeScript original is not behaviour but enforcement.
/// `match` over a discriminated union is exhaustive *by the compiler*, with no
/// `assertNever` idiom to remember to write — the guarantee the architecture
/// asks for, checked by the language rather than by discipline.
module Limen.Engine.Domain

open Limen.Engine.Protocol

// ---------------------------------------------------------------------------
// Authoritative state
// ---------------------------------------------------------------------------

/// Demo 3's five scenarios. Each is a genuinely different real request, so the
/// outcome classification on show is the real one.
type Scenario =
    | SuccessCase
    | NotFound
    | InvalidBody
    | NetworkDown
    | TimedOut

type LoadState =
    | LoadIdle
    | Loading of CorrelationId * Scenario
    | Loaded of count: int
    | Rejected of reason: string * retryable: bool
    | LoadOutcomeUnknown

/// Demo 2's explicit model — the one that cannot represent nonsense.
type SaveState =
    | SaveIdle
    | Editing
    | Saving
    | Saved
    | SaveFailed of reason: string

/// Demo 2's straw man — four independent booleans, sixteen combinations, and
/// nothing preventing the incoherent ones.
type Flags =
    { IsLoading: bool
      IsSaving: bool
      HasError: bool
      IsComplete: bool }

type Placement =
    | Html
    | Css
    | Kernel
    | EngineSide
    | Effect

type CopyState =
    | CopyIdle
    | Copying
    | Copied
    | CopyFailed of reason: string

type TraceEntry =
    { Id: int
      /// The inbound message as the visitor saw it — an event name (with its
      /// item key, where there was one), or "EffectResult". Bound by
      /// `data-text="event"` in the site markup.
      Event: string
      Command: string
      From: string
      To: string
      Effect: string }

type State =
    { Counter: int
      Save: SaveState
      Load: LoadState
      Flags: Flags
      TaskIndex: int
      Picked: Placement option
      Answered: int
      Correct: int
      Trace: TraceEntry list
      Copy: CopyState
      Sequence: int }

let initialState =
    { Counter = 0
      Save = SaveIdle
      Load = LoadIdle
      Flags = { IsLoading = false; IsSaving = false; HasError = false; IsComplete = false }
      TaskIndex = 0
      Picked = None
      Answered = 0
      Correct = 0
      Trace = []
      Copy = CopyIdle
      Sequence = 0 }

type PlacementTask =
    { Prompt: string
      Answer: Placement
      Because: string }

let placementTasks =
    [ { Prompt = "Decide whether an invoice may be submitted"; Answer = EngineSide
        Because = "A legality rule is application meaning. It belongs in a transition, not in a disabled attribute." }
      { Prompt = "Change the spacing above a button"; Answer = Css
        Because = "Pure presentation. It never crosses the boundary — no projection, no round trip." }
      { Prompt = "Read a saved draft from local storage"; Answer = Effect
        Because = "The engine cannot touch storage. It requests a Storage effect; the kernel performs it." }
      { Prompt = "Add a heading and a labelled input"; Answer = Html
        Because = "Document structure. Add data-* bindings only where the engine must drive it." }
      { Prompt = "Remember that a save is in flight"; Answer = EngineSide
        Because = "Anything the application would behave differently because of is authoritative state." }
      { Prompt = "POST the form to the server"; Answer = Effect
        Because = "The engine returns an EffectRequest. It never calls fetch itself." }
      { Prompt = "Turn a click into an application event"; Answer = Kernel
        Because = "Carrying a DOM event across the boundary is exactly the kernel's job — and all it does." }
      { Prompt = "Work out whether Save should be available"; Answer = EngineSide
        Because = "A capability is projected by the engine, never re-derived by the DOM or by CSS." } ]

let installCommand = "npm install @echelon-foundry/typescript-wasm-kernel"

// ---------------------------------------------------------------------------
// Commands — the closed vocabulary
// ---------------------------------------------------------------------------

type Command =
    | Increment
    | Decrement
    | ResetCounter
    | ClearTrace
    | ToggleFlag of string
    | AdvanceSave
    | FailSave
    | ResetSave
    | Load of Scenario * CorrelationId
    | RecordLoad of CorrelationId * EffectOutcome
    | Pick of Placement
    | NextTask
    | CopyInstall of CorrelationId
    | RecordCopy of ClipboardOutcome

let private scenarioOf name =
    match name with
    | "loadSuccess" -> Some SuccessCase
    | "loadNotFound" -> Some NotFound
    | "loadInvalid" -> Some InvalidBody
    | "loadNetwork" -> Some NetworkDown
    | "loadTimeout" -> Some TimedOut
    | _ -> None

let private placementOf name =
    match name with
    | "html" -> Some Html
    | "css" -> Some Css
    | "kernel" -> Some Kernel
    | "engine" -> Some EngineSide
    | "effect" -> Some Effect
    | _ -> None

let private flagOf name =
    match name with
    | "toggleLoading" -> Some "isLoading"
    | "toggleSaving" -> Some "isSaving"
    | "toggleError" -> Some "hasError"
    | "toggleComplete" -> Some "isComplete"
    | _ -> None

/// Maps an event to a command. The engine never trusts an incoming name or
/// key — anything unrecognized is *refused*, never guessed at.
///
/// The refusal is a `Result`, not an exception: this function stays total and
/// pure, and the reason travels as ordinary data for the caller to act on.
/// `Engine.handle` is where it becomes loud, because a `data-event` naming an
/// event the engine does not have is a typo in the markup, and a typo that
/// silently does nothing is the worst way to find out — see
/// docs/02-getting-started.md and docs/16-troubleshooting.md. The TypeScript
/// engine rejects the same names for the same reason, and
/// `test/wasm.test.ts` requires the two to agree on which.
let eventToCommand (event: SemanticEvent) (correlationId: CorrelationId) : Result<Command, string> =
    match flagOf event.Name with
    | Some flag -> Ok(ToggleFlag flag)
    | None ->
        match scenarioOf event.Name with
        | Some scenario -> Ok(Load(scenario, correlationId))
        | None ->
            match event.Name with
            | "increment" -> Ok Increment
            | "decrement" -> Ok Decrement
            | "resetCounter" -> Ok ResetCounter
            | "clearTrace" -> Ok ClearTrace
            | "advanceSave" -> Ok AdvanceSave
            | "failSave" -> Ok FailSave
            | "resetSave" -> Ok ResetSave
            | "nextTask" -> Ok NextTask
            | "copyInstall" -> Ok(CopyInstall correlationId)
            // The choice arrives as a data-each item key — a string from the
            // DOM, so it is validated here rather than trusted.
            | "pick" ->
                let choice = event.Key |> Option.defaultValue ""
                match placementOf choice with
                | Some placement -> Ok(Pick placement)
                | None -> Error(sprintf "Unknown placement: %s" choice)
            | name -> Error(sprintf "Unrecognized event: %s" name)

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

type TransitionResult =
    { State: State
      Effects: EffectRequest list
      Step: (string * string * string * string) option }

/// A compact label for the trace's from/to columns.
let private describe (state: State) =
    let save =
        match state.Save with
        | SaveIdle -> "Idle" | Editing -> "Editing" | Saving -> "Saving"
        | Saved -> "Saved" | SaveFailed _ -> "SaveFailed"
    let load =
        match state.Load with
        | LoadIdle -> "Idle" | Loading _ -> "Loading" | Loaded _ -> "Loaded"
        | Rejected _ -> "Rejected" | LoadOutcomeUnknown -> "OutcomeUnknown"
    sprintf "counter=%d save=%s load=%s" state.Counter save load

let private scenarioRequest scenario =
    match scenario with
    | SuccessCase -> "./demo/customers.json", 5000
    | NotFound -> "./demo/no-such-file.json", 5000
    | InvalidBody -> "./demo/not-json.txt", 5000
    | NetworkDown -> "https://limen-demo-unreachable.invalid/customers.json", 5000
    // A 1 ms budget against a real file: the request is dispatched and then
    // aborted, which is precisely what OutcomeUnknown exists for.
    | TimedOut -> "./demo/customers.json", 1

let private scenarioName scenario =
    match scenario with
    | SuccessCase -> "success" | NotFound -> "notFound" | InvalidBody -> "invalid"
    | NetworkDown -> "network" | TimedOut -> "timeout"

let private outcomeLabel outcome =
    match outcome with
    | Success(status, _) -> sprintf "Success %d" status
    | Failure(reason, _) -> sprintf "Failure (%s)" reason
    | Cancelled -> "Cancelled"
    | OutcomeUnknown _ -> "OutcomeUnknown (timeout-after-dispatch)"

/// A count if the body was a JSON array; otherwise nothing. The engine decides
/// what a decoded body *means*; the kernel only parsed it.
let private decodeCount (body: Json.Value) =
    match body with
    | Json.JArray items -> Some(List.length items)
    | _ -> None

let private recordLoadOutcome outcome =
    match outcome with
    | Success(status, body) ->
        // A 404 arrives here too — the kernel got a response, so it is a
        // transport-level Success. What the status *means* is decided here.
        if status <> 200 then
            Rejected(sprintf "The server answered %d." status, status >= 500)
        else
            match decodeCount body with
            | Some count -> Loaded count
            | None -> Rejected("The response parsed, but was not the shape expected.", false)
    | Failure(reason, status) ->
        if reason = "network" then Rejected("Could not reach the server.", true)
        else
            match status with
            | Some code when code <> 200 ->
                Rejected(sprintf "The server answered %d, and its error body was not JSON." code, code >= 500)
            | _ -> Rejected("The response could not be read as JSON.", false)
    | Cancelled -> LoadIdle
    | OutcomeUnknown _ -> LoadOutcomeUnknown

let private copyFailureMessage reason =
    match reason with
    | "permission-denied" -> "Your browser blocked the copy. Select the command and copy it manually."
    | "not-secure-context" -> "Copying needs a secure (HTTPS) page. Select the command and copy it manually."
    | "unsupported" -> "This browser has no clipboard API. Select the command and copy it manually."
    | _ -> "The copy did not complete. Select the command and copy it manually."

let private commandName command =
    match command with
    | Increment -> "Increment" | Decrement -> "Decrement" | ResetCounter -> "ResetCounter"
    | ClearTrace -> "ClearTrace" | ToggleFlag _ -> "ToggleFlag" | AdvanceSave -> "AdvanceSave"
    | FailSave -> "FailSave" | ResetSave -> "ResetSave"
    | Load(scenario, _) -> sprintf "Load(%s)" (scenarioName scenario)
    | RecordLoad _ -> "RecordLoad" | Pick _ -> "Pick" | NextTask -> "NextTask"
    | CopyInstall _ -> "CopyInstall" | RecordCopy _ -> "RecordCopy"

let transition (state: State) (command: Command) : TransitionResult =
    let step next effect =
        { State = next
          Effects = []
          Step = Some(commandName command, describe state, describe next, effect) }
    let plain next = step next "—"
    let unchanged = { State = state; Effects = []; Step = None }

    match command with
    | Increment -> plain { state with Counter = state.Counter + 1 }
    | Decrement -> plain { state with Counter = max 0 (state.Counter - 1) }
    | ResetCounter -> plain { state with Counter = 0 }

    | ClearTrace -> { State = { state with Trace = [] }; Effects = []; Step = None }

    | ToggleFlag flag ->
        let flags =
            match flag with
            | "isLoading" -> { state.Flags with IsLoading = not state.Flags.IsLoading }
            | "isSaving" -> { state.Flags with IsSaving = not state.Flags.IsSaving }
            | "hasError" -> { state.Flags with HasError = not state.Flags.HasError }
            | _ -> { state.Flags with IsComplete = not state.Flags.IsComplete }
        plain { state with Flags = flags }

    // The legal path, and only the legal path. There is no arrangement of
    // these commands that reaches two of these states at once.
    | AdvanceSave ->
        match state.Save with
        | SaveIdle -> plain { state with Save = Editing }
        | Editing -> plain { state with Save = Saving }
        | Saving -> plain { state with Save = Saved }
        | Saved | SaveFailed _ -> unchanged

    | FailSave ->
        match state.Save with
        | Saving -> plain { state with Save = SaveFailed "The server rejected the change." }
        | _ -> unchanged

    | ResetSave -> plain { state with Save = SaveIdle }

    | Load(scenario, correlationId) ->
        match state.Load with
        // Loading twice at once is not a legal move.
        | Loading _ -> unchanged
        | _ ->
            let url, timeoutMs = scenarioRequest scenario
            let next = { state with Load = Loading(correlationId, scenario) }
            { State = next
              Effects = [ Http(correlationId, GET, url, timeoutMs) ]
              Step = Some(commandName command, describe state, describe next, sprintf "Http GET %s" url) }

    | RecordLoad(correlationId, outcome) ->
        // Stale-evidence guard: a result for a request we are no longer
        // waiting on is discarded rather than allowed to overwrite newer state.
        match state.Load with
        | Loading(pending, _) when pending = correlationId ->
            let next = { state with Load = recordLoadOutcome outcome }
            { State = next
              Effects = []
              Step = Some("RecordLoad", describe state, describe next, sprintf "← %s" (outcomeLabel outcome)) }
        | _ -> unchanged

    | Pick choice ->
        match state.Picked, List.tryItem state.TaskIndex placementTasks with
        | None, Some task ->
            plain { state with
                      Picked = Some choice
                      Answered = state.Answered + 1
                      Correct = state.Correct + (if choice = task.Answer then 1 else 0) }
        | _ -> unchanged

    | NextTask ->
        match state.Picked with
        | None -> unchanged
        | Some _ ->
            plain { state with
                      TaskIndex = (state.TaskIndex + 1) % List.length placementTasks
                      Picked = None }

    // The install command's text lives here, in the engine, and is sent to the
    // browser as an effect. The button carries no text and no knowledge of the
    // clipboard.
    | CopyInstall correlationId ->
        match state.Copy with
        // Copying twice at once is not a legal move.
        | Copying -> unchanged
        | _ ->
            { State = { state with Copy = Copying }
              Effects = [ ClipboardWriteText(correlationId, installCommand) ]
              Step = Some("CopyInstall", describe state, "Copying", "Clipboard writeText") }

    | RecordCopy outcome ->
        let copy =
            match outcome with
            | ClipboardSuccess -> Copied
            | ClipboardFailure reason -> CopyFailed(copyFailureMessage reason)
        plain { state with Copy = copy }

/// Applies a transition and appends its trace entry. The trace is capped for
/// the same reason any log is: an unbounded list projected into the DOM on
/// every round trip is a slow leak.
let apply (state: State) (label: string) (result: TransitionResult) : State =
    match result.Step with
    | None -> result.State
    | Some(command, from, into, effect) ->
        let sequence = state.Sequence + 1
        let entry = { Id = sequence; Event = label; Command = command; From = from; To = into; Effect = effect }
        { result.State with
            Sequence = sequence
            Trace = (entry :: result.State.Trace) |> List.truncate 12 }
