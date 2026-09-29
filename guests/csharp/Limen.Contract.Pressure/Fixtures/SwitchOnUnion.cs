// LIMEN001: compiles without the analyzer, and silently maps any future
// variant to "failed".
using Limen.Contract.Core;

namespace Limen.Contract.Pressure;

public static class SwitchOnUnion
{
    public static string Describe(EffectOutcome outcome) => outcome switch
    {
        EffectOutcome.Success => "ok",
        _ => "failed",
    };
}
