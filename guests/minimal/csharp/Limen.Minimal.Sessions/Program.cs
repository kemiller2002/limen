// The C# minimal engine against the normative session vectors.

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;

static string Repository(DirectoryInfo directory) =>
    File.Exists(Path.Combine(directory.FullName, "contract", "core.contract.json")) ? directory.FullName : Repository(directory.Parent!);

static bool Same(JsonNode? left, JsonNode? right) => (left, right) switch
{
    (null, null) => true,
    (null, _) or (_, null) => false,
    (JsonObject a, JsonObject b) => a.Count == b.Count && a.All(pair => b.ContainsKey(pair.Key) && Same(pair.Value, b[pair.Key])),
    (JsonArray a, JsonArray b) => a.Count == b.Count && a.Zip(b).All(pair => Same(pair.First, pair.Second)),
    var (a, b) when a.GetValueKind() == JsonValueKind.Number && b.GetValueKind() == JsonValueKind.Number =>
        double.Parse(a.ToJsonString(), CultureInfo.InvariantCulture) == double.Parse(b.ToJsonString(), CultureInfo.InvariantCulture),
    var (a, b) => a.ToJsonString() == b.ToJsonString(),
};

var root = Repository(new DirectoryInfo(AppContext.BaseDirectory));
var text = File.ReadAllText(Path.Combine(root, "conformance", "sessions", "minimal.session.json")).Replace("{{core.fingerprint}}", Limen.Contract.Core.Contract.Fingerprint);
var sessions = JsonNode.Parse(text)!["sessions"]!.AsArray();

var failures = sessions.SelectMany(session =>
{
    Limen.Minimal.Dispatch.Reset();
    var name = session!["name"]!.GetValue<string>();
    return session["steps"]!.AsArray().Select((step, index) =>
    {
        var actual = JsonNode.Parse(Limen.Minimal.Dispatch.Handle(step!["send"]!.ToJsonString()));
        return Same(actual, step["expect"]) ? null : $"{name}, step {index + 1}:\n  expected {step["expect"]!.ToJsonString()}\n  actual   {actual!.ToJsonString()}";
    }).ToArray();
}).OfType<string>().ToArray();

var steps = sessions.Sum(session => session!["steps"]!.AsArray().Count);
if (failures.Length == 0)
{
    Console.WriteLine($"C# minimal engine: all {steps} steps of {sessions.Count} sessions match.");
    return 0;
}
Console.Error.WriteLine($"C# minimal engine disagrees on {failures.Length} step(s):\n{string.Join("\n", failures)}");
return 1;
