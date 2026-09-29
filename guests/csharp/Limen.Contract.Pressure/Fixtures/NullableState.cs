// CS8602 (nullable analysis, an error here): an optional wire field is
// nullable in C#, so reading it without handling absence does not compile.
using Limen.Contract.Core;

namespace Limen.Contract.Pressure;

public static class NullableState
{
    public static int KeyLength(SemanticEvent semanticEvent) => semanticEvent.Key.Length;
}
