// The .NET WebAssembly export for the C# engine: forwards one serialized
// Limen message and returns the serialized response. Marshalling only.

using System.Runtime.InteropServices.JavaScript;
using System.Runtime.Versioning;

return;

[SupportedOSPlatform("browser")]
public static partial class LimenMinimal
{
    [JSExport]
    internal static string Dispatch(string messageJson) => Limen.Minimal.Dispatch.Handle(messageJson);
}
