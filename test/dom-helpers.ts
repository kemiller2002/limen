import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// The kernel checks element identity with bare global class names
// (`instanceof HTMLInputElement`, etc.), matching how it runs in a real
// browser. jsdom's window carries its own copies of those classes, so they
// have to be installed as the real globals for the duration of a test —
// otherwise `instanceof` silently fails against jsdom-created elements.
const DOM_GLOBALS = [
  "window",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "HTMLFormElement",
  "HTMLTemplateElement",
  "DOMException",
] as const;

type Globals = Record<string, unknown>;

export async function withDom<T>(bodyHtml: string, run: (document: Document) => Promise<T>): Promise<T> {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, { url: "http://localhost/" });
  const globals = globalThis as unknown as Globals;
  const saved = new Map<string, unknown>();
  for (const key of DOM_GLOBALS) {
    saved.set(key, globals[key]);
    globals[key] = (dom.window as unknown as Globals)[key];
  }
  try {
    return await run(dom.window.document);
  } finally {
    for (const key of DOM_GLOBALS) globals[key] = saved.get(key);
    dom.window.close();
  }
}

// Reads an example's real index.html and returns its <body> markup with the
// module <script> removed. Tests drive the actual shipped file rather than a
// copy of its markup, so an example whose HTML drifts from its documented
// behavior fails the suite instead of rotting silently.
export async function exampleBody(exampleDir: string): Promise<string> {
  const html = await readFile(new URL(`../examples/${exampleDir}/index.html`, import.meta.url), "utf8");
  const dom = new JSDOM(html);
  for (const script of Array.from(dom.window.document.querySelectorAll("script"))) script.remove();
  const body = dom.window.document.body.innerHTML;
  dom.window.close();
  return body;
}

export async function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const globals = globalThis as unknown as Globals;
  const saved = globals.fetch;
  globals.fetch = impl;
  try {
    return await run();
  } finally {
    globals.fetch = saved;
  }
}
