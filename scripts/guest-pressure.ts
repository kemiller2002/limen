// Compile-time pressure in every guest language (kemiller2002/limen#55).
//
// 1. The C# analyzer's negative fixtures each fail with their own rule.
// 2. In a scratch copy, the contract gains one union variant and one enum
//    value; bindings are regenerated; the F#, C# and Rust reference consumers
//    (which compile today) must each fail to compile, naming the gap.
//
// This is what "adding a variant forces every guest to handle it" means,
// demonstrated rather than asserted. Needs .NET SDK 8 and cargo.

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "../tools/contract-gen/main.ts";

const ROOT = process.cwd();

type Expectation = { readonly name: string; readonly command: string; readonly args: readonly string[]; readonly cwd: string; readonly mustFailWith: RegExp };

const run = (expectation: Expectation): string | undefined => {
  const result = spawnSync(expectation.command, expectation.args, { cwd: expectation.cwd, encoding: "utf8", env: { ...process.env, DOTNET_NOLOGO: "1" } });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0) return `${expectation.name}: compiled, but must fail with ${expectation.mustFailWith}`;
  return expectation.mustFailWith.test(output) ? undefined : `${expectation.name}: failed, but not with ${expectation.mustFailWith}:\n${output.split("\n").filter((line) => /error/.test(line)).slice(0, 8).join("\n")}`;
};

const dotnetBuild = (project: string, ...extra: readonly string[]): readonly string[] => ["build", project, "--nologo", "-v", "q", ...extra];

const analyzerFixtures: readonly Expectation[] = [
  ["SwitchOnUnion", /error LIMEN001/],
  ["SwitchOnEnum", /error LIMEN001/],
  ["Dynamic", /error LIMEN002/],
  ["Plumbing", /error LIMEN003/],
  ["NullableState", /error CS8602/],
].map(([fixture, pattern]) => ({
  name: `C# fixture ${String(fixture)}`,
  command: "dotnet",
  args: dotnetBuild("guests/csharp/Limen.Contract.Pressure", `-p:Fixture=${String(fixture)}`),
  cwd: ROOT,
  mustFailWith: pattern as RegExp,
}));

const withAddedVariant = async (): Promise<string> => {
  const scratch = await mkdtemp(join(tmpdir(), "limen-pressure-"));
  const skip = (source: string): boolean => /\/(bin|obj|target)(\/|$)/.test(source);
  await Promise.all([
    cp(join(ROOT, "contract"), join(scratch, "contract"), { recursive: true }),
    cp(join(ROOT, "architecture/layers.json"), join(scratch, "architecture/layers.json")),
    cp(join(ROOT, "test/fixtures/capabilities"), join(scratch, "test/fixtures/capabilities"), { recursive: true }),
    cp(join(ROOT, "guests"), join(scratch, "guests"), { recursive: true, filter: (source) => !skip(source) }),
  ]);
  const path = join(scratch, "contract/core.contract.json");
  const contract = JSON.parse(await readFile(path, "utf8")) as { types: { name: string; values?: string[]; variants?: unknown[] }[] };
  const types = contract.types.map((type) => {
    if (type.name === "EffectOutcome") return { ...type, variants: [...(type.variants ?? []), { name: "Throttled", fields: [] }] };
    if (type.name === "HttpFailureReason") return { ...type, values: [...(type.values ?? []), "rate-limited"] };
    return type;
  });
  await writeFile(path, JSON.stringify({ ...contract, types }, null, 2));
  await generate(scratch);
  return scratch;
};

const scratch = await withAddedVariant();
try {
  const pressure: readonly Expectation[] = [
    { name: "F# consumer after an added variant", command: "dotnet", args: dotnetBuild("guests/fsharp/Limen.Contract.Pressure"), cwd: scratch, mustFailWith: /error FS0025/ },
    { name: "C# consumer after an added variant", command: "dotnet", args: dotnetBuild("guests/csharp/Limen.Contract.Pressure"), cwd: scratch, mustFailWith: /error CS7036/ },
    { name: "Rust consumer after an added variant", command: "cargo", args: ["build", "--offline", "--quiet", "--manifest-path", "guests/rust/limen-contract/Cargo.toml", "--example", "consumer"], cwd: scratch, mustFailWith: /error\[E0004\]/ },
  ];
  const baseline: readonly Expectation[] = [
    { name: "F# consumer today", command: "dotnet", args: dotnetBuild("guests/fsharp/Limen.Contract.Pressure"), cwd: ROOT, mustFailWith: /$^/ },
  ];
  const failures = [
    ...analyzerFixtures.map(run),
    ...pressure.map(run),
    // The consumers must compile against the real contract, or the pressure
    // above proves nothing.
    ...baseline.map((expectation) => {
      const result = spawnSync(expectation.command, expectation.args, { cwd: expectation.cwd, encoding: "utf8" });
      return result.status === 0 ? undefined : `${expectation.name}: does not compile against the current contract`;
    }),
    ...[["dotnet", dotnetBuild("guests/csharp/Limen.Contract.Pressure")], ["cargo", ["build", "--quiet", "--manifest-path", "guests/rust/limen-contract/Cargo.toml", "--example", "consumer"]]].map(([command, args]) => {
      const result = spawnSync(String(command), args as string[], { cwd: ROOT, encoding: "utf8" });
      return result.status === 0 ? undefined : `${String(command)} consumer does not compile against the current contract`;
    }),
  ].filter((failure): failure is string => failure !== undefined);
  if (failures.length > 0) {
    console.error(`Guest compile-pressure checks failed:\n${failures.join("\n")}`);
    process.exitCode = 1;
  } else {
    console.log(`Guest compile pressure holds: ${analyzerFixtures.length} C# analyzer fixtures rejected; an added variant breaks the F#, C# and Rust consumers; all three compile against the current contract.`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
