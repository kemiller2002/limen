// The C# binding's side of the shared semantic vectors in
// conformance/vectors/. TypeScript, F# and Rust run the same file.

using System;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Limen.Contract;

static string Repository(DirectoryInfo directory) =>
    File.Exists(Path.Combine(directory.FullName, "contract", "core.contract.json")) ? directory.FullName : Repository(directory.Parent!);

var root = Repository(new DirectoryInfo(AppContext.BaseDirectory));
JsonNode ReadJson(string relative) => JsonNode.Parse(File.ReadAllText(Path.Combine(root, relative)))!;

// Canonical form: ordinal-sorted keys, every "doc" removed, no whitespace —
// the rule the generator applies. ASCII strings escaped as JSON.stringify does.
static string Quote(string text) =>
    "\"" + string.Concat(text.Select(character => character switch
    {
        '"' => "\\\"",
        '\\' => "\\\\",
        '\n' => "\\n",
        '\r' => "\\r",
        '\t' => "\\t",
        '\b' => "\\b",
        '\f' => "\\f",
        < ' ' => "\\u" + ((int)character).ToString("x4", CultureInfo.InvariantCulture),
        _ => character.ToString(),
    })) + "\"";

static string Canonical(JsonNode? node) => node switch
{
    null => "null",
    JsonObject record => "{" + string.Join(",", record.Where(pair => pair.Key != "doc").OrderBy(pair => pair.Key, StringComparer.Ordinal).Select(pair => Quote(pair.Key) + ":" + Canonical(pair.Value))) + "}",
    JsonArray items => "[" + string.Join(",", items.Select(Canonical)) + "]",
    _ when node.GetValueKind() == JsonValueKind.String => Quote(node.GetValue<string>()),
    _ => node.ToJsonString(),
};

// Numbers compare by value: 200 and 200.0 are the same wire number.
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

string? Check(JsonNode vector)
{
    var name = vector["name"]!.GetValue<string>();
    var typeName = vector["type"]!.GetValue<string>();
    var valid = vector["valid"]!.GetValue<bool>();
    using var document = JsonDocument.Parse(vector["json"]?.ToJsonString() ?? "null");
    if (!Limen.Contract.Core.Conformance.RoundTrips.TryGetValue(typeName, out var roundTrip)) return $"{name}: no generated decoder for {typeName}";
    return roundTrip(document.RootElement).Match(
        ok => !valid ? $"{name}: decoded a vector that must be rejected"
            : Same(ok.Value, vector["json"]) ? null : $"{name}: round trip changed the value: {ok.Value?.ToJsonString()}",
        failed => valid ? $"{name}: rejected a valid vector at {failed.Error.Path} ({failed.Error.Expected})"
            : failed.Error.Path == vector["errorPath"]!.GetValue<string>() ? null : $"{name}: rejected at {failed.Error.Path} instead of {vector["errorPath"]}");
}

var fingerprint = "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(Canonical(ReadJson("contract/core.contract.json"))))).ToLowerInvariant();
var vectors = ReadJson("conformance/vectors/core.vectors.json")["vectors"]!.AsArray();
var failures = (Limen.Contract.Core.Contract.Fingerprint == fingerprint ? Array.Empty<string>() : new[] { $"fingerprint: binding carries {Limen.Contract.Core.Contract.Fingerprint}, contract computes to {fingerprint}" })
    .Concat(vectors.Select(vector => Check(vector!)).OfType<string>())
    .ToArray();

if (failures.Length == 0)
{
    Console.WriteLine($"C# binding: fingerprint agrees and all {vectors.Count} shared vectors pass.");
    return 0;
}
Console.Error.WriteLine($"C# binding disagrees on {failures.Length} check(s):\n{string.Join("\n", failures)}");
return 1;
