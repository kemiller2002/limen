// Limen's F# NuGet packages (LCP-044, LCP-079): packed in lockstep with
// package.json, checksummed, and proven in a clean room.
//
//   node --experimental-strip-types scripts/nuget-packages.ts pack [--out DIR]
//     dotnet pack every package at package.json's version into DIR
//     (default dist-nuget/), refuse a missing, extra or mis-versioned
//     package or a dependency outside FSharp.Core and Limen's own packages,
//     and write DIR/checksums.txt (sha256sum format).
//
//   node --experimental-strip-types scripts/nuget-packages.ts verify [--dir DIR]
//     check DIR/checksums.txt, then build a consumer from those .nupkg files
//     alone (an empty NuGet cache, only DIR and nuget.org as sources) that
//     selects limen.store through the handshake with the package's
//     fingerprint, has a mismatched fingerprint refused at the handshake, and
//     round-trips a store request through the package's codec. The package's
//     fingerprint must equal the TypeScript pack's (dist/, so build first).
//
// The publish workflow runs both before it attests and uploads the files.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const VERSION = (JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { readonly version: string }).version;

// Every package Limen releases, in dependency order.
export const PACKAGES: readonly { readonly id: string; readonly project: string }[] = [
  { id: "EchelonFoundry.Limen.Contract", project: "guests/fsharp/Limen.Contract/Limen.Contract.fsproj" },
  { id: "EchelonFoundry.Limen.Guest", project: "guests/fsharp/Limen.Guest/Limen.Guest.fsproj" },
  { id: "EchelonFoundry.Limen.Store", project: "libraries/fsharp/Limen.Store/Limen.Store.fsproj" },
  { id: "EchelonFoundry.Limen.Routing", project: "libraries/fsharp/Limen.Routing/Limen.Routing.fsproj" },
];

const ALLOWED_DEPENDENCIES = new Set(["FSharp.Core", ...PACKAGES.map((entry) => entry.id)]);

// The FSharp.Core the packages are built against, and so the lowest a
// consumer needs. Pinned at pack time so it does not drift with whichever SDK
// a runner has; 9.0 because a trimmed WebAssembly publish needs FSharp.Core
// 9.0 or later anyway (guests/minimal/fsharp/Limen.Minimal.Wasm, docs/27).
// A consumer whose SDK ships a newer one simply uses that.
const FSHARP_CORE = "9.0.100";

const option = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(name);
  return resolve(ROOT, index >= 0 ? process.argv[index + 1] ?? fallback : fallback);
};

const run = (command: string, args: readonly string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env): string =>
  execFileSync(command, args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "inherit"] });

const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");

// The .nuspec inside a .nupkg (a zip), read with unzip.
const nuspecOf = (nupkg: string, id: string): string => run("unzip", ["-p", nupkg, `${id}.nuspec`]);

const problemsOf = (id: string, nuspec: string): readonly string[] => {
  const version = /<version>([^<]+)<\/version>/.exec(nuspec)?.[1];
  const dependencies = [...nuspec.matchAll(/<dependency id="([^"]+)" version="([^"]+)"/g)].map((match) => ({ id: match[1] ?? "", version: match[2] ?? "" }));
  return [
    ...(version === VERSION ? [] : [`${id}: version ${String(version)}, not package.json's ${VERSION}`]),
    ...dependencies.filter((dependency) => !ALLOWED_DEPENDENCIES.has(dependency.id)).map((dependency) => `${id}: depends on ${dependency.id}, outside FSharp.Core and Limen's packages`),
    ...dependencies.filter((dependency) => dependency.id.startsWith("EchelonFoundry.Limen.") && dependency.version !== VERSION).map((dependency) => `${id}: depends on ${dependency.id} ${dependency.version}, not ${VERSION} (lockstep)`),
    ...(/<license type="expression">MIT<\/license>/.test(nuspec) ? [] : [`${id}: no MIT license expression`]),
    ...dependencies.filter((dependency) => dependency.id === "FSharp.Core" && dependency.version !== FSHARP_CORE).map((dependency) => `${id}: depends on FSharp.Core ${dependency.version}, not the pinned ${FSHARP_CORE}`),
  ];
};

