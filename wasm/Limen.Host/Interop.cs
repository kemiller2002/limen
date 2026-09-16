using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

namespace Limen.Host;

/// <summary>
/// The only code in this assembly, and the only place the F# engine's world
/// touches JavaScript's.
///
/// It exists because <c>[JSExport]</c> is implemented by a C# Roslyn source
/// generator, and F# projects do not run Roslyn source generators — an F#
/// method carrying the attribute compiles and then registers nothing at all.
/// Verified, not assumed: a pure-F# build produced an empty exports object in
/// Chromium. See docs/26-fsharp-wasm-engine.md.
///
/// That constraint turned out to fit the architecture rather than fight it.
/// This shim marshals a string in and a string out. It holds no state, makes
/// no decision, and knows nothing about what a message means — the same
/// contract the TypeScript kernel has on the other side of the wire.
/// </summary>
[SupportedOSPlatform("browser")]
public static partial class Interop
{
    /// <summary>
    /// One round trip: a JSON <c>BrowserToEngineMessage</c> in, a JSON
    /// <c>EngineToBrowserMessage</c> out.
    /// </summary>
    /// <remarks>
    /// Exceptions are deliberately not caught here. A decode failure or a
    /// protocol violation must surface as a rejected <c>dispatch()</c> on the
    /// JavaScript side, which the kernel already handles as
    /// <c>BridgeError { phase: "dispatch" }</c>. Swallowing it here would turn
    /// a loud failure into a silently stale page.
    /// </remarks>
    [JSExport]
    internal static string Dispatch(string message) => Limen.Engine.Engine.handle(message);

    /// <summary>Resets engine state. For tests only.</summary>
    [JSExport]
    internal static void Reset() => Limen.Engine.Engine.reset();
}
