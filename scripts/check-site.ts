// Validates the built site in dist-site/ before it is published.
//
// Deliberately separate from test/site.test.ts: that file checks *behavior*
// (the pages drive the real kernel correctly). This checks the *artifact* — the
// things that only go wrong at deploy time, where a broken link or an absolute
// path is invisible locally but fatal under a project-pages base path.
//
// Run by the Pages workflow on every push and pull request, so a pull request
// proves the artifact is publishable without publishing it.
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SITE = join(ROOT, "dist-site");

const violations: string[] = [];
const note = (message: string): number => violations.push(message);

const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false);

if (!await exists(SITE)) {
  console.error("dist-site/ does not exist — run `npm run build:site` first.");
  process.exit(1);
}

const entries = await readdir(SITE);
const htmlPages = entries.filter((name) => name.endsWith(".html"));

if (htmlPages.length === 0) note("dist-site/ contains no HTML pages");
if (!entries.includes(".nojekyll")) note("dist-site/.nojekyll is missing — Pages would apply Jekyll processing");

// Assets the app genuinely needs at runtime. A missing one is a blank page.
for (const required of ["assets/css/limen.css", "site/app/main.js", "site/app/engine.js", "dist/kernel/browser-kernel.js", "dist/protocol.js"]) {
  if (!await exists(join(SITE, required))) note(`required runtime asset missing: ${required}`);
}

const ATTR = /(?:href|src)="([^"]+)"/g;

for (const page of htmlPages) {
  const html = await readFile(join(SITE, page), "utf8");

  if (!/<title>[^<]+<\/title>/.test(html)) note(`${page}: no <title>`);
  if (!/<meta name="description" content="[^"]+"/.test(html)) note(`${page}: no meta description`);
  if (!/<html lang="/.test(html)) note(`${page}: no lang attribute`);
  if (/\{\{[a-z-]+\}\}/i.test(html)) note(`${page}: unsubstituted template placeholder remains`);

  for (const [, url] of html.matchAll(ATTR)) {
    if (/^(https?:|data:|mailto:|#)/.test(url)) continue;

    // A root-absolute path silently breaks under https://user.github.io/<repo>/.
    if (url.startsWith("/")) {
      note(`${page}: root-absolute path would break under a project-pages base path — ${url}`);
      continue;
    }
    const target = join(SITE, dirname(page), url.split("#")[0] ?? "");
    if (!await exists(target)) note(`${page}: broken local reference — ${url}`);
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log(`Site artifact checks passed (${htmlPages.length} pages).`);
