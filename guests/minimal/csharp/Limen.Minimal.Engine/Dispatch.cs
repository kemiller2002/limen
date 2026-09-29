// The one stateful edge: holds the engine's state between WASM calls and
// speaks JSON through the generated codec. No decision is made here.

using Limen.Contract;
using Limen.Contract.Core;

namespace Limen.Minimal;

public static class Dispatch
{
    private static State state = State.Initial;

    public static string Handle(string json) => Codec.ParseBrowserToEngineMessage(json).Match(
        ok =>
        {
            var (next, response) = Engine.Handle(state, ok.Value);
            state = next;
            return Codec.SerializeEngineToBrowserMessage(response);
        },
        // A message outside the contract is a compatibility failure, not an
        // application event: the engine does not transition on it.
        failed => throw new System.InvalidOperationException("Browser message outside the Limen contract at " + failed.Error.Path + ": expected " + failed.Error.Expected + ", found " + failed.Error.Found));

    public static void Reset() => state = State.Initial;
}
