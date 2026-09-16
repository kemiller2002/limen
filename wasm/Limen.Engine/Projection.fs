/// State → ViewState. Pure, total, and the only thing the DOM ever sees.
///
/// Every capability the view needs is projected explicitly — whether a button
/// is disabled, which choice reads as pressed, what the verdict says. None of
/// it is re-derived from the DOM, which is the habit the whole architecture is
/// trying to make unnecessary.
module Limen.Engine.Projection

open Limen.Engine.Protocol
open Limen.Engine.Domain

let private choiceLabel placement =
    match placement with
    | Html -> "HTML"
    | Css -> "CSS"
    | Kernel -> "Limen kernel"
    | EngineSide -> "Engine"
    | Effect -> "Effect request"

let private placementId placement =
    match placement with
    | Html -> "html" | Css -> "css" | Kernel -> "kernel"
    | EngineSide -> "engine" | Effect -> "effect"

let private saveName save =
    match save with
    | SaveIdle -> "Idle" | Editing -> "Editing" | Saving -> "Saving"
    | Saved -> "Saved" | SaveFailed _ -> "SaveFailed"

let private saveTone save =
    match save with
    | Saved -> "ok"
    | SaveFailed _ -> "bad"
    | SaveIdle | Editing | Saving -> "warn"

let private saveHint save =
    match save with
    | SaveIdle -> "Nothing started. Advance to begin editing."
    | Editing -> "Editing. The only legal next step is Saving."
    | Saving -> "In flight. It can succeed or fail — not both."
    | Saved -> "Done. There is no way to also be failed."
    | SaveFailed reason -> reason

let private loadName load =
    match load with
    | LoadIdle -> "Idle" | Loading _ -> "Loading" | Loaded _ -> "Loaded"
    | Rejected _ -> "Rejected" | LoadOutcomeUnknown -> "OutcomeUnknown"

let private loadTone load =
    match load with
    | Loaded _ -> "ok"
    | Rejected _ | LoadOutcomeUnknown -> "bad"
    | LoadIdle | Loading _ -> "warn"

let private scenarioLabel scenario =
    match scenario with
    | SuccessCase -> "success" | NotFound -> "notFound" | InvalidBody -> "invalid"
    | NetworkDown -> "network" | TimedOut -> "timeout"

let private loadMessage load =
    match load with
    | LoadIdle -> "Nothing requested yet. Pick a scenario."
    | Loading(_, scenario) -> sprintf "Requesting the %s scenario…" (scenarioLabel scenario)
    | Loaded count -> sprintf "Loaded %d record(s)." count
    | Rejected(reason, _) -> reason
    | LoadOutcomeUnknown ->
        "Timed out after dispatch. The request may or may not have reached the server — which is why this is not reported as a failure."

/// Four independent booleans, and the point being made: nothing prevents the
/// incoherent combinations, so every reader has to invent a meaning for them.
let private flagVerdict (flags: Flags) =
    let on =
        [ if flags.IsLoading then "isLoading"
          if flags.IsSaving then "isSaving"
          if flags.HasError then "hasError"
          if flags.IsComplete then "isComplete" ]
    match on with
    | [] -> "Nothing set. Which is also a state nobody named — is that Idle, or not started?", "warn"
    | [ single ] -> sprintf "Only %s is set. This one happens to be coherent." single, "ok"
    | many ->
        sprintf "%s are all true at once. Nothing prevents this, and every reader must now decide what it means."
            (String.concat " + " many), "bad"

let project (state: State) : ViewState =
    let verdictText, verdictTone = flagVerdict state.Flags
    let task = List.tryItem state.TaskIndex placementTasks
    let revealed = state.Picked.IsSome
    let right =
        match state.Picked, task with
        | Some picked, Some t -> picked = t.Answer
        | _ -> false

    [ // The install command and its copy button. Every one of these is a
      // decision the engine made — including the button's label and whether
      // it is available.
      "installCommand", VString installCommand
      "copyLabel", VString(match state.Copy with Copied -> "Copied" | Copying -> "Copying…" | _ -> "Copy")
      "copyBusy", VBool(state.Copy = Copying)
      "copySucceeded", VBool(state.Copy = Copied)
      "copyFailed", VBool(match state.Copy with CopyFailed _ -> true | _ -> false)
      "copyError", VString(match state.Copy with CopyFailed reason -> reason | _ -> "")

      // Demo 1 — counter and the live trace.
      "counter", VInt state.Counter
      "decrementDisabled", VBool(state.Counter = 0)
      "resetDisabled", VBool(state.Counter = 0)
      "trace",
      VItems(
          state.Trace
          |> List.map (fun entry ->
              [ "id", VString(string entry.Id)
                "event", VString entry.Event
                "command", VString entry.Command
                "from", VString entry.From
                "to", VString entry.To
                "effect", VString entry.Effect ]))
      "hasTrace", VBool(not (List.isEmpty state.Trace))
      "traceEmpty", VBool(List.isEmpty state.Trace)
      "traceCount", VInt(List.length state.Trace)

      // Demo 2 — booleans versus an explicit union.
      "isLoading", VBool state.Flags.IsLoading
      "isSaving", VBool state.Flags.IsSaving
      "hasError", VBool state.Flags.HasError
      "isComplete", VBool state.Flags.IsComplete
      "flagVerdict", VString verdictText
      "flagTone", VString verdictTone
      "saveState", VString(saveName state.Save)
      "saveTone", VString(saveTone state.Save)
      "saveHint", VString(saveHint state.Save)
      "advanceDisabled", VBool(match state.Save with Saved | SaveFailed _ -> true | _ -> false)
      "failDisabled", VBool(state.Save <> Saving)

      // Demo 3 — effects, and all four outcomes.
      "loadState", VString(loadName state.Load)
      "loadTone", VString(loadTone state.Load)
      "loadMessage", VString(loadMessage state.Load)
      "loadBusy", VBool(match state.Load with Loading _ -> true | _ -> false)
      "canRetryLoad", VBool(match state.Load with Rejected(_, retryable) -> retryable | _ -> false)
      "needsReconciliation", VBool(state.Load = LoadOutcomeUnknown)

      // Demo 4 — where does this code go?
      "taskPrompt", VString(task |> Option.map (fun t -> t.Prompt) |> Option.defaultValue "")
      "taskNumber", VInt(state.TaskIndex + 1)
      "taskTotal", VInt(List.length placementTasks)
      "choices",
      VItems(
          [ Html; Css; Kernel; EngineSide; Effect ]
          |> List.map (fun placement ->
              [ "id", VString(placementId placement)
                "label", VString(choiceLabel placement)
                // The engine says which button reads as pressed. The DOM does
                // not track it.
                "pressed", VBool(state.Picked = Some placement) ]))
      "revealed", VBool revealed
      "verdictText",
      VString(
          match revealed, task with
          | false, _ | _, None -> ""
          | true, Some t ->
              if right then sprintf "Correct — %s" t.Because
              else sprintf "Not quite. %s — %s" (choiceLabel t.Answer) t.Because)
      "verdictTone", VString(if not revealed then "warn" elif right then "ok" else "bad")
      "scoreText", VString(sprintf "%d of %d so far" state.Correct state.Answered)
      "nextDisabled", VBool(not revealed) ]
