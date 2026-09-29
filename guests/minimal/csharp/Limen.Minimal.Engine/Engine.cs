// The minimal engine: a capability probe, specified language-neutrally in
// conformance/sessions/minimal-engine.md. Pure state and transitions over
// immutable records; every union is handled with its generated Match.

using System.Collections.Generic;
using System.Collections.Immutable;
using System.Linq;
using Limen.Contract.Core;
using Limen.Guest;

namespace Limen.Minimal;

public sealed record Entry(int Id, string Text);

public abstract record State
{
    private State() { }

    public sealed record Ready(ImmutableList<Entry> Log, int LastId, int Next, ImmutableDictionary<string, string> Pending) : State;
    public sealed record Incompatible : State;

    public static State Initial { get; } = new Ready(ImmutableList<Entry>.Empty, 0, 1, ImmutableDictionary<string, string>.Empty);
}

public static class Engine
{
    private const int LogLimit = 20;

    private static State.Ready Record(State.Ready state, string text)
    {
        var log = state.Log.Add(new Entry(state.LastId + 1, text));
        return state with { Log = log.Count > LogLimit ? log.RemoveRange(0, log.Count - LogLimit) : log, LastId = state.LastId + 1 };
    }

    public static IReadOnlyDictionary<string, ViewValue> Project(State state) => state is State.Ready ready
        ? new Dictionary<string, ViewValue>
        {
            ["status"] = new ViewValue.Text("ready"),
            ["count"] = new ViewValue.Number(ready.Log.Count),
            ["log"] = new ViewValue.Items(ready.Log.Select(entry => (IReadOnlyDictionary<string, ViewPrimitive>)new Dictionary<string, ViewPrimitive>
            {
                ["id"] = new ViewPrimitive.Text(entry.Id.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                ["text"] = new ViewPrimitive.Text(entry.Text),
            }).ToArray()),
        }
        : new Dictionary<string, ViewValue> { ["status"] = new ViewValue.Text("incompatible"), ["count"] = new ViewValue.Number(0), ["log"] = new ViewValue.Items(new IReadOnlyDictionary<string, ViewPrimitive>[0]) };

    private static EffectRequest? Request(string label, CorrelationId id) => label switch
    {
        "http-ok" => new EffectRequest.Http(new HttpEffectRequest(id, HttpMethod.Get, "/ok.json", null, null, 5000)),
        "http-missing" => new EffectRequest.Http(new HttpEffectRequest(id, HttpMethod.Get, "/missing.json", null, null, 5000)),
        "storage-set" => new EffectRequest.Storage(new StorageEffectRequest.Set(id, "limen-minimal", "saved")),
        "storage-get" => new EffectRequest.Storage(new StorageEffectRequest.Get(id, "limen-minimal")),
        "clipboard" => new EffectRequest.Clipboard(new ClipboardEffectRequest(id, "limen")),
        "nav-push" => new EffectRequest.Navigation(new NavigationEffectRequest.Push(id, "?screen=two")),
        "nav-away" => new EffectRequest.Navigation(new NavigationEffectRequest.Push(id, "https://example.org/elsewhere")),
        _ => null,
    };

    public static string Describe(EffectResult result) => result.Match(
        httpResult: http => http.Outcome.Match(
            success: success => "success " + success.Status,
            failure: failure => "failure " + failure.Reason.ToWire() + (failure.Status is long status ? " " + status : ""),
            cancelled: _ => "cancelled",
            outcomeUnknown: _ => "unknown"),
        storageResult: storage => storage.Outcome.Match(
            success: success => "success " + (success.Value ?? "null"),
            failure: failure => "failure " + failure.Reason.ToWire()),
        clipboardResult: clipboard => clipboard.Outcome.Match(
            success: _ => "success",
            failure: failure => "failure " + failure.Reason.ToWire()),
        navigationResult: navigation => navigation.Outcome.Match(
            success: success => "success " + success.Location.Path + success.Location.Query,
            dispatched: _ => "dispatched",
            failure: failure => "failure " + failure.Reason.ToWire()),
        capabilityResult: _ => "unexpected capability result");

    private static string CorrelationOf(EffectResult result) => result.Match(
        httpResult: value => value.CorrelationId.Value,
        storageResult: value => value.CorrelationId.Value,
        clipboardResult: value => value.CorrelationId.Value,
        navigationResult: value => value.CorrelationId.Value,
        capabilityResult: value => value.CorrelationId.Value);

    private static (State, EngineToBrowserMessage) Respond(State state, IReadOnlyList<EffectRequest> effects, EngineHandshake? handshake) =>
        (state, new EngineToBrowserMessage(Project(state), effects, new CorrelationId[0], handshake));

    private static readonly EffectRequest[] None = new EffectRequest[0];

    /// <summary>One transition: the state after the message, and the response to send.</summary>
    public static (State, EngineToBrowserMessage) Handle(State state, BrowserToEngineMessage message)
    {
        if (state is not State.Ready ready) return Respond(state, None, null);
        return message.Match(
            initialize: initialize => Handshake.Answer(initialize.Handshake, Requirements.CoreOnly).Match(
                accepted: accepted => Respond(Record(ready, "ready"), None, accepted),
                rejected: rejected => Respond(new State.Incompatible(), None, rejected)),
            @event: semanticEvent =>
            {
                var correlationId = "c" + ready.Next;
                var effect = Request(semanticEvent.EventValue.Name, new CorrelationId(correlationId));
                if (effect is null) return Respond(Record(ready, "ignored " + semanticEvent.EventValue.Name), None, null);
                var recorded = Record(ready, "requested " + semanticEvent.EventValue.Name);
                return Respond(recorded with { Next = ready.Next + 1, Pending = ready.Pending.Add(correlationId, semanticEvent.EventValue.Name) }, new[] { effect }, null);
            },
            effectResult: effectResult =>
            {
                var correlationId = CorrelationOf(effectResult.Result);
                if (!ready.Pending.TryGetValue(correlationId, out var label)) return Respond(Record(ready, "stale " + correlationId), None, null);
                var recorded = Record(ready, label + ": " + Describe(effectResult.Result));
                return Respond(recorded with { Pending = ready.Pending.Remove(correlationId) }, None, null);
            },
            locationChanged: moved => Respond(Record(ready, "location " + moved.Location.Path + moved.Location.Query), None, null),
            capabilityFact: fact => Respond(Record(ready, "unexpected fact " + fact.Capability.Value), None, null));
    }
}
