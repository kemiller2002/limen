// How an engine is expected to handle contract unions in C#: the generated
// Match, one handler per variant. A new variant in the contract adds a
// parameter, so this file stops compiling until it is handled.

using Limen.Contract.Core;

namespace Limen.Contract.Pressure;

public static class Consumer
{
    public static string DescribeOutcome(EffectOutcome outcome) => outcome.Match(
        success: value => "success " + value.Status,
        failure: value => value.Reason.Match(network: () => "network", aborted: () => "aborted", invalidResponse: () => "invalid response", tooLarge: () => "too large"),
        cancelled: _ => "cancelled",
        outcomeUnknown: value => value.Reason.Match(timeoutAfterDispatch: () => "unknown (timed out): reconcile before retrying", connectionLost: () => "unknown (connection lost): reconcile before retrying"));

    public static string DescribeResult(EffectResult result) => result.Match(
        httpResult: value => DescribeOutcome(value.Outcome),
        storageResult: _ => "storage",
        clipboardResult: _ => "clipboard",
        navigationResult: _ => "navigation",
        capabilityResult: _ => "capability");
}