const pack = async (): Promise<void> => {
  const out = option("--out", "dist-nuget");
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  for (const entry of PACKAGES) {
    run("dotnet", ["pack", entry.project, "-c", "Release", "--nologo", "-v", "q", `-p:Version=${VERSION}`, `-p:FSharpCoreImplicitPackageVersion=${FSHARP_CORE}`, "-p:ContinuousIntegrationBuild=true", "-o", out]);
  }
  const files = (await readdir(out)).filter((name) => name.endsWith(".nupkg")).sort();
  const expected = PACKAGES.map((entry) => `${entry.id}.${VERSION}.nupkg`).sort();
  const problems = [
    ...expected.filter((name) => !files.includes(name)).map((name) => `missing ${name}`),
    ...files.filter((name) => !expected.includes(name)).map((name) => `unexpected ${name}`),
    ...PACKAGES.filter((entry) => files.includes(`${entry.id}.${VERSION}.nupkg`)).flatMap((entry) => problemsOf(entry.id, nuspecOf(join(out, `${entry.id}.${VERSION}.nupkg`), entry.id))),
  ];
  if (problems.length > 0) {
    console.error(`The F# packages are not releasable:\n${problems.join("\n")}`);
    process.exit(1);
  }
  const lines = await Promise.all(expected.map(async (name) => `${await sha256(join(out, name))}  ${name}`));
  await writeFile(join(out, "checksums.txt"), `${lines.join("\n")}\n`);
  console.log(`Packed ${expected.length} F# packages at ${VERSION} into ${out}:\n${lines.join("\n")}`);
};

const CONSUMER_PROJECT = (version: string): string => `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
    <OtherFlags>$(OtherFlags) --warnaserror:25</OtherFlags>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Program.fs" />
  </ItemGroup>
  <ItemGroup>
    <PackageReference Include="EchelonFoundry.Limen.Contract" Version="[${version}]" />
    <PackageReference Include="EchelonFoundry.Limen.Guest" Version="[${version}]" />
    <PackageReference Include="EchelonFoundry.Limen.Store" Version="[${version}]" />
    <PackageReference Include="EchelonFoundry.Limen.Routing" Version="[${version}]" />
  </ItemGroup>
</Project>
`;

