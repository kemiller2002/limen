// Naming an element for a capability pack without passing a DOM node
// (kemiller2002/limen#25, #23). The HTML author names it with an attribute;
// inside a data-each row, the engine projects the row's key onto an ancestor
// with an ordinary data-bind-data-* binding. A request names the target and,
// optionally, the key. Exactly one element must match: none and several are
// answers, not guesses.

export type TargetAttributes = { readonly name: string; readonly key: string };
export type NamedTarget = { readonly name: string; readonly key?: string };
export type Resolved =
  | { readonly kind: "Found"; readonly element: Element }
  | { readonly kind: "NotFound" }
  | { readonly kind: "Ambiguous"; readonly count: number };

const quoted = (value: string): string => `"${value.replace(/["\\]/g, (character) => `\\${character}`)}"`;

export const resolveTarget = (document: Document, attributes: TargetAttributes, target: NamedTarget): Resolved => {
  const named = Array.from(document.querySelectorAll(`[${attributes.name}=${quoted(target.name)}]`));
  const matches = target.key === undefined ? named : named.filter((element) => element.closest(`[${attributes.key}]`)?.getAttribute(attributes.key) === target.key);
  const [only, ...others] = matches;
  if (only === undefined) return { kind: "NotFound" };
  return others.length > 0 ? { kind: "Ambiguous", count: matches.length } : { kind: "Found", element: only };
};
