// The template HTML the renderer reads and writes (kemiller2002/limen#38).
//
// Not an HTML5 parser: a strict reader for the pages an application authors
// for Limen. Elements are closed explicitly (void elements need no end tag),
// attributes are quoted or bare, and <script>, <style>, <textarea> and <title>
// hold raw text. Anything it cannot read unambiguously — a stray end tag, an
// unclosed element, an unquoted attribute value containing markup — is an
// error naming the position, never a silent guess. Output is deterministic:
// attribute order and whitespace are kept, and text and attribute values are
// escaped.

export type Node =
  | { readonly kind: "element"; readonly tag: string; readonly attributes: readonly (readonly [string, string])[]; readonly children: readonly Node[] }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "comment"; readonly text: string }
  | { readonly kind: "doctype"; readonly text: string };

export type Element = Extract<Node, { readonly kind: "element" }>;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateError";
  }
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " };

const decode = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });

const escapeText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("\"", "&quot;");

const lineOf = (source: string, at: number): number => source.slice(0, at).split("\n").length;

// One open element while reading.
type Open = { readonly tag: string; readonly attributes: readonly (readonly [string, string])[]; readonly children: Node[]; readonly at: number };

const ATTRIBUTE = /\s*([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;

export const parse = (source: string): readonly Node[] => {
  const root: Open = { tag: "#root", attributes: [], children: [], at: 0 };
  const stack: Open[] = [root];
  const top = (): Open => stack[stack.length - 1] ?? root;
  const fail = (message: string, at: number): never => { throw new TemplateError(`line ${lineOf(source, at)}: ${message}`); };
  const readAt = (at: number): number => {
    if (at >= source.length) return at;
    if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      if (end === -1) fail("unclosed comment", at);
      top().children.push({ kind: "comment", text: source.slice(at + 4, end) });
      return end + 3;
    }
    if (source.startsWith("<!", at)) {
      const end = source.indexOf(">", at);
      if (end === -1) fail("unclosed declaration", at);
      top().children.push({ kind: "doctype", text: source.slice(at + 2, end) });
      return end + 1;
    }
    if (source.startsWith("</", at)) {
      const end = source.indexOf(">", at);
      if (end === -1) fail("unclosed end tag", at);
      const tag = source.slice(at + 2, end).trim().toLowerCase();
      const open = top();
      if (open.tag !== tag) fail(`</${tag}> does not close the open <${open.tag}>`, at);
      stack.pop();
      top().children.push({ kind: "element", tag: open.tag, attributes: open.attributes, children: open.children });
      return end + 1;
    }
    if (source[at] === "<" && /[a-zA-Z]/.test(source[at + 1] ?? "")) {
      const name = /^[a-zA-Z][a-zA-Z0-9-]*/.exec(source.slice(at + 1))?.[0] ?? "";
      const tag = name.toLowerCase();
      const attributes: (readonly [string, string])[] = [];
      const cursor = { at: at + 1 + name.length };
      while (!/^\s*\/?>/.test(source.slice(cursor.at, cursor.at + 64))) {
        ATTRIBUTE.lastIndex = cursor.at;
        const match = ATTRIBUTE.exec(source);
        if (match === null || match[0].length === 0) fail(`cannot read the attributes of <${tag}>`, cursor.at);
        const [text, attribute, double, single, bare] = match ?? [];
        attributes.push([(attribute ?? "").toLowerCase(), decode(double ?? single ?? bare ?? "")]);
        cursor.at += (text ?? "").length;
      }
      const close = source.indexOf(">", cursor.at);
      const selfClosing = source.slice(cursor.at, close).trim() === "/";
      if (VOID.has(tag) || selfClosing) {
        top().children.push({ kind: "element", tag, attributes, children: [] });
        return close + 1;
      }
      if (RAW_TEXT.has(tag)) {
        const end = source.toLowerCase().indexOf(`</${tag}`, close + 1);
        if (end === -1) fail(`<${tag}> is never closed`, at);
        const raw = source.slice(close + 1, end);
        const text = tag === "title" || tag === "textarea" ? decode(raw) : raw;
        top().children.push({ kind: "element", tag, attributes, children: text === "" ? [] : [{ kind: "text", text }] });
        return source.indexOf(">", end) + 1;
      }
      stack.push({ tag, attributes, children: [], at });
      return close + 1;
    }
    const next = source.indexOf("<", at + 1);
    const end = next === -1 ? source.length : next;
    top().children.push({ kind: "text", text: decode(source.slice(at, end)) });
    return end;
  };
  // Iterative: a long page must not exhaust the stack.
  const run = { at: 0 };
  while (run.at < source.length) run.at = readAt(run.at);
  if (stack.length > 1) fail(`<${top().tag}> is never closed`, top().at);
  return root.children;
};

const serializeNode = (node: Node, raw: boolean): string => {
  switch (node.kind) {
    case "text": return raw ? node.text : escapeText(node.text);
    case "comment": return `<!--${node.text}-->`;
    case "doctype": return `<!${node.text}>`;
    case "element": {
      const attributes = node.attributes.map(([name, value]) => (value === "" && BARE.has(name) ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`)).join("");
      if (VOID.has(node.tag)) return `<${node.tag}${attributes}>`;
      const rawText = node.tag === "script" || node.tag === "style";
      return `<${node.tag}${attributes}>${node.children.map((child) => serializeNode(child, rawText)).join("")}</${node.tag}>`;
    }
  }
};

// Boolean attributes are written bare, as authors write them.
const BARE = new Set(["disabled", "checked", "selected", "hidden", "open", "inert", "required", "readonly", "multiple", "autofocus", "novalidate", "formnovalidate", "autoplay", "controls", "loop", "muted", "playsinline", "default", "reversed", "ismap", "itemscope", "allowfullscreen", "nomodule", "async", "defer", "popover", "data-client-only"]);

export const serialize = (nodes: readonly Node[]): string => nodes.map((node) => serializeNode(node, false)).join("");

export const attribute = (element: Element, name: string): string | undefined => element.attributes.find(([key]) => key === name)?.[1];

export const textOf = (nodes: readonly Node[]): string =>
  nodes.map((node) => (node.kind === "text" ? node.text : node.kind === "element" ? textOf(node.children) : "")).join("");