const CONSUMER_PROGRAM = `module Program

open Limen.Routing
open Limen.Contract.Core
open Limen.Contract.Store
open Limen.Guest.Handshake

let store : CapabilityOffer =
    { Id = CapabilityId Limen.Contract.Store.Contract.Unit
      Version = Limen.Contract.Store.Contract.Version
      Fingerprint = Limen.Contract.Store.Contract.Fingerprint }

let requirements = { coreOnly with Required = [ store ] }

let hostOffering (capabilities: CapabilityOffer list) : HostHandshake option =
    Some { Protocol = requirements.Protocol; Contract = requirements.Contract; Capabilities = capabilities }

// EchelonFoundry.Limen.Routing (LCP-110): a table, a typed codec over the
// application's own union, a return target, and the route inventory, which
// the verifier compares byte for byte with the TypeScript library's.
type View =
    | Home
    | Invoice of id: int64 * tab: string

let routingTable =
    RouteTable.define
        [ Route.create "home" ""
          { Route.create "invoices" "invoices" with
              Query = [ QueryParam.optional "status" (ParamType.Set [ "open"; "paid" ]) ]
              Children =
                [ { Route.create "invoice" "{id:int}" with
                      Query = [ QueryParam.optional "tab" (ParamType.Enum [ "summary"; "history" ]) |> QueryParam.withDefault (Value.Text "summary") ] } ] }
          { Route.create "signIn" "sign-in" with ReturnTarget = false; Query = [ QueryParam.optional ReturnTo.parameter ParamType.String ] }
          Route.create "notFound" "{*rest}" ]
        [ { Path = "bills/{id:int}"; To = "invoices.invoice"; Params = [ "id", Template.FromParam "id" ] } ]
        { Home = "home"; SignIn = Some "signIn"; NotFound = Some "notFound" }

let toTarget view : Target =
    match view with
    | Home -> { Route = "home"; Params = Map.empty; Query = Map.empty }
    | Invoice(id, tab) -> { Route = "invoices.invoice"; Params = Map [ "id", Value.Integer id ]; Query = Map [ "tab", Value.Text tab ] }

let ofMatch (matched: Match) =
    match matched.Route, (List.last matched.Chain).Params.TryFind "id", matched.Query.TryFind "tab" with
    | "home", _, _ -> Ok Home
    | "invoices.invoice", Some(Value.Integer id), Some(Value.Text tab) -> Ok(Invoice(id, tab))
    | route, _, _ -> Error("unmapped " + route)

let routing () =
    match routingTable with
    | Error _ -> false
    | Ok table ->
        let codec = RouteCodec.create table toTarget ofMatch
        let parsed = RouteCodec.parse codec Router.allowAll "/bills/42?tab=history" = Ok(Invoice(42L, "history"))
        let formatted = RouteCodec.format codec (Invoice(42L, "summary")) = Ok "/invoices/42"
        let notFound = RouteCodec.parse codec Router.allowAll "/nowhere" = Error RouteError.NotFound
        let signIn = ReturnTo.signIn table (ReturnTo.capture table "/invoices/42?tab=history") = Ok "/sign-in?returnTo=%2Finvoices%2F42%3Ftab%3Dhistory"
        System.IO.File.WriteAllText("routes.json", Inventory.render LocationMode.Hash table)
        parsed && formatted && notFound && signIn

[<EntryPoint>]
let main _ =
    let selected =
        match answer (hostOffering [ store ]) requirements with
        | EngineHandshake.Accepted(_, _, capabilities) -> capabilities = [ store ]
        | EngineHandshake.Rejected _ -> false
    let mismatchRefused =
        match answer (hostOffering [ { store with Fingerprint = "sha256:" + String.replicate 64 "0" } ]) requirements with
        | EngineHandshake.Rejected(HandshakeRejection.CapabilityUnavailable _) -> true
        | _ -> false
    let request =
        StoreRequest.Open("queue", 1L, [ { Name = "entries"; KeyPath = ""; KeyPaths = Some [ "ns"; "seq" ]; Indexes = [] } ], [])
    let roundTrip =
        match Codec.parseStoreRequest (Codec.serializeStoreRequest request) with
        | Ok decoded -> decoded = request
        | Error _ -> false
    // The functional library builds the same request and offers the same
    // capability identity.
    let library =
        Limen.Store.Store.capability = store
        && (Limen.Store.Schema.create "queue" 1L [ { Name = "entries"; KeyPath = Limen.Store.KeyPath.Compound [ "ns"; "seq" ]; Indexes = [] } ] []
            |> Result.map Limen.Store.Store.openRequest) = Ok request
    System.Console.WriteLine(Limen.Contract.Store.Contract.Fingerprint)
    System.Console.WriteLine(if selected then "selected" else "NOT SELECTED")
    System.Console.WriteLine(if mismatchRefused then "mismatch-refused" else "MISMATCH ACCEPTED")
    System.Console.WriteLine(if roundTrip then "round-trip" else "ROUND-TRIP FAILED")
    System.Console.WriteLine(if library then "library" else "LIBRARY DISAGREES")
    let routed = routing ()
    System.Console.WriteLine(if routed then "routing" else "ROUTING FAILED")
    if selected && mismatchRefused && roundTrip && library && routed then 0 else 1
`;

// The same table as the consumer's, through the TypeScript library: the two
// inventories must be the same bytes (LCP-107).
type RoutingModule = {
  readonly defineRoutes: (definition: unknown) => { readonly ok: boolean; readonly value?: unknown };
  readonly renderRouteInventory: (table: unknown, mode: "hash" | "path") => string;
};
const sameInventory = async (fsharpPath: string): Promise<readonly string[]> => {
  const routing = await import(join(ROOT, "dist/routing/index.js")) as RoutingModule;
  const defined = routing.defineRoutes({
    routes: [
      { name: "home", path: "" },
      {
        name: "invoices", path: "invoices", query: [{ name: "status", type: "set", values: ["open", "paid"] }],
        children: [{ name: "invoice", path: "{id:int}", query: [{ name: "tab", type: "enum", values: ["summary", "history"], default: "summary" }] }],
      },
      { name: "signIn", path: "sign-in", returnTarget: false, query: [{ name: "returnTo", type: "string" }] },
      { name: "notFound", path: "{*rest}" },
    ],
    legacy: [{ path: "bills/{id:int}", to: "invoices.invoice", params: { id: "{id}" } }],
    roles: { home: "home", signIn: "signIn", notFound: "notFound" },
  });
  if (!defined.ok) return ["the TypeScript library refuses the clean room's route table"];
  const typescript = routing.renderRouteInventory(defined.value, "hash");
  const fsharp = await readFile(fsharpPath, "utf8").catch(() => "");
  return fsharp === typescript ? [] : [`the packaged F# route inventory differs from the TypeScript library's:\n${fsharp}\n---\n${typescript}`];
};

