// Assembles the Limen site into dist-site/.
//
// Deliberately tiny: read a layout, substitute a page's content into it, copy
// static files. No template engine, no bundler, no framework — the site is
// static HTML plus Limen applications, and the build should not be more
// complicated than the thing it builds.
//
// Every emitted path is RELATIVE (`./assets/...`, `./site/app/main.js`), and
// every page sits at the root of the output, so the site works identically at
// https://user.github.io/limen/ and at a future custom domain.
// Nothing is hardcoded to "/".
//
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "dist-site");

type Page = {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  /** Optional browser module loaded by this page. Prose pages omit it. */
  readonly script?: string;
};

const PAGES: readonly Page[] = [
  { slug: "index", title: "Overview", description: "Limen is an explicit boundary that keeps browser capabilities separate from application authority.", script: "main.js" },
  { slug: "architecture", title: "Architecture", description: "What runs where in a Limen application, who owns state, and why the boundary is drawn where it is." },
  { slug: "demos", title: "Demos", description: "Interactive demonstrations of Limen's event flow, state model, and effect outcomes — driven by the real kernel.", script: "main.js" },
  { slug: "federation", title: "Federation", description: "A real-browser existence proof with two independently loaded F# WebAssembly modules exchanging versioned transitions through Limen.", script: "federation-proof.js" },
  { slug: "evidence", title: "Evidence", description: "What has actually been measured about Limen, what has not, and where every number comes from." },
  { slug: "agents", title: "For agents", description: "The architectural contract an AI coding agent needs before modifying a Limen application." },
  { slug: "docs", title: "Documentation", description: "The full Limen documentation set: architecture, getting started, effects, testing, recipes and troubleshooting." },
];

function gitShortSha(): string {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function packageVersion(): Promise<string> {
  const raw = await readFile(join(ROOT, "package.json"), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

/** Replaces every `{{key}}` with its value; unknown placeholders become "". */
function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{\{([a-z0-9-]+)\}\}/gi, (_match, key: string) => values[key] ?? "");
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

/** Copies only the emitted .js from the site app — never its .ts sources. */
async function copyAppJs(): Promise<number> {
  const source = join(ROOT, "site", "app");
  const target = join(OUT, "site", "app");
  await mkdir(target, { recursive: true });
  const entries = await readdir(source);
  const scripts = entries.filter((name) => name.endsWith(".js"));
  for (const name of scripts) await cp(join(source, name), join(target, name));
  return scripts.length;
}

const scriptTag = (script: string | undefined): string =>
  script === undefined ? "" : `  <script type="module" src="./site/app/${script}"></script>`;

async function main(): Promise<void> {
  const layout = await readFile(join(ROOT, "site", "templates", "layout.html"), "utf8");
  const version = await packageVersion();
  const commit = gitShortSha();
  const built = new Date().toISOString().slice(0, 10);
  const year = String(new Date().getUTCFullYear());

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });

  for (const page of PAGES) {
    const content = await readFile(join(ROOT, "site", "pages", `${page.slug}.html`), "utf8");
    const nav: Record<string, string> = {};
    for (const other of PAGES) nav[`nav-${other.slug}`] = other.slug === page.slug ? ` aria-current="page"` : "";
    const html = fill(layout, {
      ...nav,
      title: page.title,
      description: page.description,
      content,
      year,
      version,
      commit,
      built,
      app: scriptTag(page.script),
    });
    await writeFile(join(OUT, `${page.slug}.html`), html, "utf8");
  }

  // Static assets, demo fixtures, the compiled site app, and the kernel the
  // app imports. The kernel lands at dist/ so the app's emitted
  // `../../dist/...` specifiers resolve unchanged in the deployed tree.
  await copyTree(join(ROOT, "site", "assets"), join(OUT, "assets"));
  await copyTree(join(ROOT, "site", "demo"), join(OUT, "demo"));
  const scripts = await copyAppJs();
  await copyTree(join(ROOT, "dist"), join(OUT, "dist"));

  // The site's application engine is F# compiled to .NET WebAssembly. The
  // npm package remains a TypeScript browser boundary; this site is a real
  // consumer of that boundary, not a TypeScript simulation of one.
  await copyTree(join(ROOT, "site", "fsharp", "publish", "wwwroot"), join(OUT, "wasm"));
  await copyTree(
    join(ROOT, "site", "fsharp", "federation", "Limen.Federation.Source.Wasm", "publish", "wwwroot"),
    join(OUT, "federation", "source"),
  );
  await copyTree(
    join(ROOT, "site", "fsharp", "federation", "Limen.Federation.Target.Wasm", "publish", "wwwroot"),
    join(OUT, "federation", "target"),
  );

  // Pages serves what it is given; nothing here needs Jekyll processing, and
  // .nojekyll stops it from ignoring paths that begin with an underscore.
  await writeFile(join(OUT, ".nojekyll"), "", "utf8");

  console.log(`Site built: ${PAGES.length} pages, ${scripts} browser-boundary script(s), F# WASM engine + two-module federation proof, version ${version} (${commit}) → dist-site/`);
}

await main();
