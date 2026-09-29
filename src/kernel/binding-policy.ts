// What a projection may write, and where (kemiller2002/limen#18, LCP-027).
//
// The HTML author chooses a binding's *target* (`data-bind-href`); the engine
// supplies its *value*, which is often user data. So targets are checked once,
// when the page is bound, and refused outright if no value could ever be
// safe there; values are checked on every projection only where the target
// is safe for some values and not others (URLs).
//
//   - Text is always textContent — never parsed as HTML, anywhere.
//   - Event-handler attributes, srcdoc, style and URL lists are never targets.
//   - Elements that load or run code, or rewrite other attributes (script,
//     style, iframe, object, base, meta, link, SVG animation), take no
//     bindings at all.
//   - A URL-bearing attribute takes only http(s), mailto, tel or a relative
//     URL; anything else is not written, and the refusal is reported without
//     the value.
//
// Pure: no DOM access. The kernel applies it; the static view checker
// (src/tooling/view-contract.ts) reports the same refusals before a page runs.

export type AttributeTarget =
  | { readonly kind: "BooleanProperty" }
  // Present when the value is truthy, absent otherwise: for an HTML boolean
  // attribute, any value — including the string "false" — means true.
  | { readonly kind: "BooleanAttribute" }
  | { readonly kind: "ValueProperty" }
  | { readonly kind: "Url" }
  | { readonly kind: "Attribute" }
  | { readonly kind: "Forbidden"; readonly reason: string };

const BOOLEAN_PROPERTIES: readonly string[] = ["disabled", "checked", "selected", "hidden", "open"];

// HTML's other boolean attributes (the HTML Living Standard's attribute
// index). setAttribute("inert", "false") makes an element inert, so these are
// toggled by presence.
const BOOLEAN_ATTRIBUTES: readonly string[] = [
  "inert", "required", "readonly", "multiple", "autofocus", "novalidate", "formnovalidate", "autoplay", "controls",
  "loop", "muted", "playsinline", "default", "reversed", "ismap", "itemscope", "allowfullscreen", "nomodule", "async", "defer",
];

// Elements whose content or attributes load, run or restyle code, or rewrite
// other attributes. Embedding one with engine-supplied values is a trust
// boundary for an adapter to own explicitly, not a binding.
const UNBINDABLE_ELEMENTS: readonly string[] = [
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link",
  "animate", "set", "animatemotion", "animatetransform", "animatecolor",
];

// Attributes whose value is a URL the browser will navigate to or fetch.
const URL_ATTRIBUTES: readonly string[] = ["href", "xlink:href", "src", "action", "formaction", "poster", "cite", "background", "data", "codebase", "manifest", "longdesc", "lowsrc", "dynsrc"];

const FORBIDDEN_ATTRIBUTES: Readonly<Record<string, string>> = {
  srcdoc: "srcdoc loads a whole document from a string",
  style: "inline style is appearance: bind a class or a data-* attribute and style it in CSS",
  srcset: "srcset is a list of URLs the kernel cannot check one by one: bind src",
  imagesrcset: "imagesrcset is a list of URLs the kernel cannot check one by one",
  ping: "ping sends a request per click to each URL in a list",
  is: "is changes which custom element constructor runs",
  "http-equiv": "http-equiv can change the page's policy",
  attributename: "attributeName lets an SVG animation rewrite another attribute",
};

export const bindableElement = (tagName: string): string | undefined =>
  UNBINDABLE_ELEMENTS.includes(tagName.toLowerCase()) ? `<${tagName.toLowerCase()}> loads, runs or rewrites code or other attributes; it takes no data-text or data-bind-* bindings` : undefined;

export const classifyAttribute = (attribute: string): AttributeTarget => {
  const name = attribute.toLowerCase();
  if (name.startsWith("on")) return { kind: "Forbidden", reason: `${name} is an event-handler attribute: projected text would run as script` };
  const forbidden = FORBIDDEN_ATTRIBUTES[name];
  if (forbidden !== undefined) return { kind: "Forbidden", reason: forbidden };
  if (BOOLEAN_PROPERTIES.includes(name)) return { kind: "BooleanProperty" };
  if (BOOLEAN_ATTRIBUTES.includes(name)) return { kind: "BooleanAttribute" };
  if (name === "value") return { kind: "ValueProperty" };
  if (URL_ATTRIBUTES.includes(name)) return { kind: "Url" };
  return { kind: "Attribute" };
};

const SAFE_SCHEMES: readonly string[] = ["http:", "https:", "mailto:", "tel:"];

// Browsers strip ASCII tab and newline anywhere in a URL, and leading and
// trailing C0 controls and spaces, before they look at the scheme — so
// "java\tscript:" is javascript:. Resolve exactly as the browser would, then
// look at the scheme it will actually use.
export type UrlVerdict = { readonly kind: "Safe" } | { readonly kind: "Unsafe"; readonly scheme: string };

export const checkUrl = (value: string, base: string): UrlVerdict => {
  try {
    const resolved = new URL(value, base);
    return SAFE_SCHEMES.includes(resolved.protocol) ? { kind: "Safe" } : { kind: "Unsafe", scheme: resolved.protocol };
  } catch {
    return { kind: "Unsafe", scheme: "unparseable" };
  }
};

export const SAFE_URL_SCHEMES = SAFE_SCHEMES;
