// LIMEN001 on a generated enum: a default arm swallows new values.
using Limen.Contract.Core;

namespace Limen.Contract.Pressure;

public static class SwitchOnEnum
{
    public static bool Retryable(ClipboardFailureReason reason)
    {
        switch (reason)
        {
            case ClipboardFailureReason.Denied: return true;
            default: return false;
        }
    }
}