const verify = async (): Promise<void> => {
  const dir = option("--dir", "dist-nuget");
  const sums = (await readFile(join(dir, "checksums.txt"), "utf8")).trim().split("\n").map((line) => line.split(/\s+/) as [string, string]);
  const bad = (await Promise.all(sums.map(async ([digest, name]) => ((await sha256(join(dir, name))) === digest ? [] : [name])))).flat();
  if (bad.length > 0 || sums.length !== PACKAGES.length) {
    console.error(`checksums.txt does not match: ${bad.join(", ") || `${String(sums.length)} entries for ${String(PACKAGES.length)} packages`}`);
    process.exit(1);
  }
  const room = await mkdtemp(join(tmpdir(), "limen-nuget-clean-room-"));
  try {
    await writeFile(join(room, "nuget.config"), `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="limen-release" value="${dir}" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
  <packageSourceMapping>
    <packageSource key="limen-release"><package pattern="EchelonFoundry.Limen.*" /></packageSource>
    <packageSource key="nuget.org"><package pattern="*" /></packageSource>
  </packageSourceMapping>
</configuration>
`);
    await writeFile(join(room, "Consumer.fsproj"), CONSUMER_PROJECT(VERSION));
    await writeFile(join(room, "Program.fs"), CONSUMER_PROGRAM);
    // An empty package cache: nothing but the .nupkg files and nuget.org.
    const env = { ...process.env, NUGET_PACKAGES: join(room, "packages"), DOTNET_CLI_TELEMETRY_OPTOUT: "1" };
    const output = run("dotnet", ["run", "--project", join(room, "Consumer.fsproj"), "-c", "Release", "--nologo"], room, env).trim().split("\n").map((line) => line.trim());
    const { STORE_CAPABILITY_V2 } = await import(join(ROOT, "dist/capabilities/store/index.js")) as { readonly STORE_CAPABILITY_V2: { readonly fingerprint: string } };
    const problems = [
      ...(output[0] === STORE_CAPABILITY_V2.fingerprint ? [] : [`the package's limen.store fingerprint ${String(output[0])} differs from the TypeScript pack's ${STORE_CAPABILITY_V2.fingerprint}`]),
      ...output.slice(1).filter((line) => line !== "selected" && line !== "mismatch-refused" && line !== "round-trip" && line !== "library" && line !== "routing"),
      ...(output.includes("routing") ? [] : ["the routing check did not run"]),
      ...(await sameInventory(join(room, "routes.json"))),
    ];
    if (problems.length > 0) {
      console.error(`The clean-room consumer failed:\n${problems.join("\n")}`);
      process.exit(1);
    }
    console.log(`Clean room: a consumer built from the ${String(PACKAGES.length)} packages alone selects limen.store ${STORE_CAPABILITY_V2.fingerprint} (the TypeScript pack's), has a mismatched fingerprint refused at the handshake, round-trips a store request, builds the same request through EchelonFoundry.Limen.Store, and through EchelonFoundry.Limen.Routing parses and formats a typed route, carries a return target through sign-in and renders a route inventory byte-identical to @echelon-foundry/limen/routing's.`);
  } finally {
    await rm(room, { recursive: true, force: true });
  }
};

const command = process.argv[2];
if (command === "pack") await pack();
else if (command === "verify") await verify();
else if (command !== undefined) {
  console.error("usage: nuget-packages.ts pack [--out DIR] | verify [--dir DIR]");
  process.exit(2);
}
