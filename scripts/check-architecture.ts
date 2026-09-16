// Mechanical enforcement of the one rule: application code does not touch the
// browser. Run by `npm test`.
//
// This is a lexical check, not a type-aware one. It cannot prove the absence
// of browser access, only catch the ways it is actually written — a limit
// stated here rather than implied away.
//
// Comments and string literals are removed before matching, matching the F#
// port in cli/Limen.Core/Boundary.fs token for token. The two used to differ:
// this one matched raw text, so a comment reading "the engine never calls
// fetch()" failed it. That divergence was survivable only while the checker
// looked at four hand-curated files. Widening it to the example and site
// engines produced seven findings in one run, every one of them prose, and a
// checker that cries wolf is one people learn to ignore.
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Blanks out comments and string literals, preserving offsets and newlines so
 * nothing else shifts. A comment cannot reach the DOM and a string cannot call
 * anything, so neither is evidence of a boundary violation.
 */
function stripCommentsAndStrings(source: string): string {
  let out = "";
  let index = 0;
  const peek = (offset: number): string => source[index + offset] ?? "\0";

  while (index < source.length) {
    const current = source[index]!;
    if (current === "/" && peek(1) === "/") {
      while (index < source.length && source[index] !== "\n") { out += " "; index += 1; }
    } else if (current === "/" && peek(1) === "*") {
      let closed = false;
      while (index < source.length && !closed) {
        if (source[index] === "*" && peek(1) === "/") { out += "  "; index += 2; closed = true; }
        else { out += source[index] === "\n" ? "\n" : " "; index += 1; }
      }
    } else if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      out += " ";
      index += 1;
      let closed = false;
      while (index < source.length && !closed) {
        const character = source[index]!;
        if (character === "\\") {
          // Skip the escape and whatever it escapes, so a trailing backslash
          // cannot swallow the closing quote.
          out += "  "; index += 2;
        } else if (character === quote) { out += " "; index += 1; closed = true; }
        else { out += character === "\n" ? "\n" : " "; index += 1; }
      }
    } else {
      out += current;
      index += 1;
    }
  }
  return out;
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

/**
 * Every browser capability an engine must reach through an effect instead.
 *
 * The navigation and clipboard entries name specific APIs rather than the bare
 * words "history", "location" or "clipboard": an engine legitimately receives
 * `Initialize.location` and legitimately says the word "clipboard" in a
 * message to the user. Calling `history.pushState` or `navigator.clipboard`
 * is the actual violation, and these are what catch it.
 */
const FORBIDDEN_BROWSER = [
  "document",
  "window",
  "fetch(",
  "localStorage",
  "sessionStorage",
  // Navigation: ask for a Navigate effect; never drive history directly.
  "history.pushState",
  "history.replaceState",
  "history.back",
  "history.forward",
  "location.href",
  "location.assign",
  "location.reload",
  "location.pathname",
  "location.search",
  "location.hash",
  // Clipboard: ask for a Clipboard effect. execCommand is the legacy copy
  // hack — if a fallback is ever needed it belongs inside the kernel, once.
  "navigator.clipboard",
  "execCommand",
  // Host interop escapes from the WASM-engine world.
  "JsValue",
  "IJSRuntime",
] as const;

/**
 * Every directory whose contents own application meaning.
 *
 * `src/engine` is the published reference engine. The example and site engines
 * are application code too, and were previously unchecked — an example is the
 * first thing a newcomer copies, so a leak there propagates further than one
 * in the library.
 */
async function engineSources(): Promise<readonly string[]> {
  const roots = ["src/engine", "site/app"];
  const examples = (await readdir("examples", { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^\d\d-/.test(entry.name))
    .map((entry) => join("examples", entry.name));
  const all = await Promise.all([...roots, ...examples].map(files));
  // Only the engine half. An example's main.ts constructs the kernel and is
  // allowed to name `document`; that is the wiring, not the application.
  return all.flat().filter((file) => file.endsWith(".ts") && !file.endsWith("main.ts"));
}

const violations: string[] = [];

for (const file of await engineSources()) {
  const code = stripCommentsAndStrings(await readFile(file, "utf8"));
  for (const forbidden of FORBIDDEN_BROWSER) {
    if (code.includes(forbidden)) violations.push(`${file}: forbidden browser dependency ${forbidden}`);
  }
  if (/\b(any|dynamic)\b/.test(code)) violations.push(`${file}: dynamic type escape`);
}

for (const file of await files("src")) {
  const code = stripCommentsAndStrings(await readFile(file, "utf8"));
  if (/SetInnerHtml|ExecuteScript|eval\s*\(/.test(code)) violations.push(`${file}: forbidden escape hatch`);
}

// The kernel is the one place allowed to touch the browser — but only through
// its own declared capabilities. A second, undeclared route to the clipboard
// or to history would defeat the capability announcement entirely.
const kernelSources = (await files("src/kernel")).filter((file) => file.endsWith(".ts"));
for (const file of kernelSources) {
  const code = stripCommentsAndStrings(await readFile(file, "utf8"));
  if (file.endsWith("diagnostics.ts") && /navigator|history\.|clipboard/.test(code)) {
    violations.push(`${file}: the diagnostics sink must not reach browser capabilities`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Architecture checks passed.");
}
