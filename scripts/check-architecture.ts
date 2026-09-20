import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

const violations: string[] = [];
for (const file of await files("src/engine")) {
  const source = await readFile(file, "utf8");
  for (const forbidden of ["document", "window", "fetch(", "localStorage", "sessionStorage", "JsValue", "IJSRuntime"]) {
    if (source.includes(forbidden)) violations.push(`${file}: forbidden browser dependency ${forbidden}`);
  }
  if (/\b(any|dynamic)\b/.test(source)) violations.push(`${file}: dynamic type escape`);
}
for (const file of await files("src")) {
  const source = await readFile(file, "utf8");
  if (/SetInnerHtml|ExecuteScript|eval\s*\(/.test(source)) violations.push(`${file}: forbidden escape hatch`);
}

// The product site is now a real F# WebAssembly consumer. Its application
// engine must remain on the authority side of Limen: no JS interop and no
// browser APIs. The only .NET↔JS interop is the tiny C# host one directory over.
for (const file of await files("site/fsharp/Limen.Site.Engine")) {
  const source = await readFile(file, "utf8");
  for (const forbidden of [
    "System.Runtime.InteropServices.JavaScript",
    "Microsoft.JSInterop",
    "JSImport",
    "JSExport",
    "document",
    "window",
    "fetch(",
    "localStorage",
    "sessionStorage",
    "navigator",
    "history.",
  ]) {
    if (source.includes(forbidden)) violations.push(`${file}: F# site engine leaked browser/interoperability authority via ${forbidden}`);
  }
}

const wasmHost = await readFile("site/fsharp/Limen.Site.Wasm/Program.cs", "utf8");
if (!wasmHost.includes("Limen.Site.Engine.Dispatch.handle")) {
  violations.push("site/fsharp/Limen.Site.Wasm/Program.cs: WASM host no longer forwards directly to the F# engine");
}
for (const forbidden of [
  "ApproveRelease",
  "ReconciliationRequired",
  "EvidenceState",
  "DeploymentState",
  "StartPolicyA",
  "StartPolicyB",
  "fetch(",
  "document",
  "window",
  "localStorage",
]) {
  if (wasmHost.includes(forbidden)) violations.push(`site/fsharp/Limen.Site.Wasm/Program.cs: marshalling shim contains application/browser concept ${forbidden}`);
}
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture checks passed.");
}
