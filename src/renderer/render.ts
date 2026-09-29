// A projection applied to template HTML, on the server (kemiller2002/limen#38):
// the kernel's binding rules, applied to a tree instead of a live DOM.
//
// The same page and the same view give the same content as the kernel would
// show: data-text is text, data-bind-* goes through the kernel's own binding
// policy (src/kernel/binding-policy.ts) — an unsafe URL is not written and is
// reported — and data-if / data-each mount their template's first element
// after the template, bound to the view or the item. The kernel's projection
// errors are errors here too, with the same messages.
//
// Two additions for the page that picks up where the server left off
// (hydration, #39): a mounted data-if root carries data-limen-if, and each
// data-each row carries data-limen-key with its key. An element marked
// data-client-only is written exactly as authored, unbound: its content is
// the fallback until the kernel binds it in the browser.

import type { ViewItem, ViewState, ViewValue } from "../protocol.js";
import { bindableElement, boundNames, checkUrl, classifyAttribute } from "../kernel/binding-policy.js";
import { attribute, type Element, type Node } from "./html.js";

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

type Scope = ViewState | ViewItem;
type Rendered = { readonly nodes: readonly Node[]; readonly refusals: readonly string[] };

const scalar = (raw: ViewValue | ViewItem[keyof ViewItem] | undefined): raw is string | number | boolean =>
  typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean";

// Elements that have a value property in the browser.
const VALUED = new Set(["input", "textarea", "select", "button", "option", "output", "li", "meter", "progress", "data", "param"]);

const withAttribute = (element: Element, name: string, value: string | null): Element => ({
  ...element,
  attributes: value === null
    ? element.attributes.filter(([key]) => key !== name)
    : element.attributes.some(([key]) => key === name) ? element.attributes.map(([key, old]) => [key, key === name ? value : old] as const) : [...element.attributes, [name, value] as const],
});

// A select's value: the option whose value (or, lacking one, text) matches is selected.
const selectOption = (nodes: readonly Node[], value: string): readonly Node[] =>
  nodes.map((node) => {
    if (node.kind !== "element") return node;
    if (node.tag !== "option") return { ...node, children: selectOption(node.children, value) };
    const own = attribute(node, "value") ?? node.children.map((child) => (child.kind === "text" ? child.text : "")).join("");
    return withAttribute(node, "selected", own === value ? "" : null);
  });

const bindAttribute = (element: Element, name: string, raw: string | number | boolean, base: string): { readonly element: Element; readonly refusal?: string } => {
  const target = classifyAttribute(name);
  switch (target.kind) {
    case "BooleanProperty":
    case "BooleanAttribute":
      return { element: withAttribute(element, name, Boolean(raw) ? "" : null) };
    case "ValueProperty": {
      const value = String(raw);
      if (element.tag === "textarea") return { element: { ...element, children: [{ kind: "text", text: value }] } };
      if (element.tag === "select") return { element: { ...element, children: selectOption(element.children, value) } };
      return { element: withAttribute(element, "value", value) };
    }
    case "Url": {
      if (checkUrl(String(raw), base).kind === "Safe") return { element: withAttribute(element, name, String(raw)) };
      const verdict = checkUrl(String(raw), base);
      return { element: withAttribute(element, name, null), refusal: `refused a ${verdict.kind === "Unsafe" ? verdict.scheme : "?"} URL for <${element.tag} ${name}>; only http, https, mailto, tel and relative URLs are projected` };
    }
    case "Attribute":
      return { element: withAttribute(element, name, String(raw)) };
    case "Forbidden":
      throw new ProjectionError(`data-bind-${name}: ${target.reason}`);
  }
};

// A template's content, as the kernel mounts it: its first element child.
const mountable = (template: Element, label: string): Element => {
  const root = template.children.find((child): child is Element => child.kind === "element");
  if (root === undefined) throw new ProjectionError(`${label} template must contain exactly one root element`);
  return root;
};

