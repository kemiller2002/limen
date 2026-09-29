// Builds the three minimal engines to WebAssembly and assembles one served
// tree, dist-guests/, where guests/minimal/host/index.html?engine=fsharp|csharp|rust
// runs each through the same kernel:
//
//   dist-guests/dist/                          the package (npm run build)
//   dist-guests/ok.json                        what GET /ok.json answers
//   dist-guests/guests/minimal/host/           the page and main.js
//   dist-guests/guests/minimal/host/fsharp/    F# engine (.NET WebAssembly)
//   dist-guests/guests/minimal/host/csharp/    C# engine (.NET WebAssembly)
//   dist-guests/guests/minimal/host/rust/      Rust engine (raw wasm32)
//
// Needs .NET SDK 8 with the WebAssembly workload, and cargo with the
// wasm32-unknown-unknown target.

import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, "dist-guests");
const HOST = join(OUT, "guests/minimal/host");
const run = (command: string, args: readonly string[], cwd = ROOT): void => { execFileSync(command, args, { cwd, stdio: "inherit" }); };

run("npx", ["tsc", "-p", "tsconfig.json"]);
run("npx", ["tsc", "-p", "tsconfig.guests.json"]);
for (const language of ["fsharp", "csharp"]) {
  run("dotnet", ["publish", `guests/minimal/${language}/Limen.Minimal.Wasm/Limen.Minimal.Wasm.csproj`, "-c", "Release", "-o", `guests/minimal/out/${language}`, "--nologo", "-v", "q"]);
}
run("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown", "--manifest-path", "guests/minimal/rust/limen-minimal-wasm/Cargo.toml"]);

await rm(OUT, { recursive: true, force: true });
await mkdir(join(HOST, "rust"), { recursive: true });
await cp(join(ROOT, "dist"), join(OUT, "dist"), { recursive: true });
await Promise.all(["index.html", "main.js", "host.css"].map((file) => cp(join(ROOT, "guests/minimal/host", file), join(HOST, file))));
await cp(join(ROOT, "guests/minimal/out/fsharp/wwwroot"), join(HOST, "fsharp"), { recursive: true });
await cp(join(ROOT, "guests/minimal/out/csharp/wwwroot"), join(HOST, "csharp"), { recursive: true });
await cp(join(ROOT, "guests/minimal/rust/limen-minimal-wasm/target/wasm32-unknown-unknown/release/limen_minimal_wasm.wasm"), join(HOST, "rust/limen_minimal.wasm"));
// The engines request root-relative /ok.json (conformance/sessions/minimal-engine.md).
await writeFile(join(OUT, "ok.json"), JSON.stringify({ ok: true }));
console.log("Guest engines built → dist-guests/guests/minimal/host/index.html?engine=fsharp|csharp|rust");
