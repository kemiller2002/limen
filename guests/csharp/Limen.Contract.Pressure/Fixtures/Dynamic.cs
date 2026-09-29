// LIMEN002: dynamic and object dictionaries are untyped escape hatches.
using System.Collections.Generic;

namespace Limen.Contract.Pressure;

public static class Dynamic
{
    public static object? Read(dynamic message) => message.kind;

    public static Dictionary<string, object> Loose() => new();
}
