using System.Runtime.InteropServices.JavaScript;

// .NET's JSExport source generator is a Roslyn/C# boundary.
// This file contains no application rule, state, transition or projection.
// It forwards one serialized Limen message to the F# engine and returns the
// serialized result.
return;

public partial class LimenSiteWasm
{
    [JSExport]
    internal static string Dispatch(string messageJson) =>
        Limen.Site.Engine.Dispatch.handle(messageJson);
}
