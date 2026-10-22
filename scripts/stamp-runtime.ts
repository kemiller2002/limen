// Build-only post-processing for the emitted browser-kernel entry point. The
// source kernel and its WASM/browser boundary stay unchanged; package metadata
// is attached to the artifact that actually executes in a browser.
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const START = "// <echelon-runtime-stamp>";
const END = "// </echelon-runtime-stamp>";

export function runtimeStamp(version: string): string {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid Limen package version: ${version}`);
  }

  // Keep the generated diagnostic small: it is part of every browser-kernel
  // graph and therefore remains subject to Limen's frozen Core-size budget.
  return `${START}
if(typeof window!=="undefined"){(t=>{const S=1,R="__ECHELON_RUNTIME__",K="__ECHELON_REGISTER_RUNTIME__",d=(m,x)=>t.console?.[m]?.(x),l=n=>n[0].toUpperCase()+n.slice(1);let r=t[K];if(typeof r!=="function"||r.echelonRuntimeSchemaVersion!==S){if(r!==undefined){d("warn","Echelon Runtime registrar conflict: incompatible registrar already installed.");return}let g=t[R];if(g===undefined)t[R]=g={schemaVersion:S,libraries:{}};else if(g===null||typeof g!=="object"||g.schemaVersion!==S||g.libraries===null||typeof g.libraries!=="object"){d("warn","Echelon Runtime registry conflict: schemaVersion 1 required; registry unchanged.");return}r=(n,m)=>{const c={version:m.version};if(typeof m.commit==="string"&&m.commit)c.commit=m.commit;if(typeof m.buildTime==="string"&&m.buildTime)c.buildTime=m.buildTime;const o=g.libraries[n];if(o!==undefined){if(o.version===c.version)return o;d("warn",\`Echelon Runtime conflict: \${l(n)} v\${o.version} already registered; ignored v\${c.version}.\`);return o}g.libraries[n]=c;d("info",\`Echelon Runtime · \${l(n)} v\${c.version}\`);return c};Object.defineProperty(r,"echelonRuntimeSchemaVersion",{value:S});Object.defineProperty(t,K,{value:r,configurable:true})}r("limen",{version:${JSON.stringify(version)}})})(window)}
${END}`;
}

export async function stampRuntime(root = resolve(import.meta.dirname, "..")): Promise<void> {
  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as { readonly version?: unknown };
  if (typeof packageJson.version !== "string") throw new Error("package.json must provide the Limen package version");

  const path = resolve(root, "dist/kernel/browser-kernel.js");
  const emitted = await readFile(path, "utf8");
  const withoutPrevious = emitted.replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`, "g"), "\n");
  const sourceMap = withoutPrevious.match(/\n\/\/# sourceMappingURL=.*\n?$/)?.[0] ?? "";
  const body = sourceMap === "" ? withoutPrevious.trimEnd() : withoutPrevious.slice(0, -sourceMap.length).trimEnd();
  await writeFile(path, `${body}\n\n${runtimeStamp(packageJson.version)}${sourceMap || "\n"}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stampRuntime();
}
