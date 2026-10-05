/// The consumer verify and Limen's own guardrail are one rule set.
///
/// `architecture/boundary-rules.json` is embedded into the CLI; the repository
/// guardrail (tools/guardrails/boundary.ts) reads the same file. These tests
/// prove the embedded copy is that file, byte for byte, and run the shared
/// fixtures that test/boundary-rules.test.ts also runs through the TypeScript
/// implementation, so the two matchers cannot drift apart.
module Limen.Core.Tests.BoundaryRulesTests

open System
open System.IO
open System.Text.Json
open Xunit
open Limen.Core

/// The repository root, found by walking up from the test assembly.
let private repositoryRoot =
    lazy
        (let rec ascend (directory: DirectoryInfo) =
            if File.Exists(Path.Combine(directory.FullName, "architecture", "boundary-rules.json")) then
                directory.FullName
            else
                match Option.ofObj directory.Parent with
                | Some parent -> ascend parent
                | None -> failwith "architecture/boundary-rules.json not found above the test assembly"

         ascend (DirectoryInfo AppContext.BaseDirectory))

let private fromRoot (relative: string) = Path.Combine(repositoryRoot.Force(), relative)

[<Fact>]
let ``the embedded rule set is architecture/boundary-rules.json byte for byte`` () =
    let onDisk =
        Security.Cryptography.SHA256.HashData(File.ReadAllBytes(fromRoot "architecture/boundary-rules.json"))
        |> Array.map (fun b -> b.ToString("x2"))
        |> String.concat ""

    Assert.Equal(onDisk, Boundary.ruleSetSha256 ())

[<Fact>]
let ``the embedded rule set parses and covers every language`` () =
    let rules = Boundary.rules ()
    Assert.Equal(1, rules.SchemaVersion)

    for language in Boundary.Language.all do
        Assert.True(rules.Authority.ContainsKey language, sprintf "no authority tokens for %s" (Boundary.Language.key language))

type private Case =
    { Name: string
      Engine: bool
      Path: string
      Source: string
      Expect: (string * string) list }

let private cases =
    lazy
        (use document = JsonDocument.Parse(File.ReadAllText(fromRoot "test/fixtures/boundary-rules/cases.json"))

         [ for case in document.RootElement.GetProperty("cases").EnumerateArray() ->
               { Name = case.GetProperty("name").GetString()
                 Engine = case.GetProperty("side").GetString() = "engine"
                 Path = case.GetProperty("path").GetString()
                 Source = case.GetProperty("source").GetString()
                 Expect =
                   [ for pair in case.GetProperty("expect").EnumerateArray() ->
                         pair.[0].GetString(), pair.[1].GetString() ] } ])

[<Fact>]
let ``the CLI matcher agrees with every shared fixture`` () =
    let rules = Boundary.rules ()

    let mismatches =
        cases.Force()
        |> List.choose (fun case ->
            let actual =
                Boundary.findings rules case.Engine case.Path case.Source
                |> List.map (fun (rule, token) -> Boundary.Rule.id rule, token)

            if actual = case.Expect then None else Some(sprintf "%s: expected %A, got %A" case.Name case.Expect actual))

    Assert.True(List.length (cases.Force()) >= 30, "the shared fixture set shrank")
    Assert.True(List.isEmpty mismatches, String.concat "\n" mismatches)
