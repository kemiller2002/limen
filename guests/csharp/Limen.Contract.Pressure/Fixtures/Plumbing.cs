// LIMEN003: the wire plumbing is not an application API.
using System.Text.Json;

namespace Limen.Contract.Pressure;

public static class Plumbing
{
    public static string Raw(JsonElement element) => Limen.Contract.Wire.String(element, "$");
}
