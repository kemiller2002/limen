// The restricted handwritten-TypeScript subset (kemiller2002/limen#54). Rules:
// tools/guardrails/typescript.ts. Which files, and the ratcheted exceptions:
// architecture/typescript-boundary.json. Needs a built dist/ (npm test's
// pretest builds it) because the site transports import the package from there.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { checkProgram, describeFinding, type BoundaryConfig } from "../tools/guardrails/typescript.ts";

const ROOT = process.cwd();

const raw = JSON.parse(await readFile(join(ROOT, "architecture/typescript-boundary.json"), "utf8")) as Omit<BoundaryConfig, "protocolTypeNames">;
const targets = JSON.parse(await readFile(join(ROOT, "contract/targets.json"), "utf8")) as { readonly units: readonly string[]; readonly outputs: readonly { readonly path: string }[] };
const generatedPaths = targets.outputs.map((output) => output.path);
const protocolTypeNames = (await Promise.all(targets.units.map(async (unit) =>
  (JSON.parse(await readFile(join(ROOT, unit), "utf8")) as { readonly types: readonly { readonly name: string }[] }).types.map((type) => type.name)))).flat();

const tsconfig = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT);
const siteTransports = ts.sys.readDirectory(join(ROOT, "site/app"), [".ts"]).filter((file) => file.endsWith("-transport.ts"));
const program = ts.createProgram([...tsconfig.fileNames, ...siteTransports], { ...tsconfig.options, noEmit: true, rootDir: undefined, declaration: false, declarationMap: false });

const outcome = checkProgram(program, ROOT, { ...raw, protocolTypeNames, generatedPaths });
const stale = outcome.staleDebt.map((entry) => entry.actual < entry.declared
  ? `[debt-paid] ${entry.path}: ${entry.rule} is down to ${entry.actual} from ${entry.declared}. Lower knownDebt in architecture/typescript-boundary.json (the ratchet only tightens).`
  : `[debt-grew] ${entry.path}: ${entry.rule} rose to ${entry.actual} from ${entry.declared}. New escape hatches are not debt; remove them.`);

if (outcome.findings.length + stale.length > 0) {
  console.error(`Restricted TypeScript checks failed:\n${[...outcome.findings.map(describeFinding), ...stale].join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Restricted TypeScript checks passed (${program.getSourceFiles().filter((file) => !file.isDeclarationFile).length} source files in the program).`);
}