const renderElement = (element: Element, scope: Scope, base: string): Rendered => {
  if (element.attributes.some(([name]) => name === "data-client-only")) return { nodes: [element], refusals: [] };
  const ifKey = attribute(element, "data-if");
  const eachKey = attribute(element, "data-each");
  if (element.tag === "template" && ifKey !== undefined) {
    if (!Boolean(scope[ifKey])) return { nodes: [element], refusals: [] };
    const mounted = renderElement(withAttribute(mountable(element, `data-if="${ifKey}"`), "data-limen-if", ifKey), scope, base);
    return { nodes: [element, ...mounted.nodes], refusals: mounted.refusals };
  }
  if (element.tag === "template" && eachKey !== undefined) {
    const itemKey = attribute(element, "data-key");
    if (itemKey === undefined || itemKey === "") throw new ProjectionError(`data-each="${eachKey}" requires data-key`);
    const raw = scope[eachKey];
    if (!Array.isArray(raw)) throw new ProjectionError(`data-each="${eachKey}" requires an array view value`);
    const items: readonly ViewItem[] = raw;
    const root = mountable(element, `data-each="${eachKey}"`);
    const rows = items.map((item) => {
      const key = item[itemKey];
      if (key === undefined) throw new ProjectionError(`data-each item missing key field "${itemKey}"`);
      return renderElement(withAttribute(root, "data-limen-key", String(key)), item, base);
    });
    return { nodes: [element, ...rows.flatMap((row) => row.nodes)], refusals: rows.flatMap((row) => row.refusals) };
  }
  const misplaced = ["data-if", "data-each"].find((name) => attribute(element, name) !== undefined);
  if (misplaced !== undefined) throw new ProjectionError(`${misplaced}="${attribute(element, misplaced) ?? ""}" is only supported on a <template> element, but was found on <${element.tag}>`);
  const names = element.attributes.map(([name]) => name);
  const bound = boundNames(names);
  if (bound.length > 0) {
    const unbindable = bindableElement(element.tag, (name) => attribute(element, name) ?? null, bound);
    if (unbindable !== undefined) throw new ProjectionError(unbindable);
  }
  const textKey = attribute(element, "data-text");
  if (textKey !== undefined && !scalar(scope[textKey])) throw new ProjectionError(`View value for "${textKey}" is missing or not scalar`);
  const attributed = element.attributes.filter(([name]) => name.startsWith("data-bind-")).reduce<{ readonly element: Element; readonly refusals: readonly string[] }>((done, [name, key]) => {
    const property = name.slice("data-bind-".length);
    const raw = scope[key];
    if (!scalar(raw)) throw new ProjectionError(`Attribute binding "${property}" requires a scalar view value`);
    if (property === "value" && !VALUED.has(element.tag)) throw new ProjectionError(`Element bound to "value" has no value property`);
    const next = bindAttribute(done.element, property, raw, base);
    return { element: next.element, refusals: next.refusal === undefined ? done.refusals : [...done.refusals, next.refusal] };
  }, { element, refusals: [] });
  const withText = textKey !== undefined && scalar(scope[textKey]) ? { ...attributed.element, children: [{ kind: "text" as const, text: String(scope[textKey]) }] } : attributed.element;
  // A template's content is not the page's: it mounts only through data-if or data-each.
  if (withText.tag === "template") return { nodes: [withText], refusals: attributed.refusals };
  const children = renderNodes(withText.children, scope, base);
  return { nodes: [{ ...withText, children: children.nodes }], refusals: [...attributed.refusals, ...children.refusals] };
};

const renderNodes = (nodes: readonly Node[], scope: Scope, base: string): Rendered =>
  nodes.reduce<Rendered>((done, node) => {
    if (node.kind !== "element") return { nodes: [...done.nodes, node], refusals: done.refusals };
    const rendered = renderElement(node, scope, base);
    return { nodes: [...done.nodes, ...rendered.nodes], refusals: [...done.refusals, ...rendered.refusals] };
  }, { nodes: [], refusals: [] });

// The view applied to a page. base resolves relative URLs for the URL check.
export const renderProjection = (nodes: readonly Node[], view: ViewState, base: string): Rendered => renderNodes(nodes, view, base);
