// Static HTML/projection/event contract validation (kemiller2002/limen#48):
// every Limen page in the repository against the view contract beside it
// (`page.html` → `page.view.json`), with no browser. See
// docs/28-view-contracts.md.
//
// Fails when a page binds a key its contract lacks, a list item field or
// data-key that is not in the item contract, an event the engine does not
// accept, or a value kind the binding cannot use; and when a page with
// Limen bindings has no contract at all.

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { checkPage, formatDiagnostic, parseViewContract, tagsOf } from "../src/tooling/view-contract.ts";

const ROOT = process.cwd();
const SKIP = new Set(["node_modules", ".git", "dist", "dist-site", "dist-guests", "bin", "obj", "target", "publish", "runtimes", "release", "fixtures"]);
const BINDING = /^data-(event|text|bind-.+|if|each)$/;

const htmlFiles = async (directory: string): Promise<readonly string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) || entry.name.startsWith(".") ? Promise.resolve([]) : htmlFiles(path);
    return Promise.resolve(entry.name.endsWith(".html") ? [path] : []);
  }));
  return nested.flat();
};

const readContract = async (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

const results = await Promise.all((await htmlFiles(ROOT)).sort().map(async (path) => {
  const file = relative(ROOT, path);
  const html = await readFile(path, "utf8");
  const bound = tagsOf(html).some((tag) => Array.from(tag.attributes.keys()).some((name) => BINDING.test(name)));
  const contractPath = path.replace(/\.html$/, ".view.json");
  const text = await readContract(contractPath);
  if (text === undefined) return { file, checked: false, problems: bound ? [`${file}: has Limen bindings but no view contract (${relative(ROOT, contractPath)})`] : [] };
  const parsed = parseViewContract(JSON.parse(text) as unknown);
  if (!parsed.ok) return { file, checked: true, problems: parsed.errors.map((error) => `${relative(ROOT, contractPath)}: ${error}`) };
  return { file, checked: true, problems: checkPage(file, html, parsed.contract).map(formatDiagnostic) };
}));

const problems = results.flatMap((result) => result.problems);
if (problems.length > 0) {
  console.error(`View contract checks failed (${problems.length}):\n${problems.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`View contract checks passed (${results.filter((result) => result.checked).length} pages against their view contracts).`);
}
