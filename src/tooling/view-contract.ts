// Static validation of a Limen page against its view contract (LCP-042).
//
// A view contract is a small, language-neutral JSON document kept beside the
// page (`index.html` → `index.view.json`). It states what the engine projects
// and which semantic events it accepts:
//
//   {
//     "view":   { "count": "number", "rows": { "list": { "id": "number", "label": "string" } } },
//     "events": { "increment": {}, "remove": { "item": "rows" }, "rename": { "value": true } }
//   }
//
// Value kinds are "string", "number", "boolean" or "scalar" (any of the
// three); a list's item fields are scalars, because a ViewItem is flat. An
// event's `item` names the data-each list it is sent from (so it carries that
// row's key); `value` says whether it carries a form control's value.
//
// Three checks share it:
//   - checkPage: the HTML's bindings against the contract, without a browser;
//   - checkProjection: one ViewState an engine produced against the contract;
//   - checkEvent: one SemanticEvent the kernel sent against the contract.
// The contract says nothing about what a key *means*; the binding model stays
// expression-free. Tooling, not Core: nothing here runs in a shipped page.

import type { SemanticEvent, ViewState, ViewValue } from "../protocol.js";
import { bindableElement, boundNames, classifyAttribute } from "../kernel/binding-policy.js";

export type ValueKind = "string" | "number" | "boolean" | "scalar";
export type ViewEntry = ValueKind | { readonly list: Readonly<Record<string, ValueKind>> };
export type EventEntry = { readonly item?: string; readonly value?: boolean };
export type ViewContract = {
  readonly view: Readonly<Record<string, ViewEntry>>;
  readonly events: Readonly<Record<string, EventEntry>>;
};

export type Diagnostic = {
  readonly file: string;
  readonly line: number;
  readonly element: string;
  readonly binding: string;
  readonly message: string;
  readonly expected: string;
};

export type ContractParse = { readonly ok: true; readonly contract: ViewContract } | { readonly ok: false; readonly errors: readonly string[] };

// ---------------------------------------------------------------------------
// The contract document
// ---------------------------------------------------------------------------

const KINDS: readonly string[] = ["string", "number", "boolean", "scalar"];
const isKind = (value: unknown): value is ValueKind => typeof value === "string" && KINDS.includes(value);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

const parseEntry = (key: string, value: unknown): readonly string[] => {
  if (isKind(value)) return [];
  if (isRecord(value) && Object.keys(value).length === 1 && isRecord(value.list)) {
    return Object.entries(value.list).flatMap(([field, kind]) => (isKind(kind) ? [] : [`view.${key}.list.${field}: expected one of ${KINDS.join(", ")}`]));
  }
  return [`view.${key}: expected one of ${KINDS.join(", ")}, or { "list": { field: kind } }`];
};

const parseEvent = (name: string, value: unknown, view: Readonly<Record<string, unknown>>): readonly string[] => {
  if (!isRecord(value)) return [`events.${name}: expected an object`];
  const unknownFields = Object.keys(value).filter((field) => field !== "item" && field !== "value").map((field) => `events.${name}.${field}: unknown field`);
  const item = value.item;
  const itemErrors = item === undefined ? []
    : typeof item !== "string" ? [`events.${name}.item: expected a list name`]
    : isRecord(view[item]) ? [] : [`events.${name}.item: "${item}" is not a list in view`];
  const valueErrors = value.value === undefined || typeof value.value === "boolean" ? [] : [`events.${name}.value: expected a boolean`];
  return [...unknownFields, ...itemErrors, ...valueErrors];
};

// The contract is data; this is the only door from JSON to a ViewContract.
export const parseViewContract = (json: unknown): ContractParse => {
  if (!isRecord(json) || !isRecord(json.view) || !isRecord(json.events)) return { ok: false, errors: ["expected { \"view\": {…}, \"events\": {…} }"] };
  const view = json.view;
  const events = json.events;
  const errors = [
    ...Object.keys(json).filter((key) => !["view", "events", "doc"].includes(key)).map((key) => `${key}: unknown field`),
    ...Object.entries(view).flatMap(([key, value]) => parseEntry(key, value)),
    ...Object.entries(events).flatMap(([name, value]) => parseEvent(name, value, view)),
  ];
  if (errors.length > 0) return { ok: false, errors };
  const entries = Object.entries(view).flatMap(([key, value]): readonly (readonly [string, ViewEntry])[] => {
    if (isKind(value)) return [[key, value]];
    if (!isRecord(value) || !isRecord(value.list)) return [];
    return [[key, { list: Object.fromEntries(Object.entries(value.list).flatMap(([field, kind]) => (isKind(kind) ? [[field, kind]] : []))) }]];
  });
  const declared = Object.entries(events).map(([name, value]): readonly [string, EventEntry] => {
    const record = isRecord(value) ? value : {};
    return [name, { ...(typeof record.item === "string" ? { item: record.item } : {}), ...(typeof record.value === "boolean" ? { value: record.value } : {}) }];
  });
  return { ok: true, contract: { view: Object.fromEntries(entries), events: Object.fromEntries(declared) } };
};

// ---------------------------------------------------------------------------
// Reading bindings out of HTML — a tokenizer, not a DOM: no browser needed
// ---------------------------------------------------------------------------

export type Tag = {
  readonly line: number;
  readonly name: string;
  readonly closing: boolean;
  readonly attributes: ReadonlyMap<string, string>;
};

const TAG = /<!--[\s\S]*?-->|<(script|style)\b((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*>[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const lineAt = (html: string, index: number): number => html.slice(0, index).split("\n").length;

// A <script> or <style> element's content is text, never tags; its opening
// tag is still read, so a binding on the element itself is seen.
export const tagsOf = (html: string): readonly Tag[] =>
  Array.from(html.matchAll(TAG)).flatMap((match): readonly Tag[] => {
    const raw = match[1];
    const name = raw ?? match[4];
    if (name === undefined) return [];
    const source = (raw === undefined ? match[5] : match[2]) ?? "";
    const attributes = new Map(Array.from(source.matchAll(ATTRIBUTE), (attribute): [string, string] => [attribute[1]?.toLowerCase() ?? "", attribute[2] ?? attribute[3] ?? attribute[4] ?? ""]));
    return [{ line: lineAt(html, match.index), name: name.toLowerCase(), closing: raw === undefined && match[3] === "/", attributes }];
  });

// ---------------------------------------------------------------------------
// checkPage
// ---------------------------------------------------------------------------

const FORM_CONTROLS: readonly string[] = ["input", "select", "textarea"];

// A rendered row (data-limen-key, written by the server renderer) is in its
// list's item scope until its element closes, like the template it came from.
type Frame = { readonly kind: "each"; readonly list: string; readonly row?: { readonly element: string; readonly open: number } } | { readonly kind: "other" };
type Scope = { readonly absence: string; readonly fields: Readonly<Record<string, ViewEntry>> };

const describe = (entry: ViewEntry | undefined): string => (entry === undefined ? "absent" : typeof entry === "string" ? entry : "list");
const keysOf = (scope: Scope): string => Object.keys(scope.fields).sort().join(", ") || "(none)";
const render = (tag: Tag): string => `<${tag.name}${Array.from(tag.attributes, ([name, value]) => (name.startsWith("data-") ? ` ${name}="${value}"` : "")).join("")}>`;

const scopeFor = (contract: ViewContract, frames: readonly Frame[]): Scope => {
  const each = [...frames].reverse().find((frame): frame is { readonly kind: "each"; readonly list: string } => frame.kind === "each");
  if (each === undefined) return { absence: "is not in the view contract", fields: contract.view };
  const entry = contract.view[each.list];
  return { absence: `is not a field of ${each.list}'s items`, fields: entry !== undefined && typeof entry !== "string" ? entry.list : {} };
};

const currentList = (frames: readonly Frame[]): string | undefined =>
  [...frames].reverse().find((frame): frame is { readonly kind: "each"; readonly list: string } => frame.kind === "each")?.list;

const checkTag = (file: string, contract: ViewContract, tag: Tag, frames: readonly Frame[]): readonly Diagnostic[] => {
  const scope = scopeFor(contract, frames);
  const at = (binding: string, message: string, expected: string): Diagnostic => ({ file, line: tag.line, element: render(tag), binding, message, expected });
  const lookup = (binding: string, key: string, accept: (entry: ViewEntry) => string | undefined): readonly Diagnostic[] => {
    const entry = scope.fields[key];
    if (entry === undefined) return [at(binding, `"${key}" ${scope.absence}`, `one of: ${keysOf(scope)}`)];
    const problem = accept(entry);
    return problem === undefined ? [] : [at(binding, `"${key}" is ${describe(entry)}`, problem)];
  };
  const scalar = (entry: ViewEntry): string | undefined => (typeof entry === "string" ? undefined : "a string, number, boolean or scalar, not a list");
  const attribute = (name: string): string | undefined => tag.attributes.get(name);
  const isTemplate = tag.name === "template";

  const misplaced = ["data-if", "data-each"].flatMap((name) => (attribute(name) !== undefined && !isTemplate ? [at(name, `${name} is only supported on <template>`, "<template>")] : []));

  const each = attribute("data-each");
  const eachChecks = each === undefined || !isTemplate ? [] : (() => {
    if (currentList(frames) !== undefined) return [at("data-each", `data-each="${each}" is nested in another data-each; list items are flat`, "a top-level list")];
    const listed = lookup("data-each", each, (entry) => (typeof entry === "string" ? "a list" : undefined));
    const key = attribute("data-key");
    const entry = contract.view[each];
    if (key === undefined || key === "") return [...listed, at("data-key", `data-each="${each}" has no data-key`, "data-key naming an item field")];
    if (entry === undefined || typeof entry === "string") return listed;
    return entry.list[key] === undefined ? [...listed, at("data-key", `"${key}" is not a field of ${each}'s items`, `one of: ${Object.keys(entry.list).sort().join(", ")}`)] : listed;
  })();

  const condition = attribute("data-if");
  const ifChecks = condition === undefined || !isTemplate ? [] : lookup("data-if", condition, (entry) => (entry === "boolean" ? undefined : "boolean — data-if shows its content when the value is true"));

  const text = attribute("data-text");
  const textChecks = text === undefined ? [] : lookup("data-text", text, scalar);

  // The kernel's own binding policy (src/kernel/binding-policy.ts): a target
  // it would refuse when the page starts is reported here, before it runs.
  const projectedNames = Array.from(tag.attributes.keys()).filter((name) => name === "data-text" || name.startsWith("data-bind-"));
  const unbindable = projectedNames.length > 0 ? bindableElement(tag.name, (name) => tag.attributes.get(name) ?? null, boundNames(Array.from(tag.attributes.keys()))) : undefined;
  const elementChecks = unbindable === undefined ? [] : [at(projectedNames[0] ?? "data-text", unbindable, "a binding on an element that does not load or run code")];

  const bindChecks = Array.from(tag.attributes).filter(([name]) => name.startsWith("data-bind-")).flatMap(([name, key]) => {
    const property = name.slice("data-bind-".length);
    const target = classifyAttribute(property);
    if (target.kind === "Forbidden") return [at(name, `${name} is not a projection target: ${target.reason}`, "a safe attribute, a boolean property or value")];
    return lookup(name, key, (entry) => {
      const notScalar = scalar(entry);
      if (notScalar !== undefined) return notScalar;
      if (target.kind === "BooleanProperty" && entry !== "boolean") return `boolean — ${property} is set with Boolean(value), so "false" would be true`;
      return target.kind === "BooleanAttribute" && entry !== "boolean" ? `boolean — ${property} is a boolean attribute, present whenever the value is truthy` : undefined;
    });
  });

  const event = attribute("data-event");
  const eventChecks = event === undefined ? [] : (() => {
    const declared = contract.events[event];
    if (declared === undefined) return [at("data-event", `"${event}" is not an event the engine accepts`, `one of: ${Object.keys(contract.events).sort().join(", ") || "(none)"}`)];
    const list = currentList(frames);
    const itemChecks = declared.item === list ? []
      : declared.item === undefined ? [at("data-event", `"${event}" is sent from a ${list ?? "top-level"} row, so it carries a key the engine does not expect`, "outside any data-each")]
      : [at("data-event", `"${event}" must be sent from a row of ${declared.item}`, `inside data-each="${declared.item}"`)];
    const carriesValue = FORM_CONTROLS.includes(tag.name);
    const valueChecks = declared.value === undefined || declared.value === carriesValue ? []
      : [at("data-event", declared.value ? `"${event}" expects a value, but <${tag.name}> sends none` : `"${event}" expects no value, but <${tag.name}> sends its value`, declared.value ? "an input, select or textarea" : "an element that is not a form control")];
    return [...itemChecks, ...valueChecks];
  })();

  const trigger = attribute("data-on");
  const triggerChecks = trigger !== undefined && event === undefined ? [at("data-on", "data-on without data-event does nothing", "data-event on the same element")] : [];

  return [...misplaced, ...eachChecks, ...ifChecks, ...textChecks, ...elementChecks, ...bindChecks, ...eventChecks, ...triggerChecks];
};

const VOID_ELEMENTS: readonly string[] = ["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];

export const checkPage = (file: string, html: string, contract: ViewContract): readonly Diagnostic[] => {
  // lastList: the list of the most recent data-each template, which a
  // rendered row that follows it belongs to.
  type Walk = { readonly frames: readonly Frame[]; readonly diagnostics: readonly Diagnostic[]; readonly lastList: string | undefined };
  const top = (frames: readonly Frame[]): Frame | undefined => frames[frames.length - 1];
  const withTopRow = (frames: readonly Frame[], change: number): readonly Frame[] => {
    const frame = top(frames);
    if (frame?.kind !== "each" || frame.row === undefined) return frames;
    const open = frame.row.open + change;
    return open === 0 ? frames.slice(0, -1) : [...frames.slice(0, -1), { ...frame, row: { ...frame.row, open } }];
  };
  const walked = tagsOf(html).reduce<Walk>((state, tag) => {
    const row = top(state.frames);
    const inRowOf = row?.kind === "each" && row.row !== undefined && row.row.element === tag.name ? row : undefined;
    if (tag.closing) {
      if (inRowOf !== undefined) return { ...state, frames: withTopRow(state.frames, -1) };
      if (tag.name !== "template") return state;
      const closed = top(state.frames);
      return { ...state, frames: state.frames.slice(0, -1), lastList: closed?.kind === "each" && closed.row === undefined ? closed.list : state.lastList };
    }
    const key = tag.attributes.get("data-limen-key");
    const rendered = key === undefined || tag.name === "template" || VOID_ELEMENTS.includes(tag.name) ? undefined : state.lastList;
    if (key !== undefined && rendered === undefined && tag.name !== "template") {
      const orphan: Diagnostic = { file, line: tag.line, element: render(tag), binding: "data-limen-key", message: "a rendered row with no data-each template before it", expected: "the row's <template data-each> immediately before it, as the renderer writes it" };
      return { ...state, diagnostics: [...state.diagnostics, orphan, ...checkTag(file, contract, tag, state.frames)] };
    }
    const frames = rendered !== undefined ? [...state.frames, { kind: "each" as const, list: rendered, row: { element: tag.name, open: 1 } }]
      : inRowOf !== undefined && !VOID_ELEMENTS.includes(tag.name) ? withTopRow(state.frames, 1) : state.frames;
    const diagnostics = [...state.diagnostics, ...checkTag(file, contract, tag, frames)];
    if (tag.name !== "template") return { ...state, frames, diagnostics };
    const list = tag.attributes.get("data-each");
    return { ...state, frames: [...frames, list === undefined ? { kind: "other" } : { kind: "each", list }], diagnostics };
  }, { frames: [], diagnostics: [], lastList: undefined });
  return [...walked.diagnostics].sort((a, b) => a.line - b.line || a.binding.localeCompare(b.binding));
};

export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  `${diagnostic.file}:${diagnostic.line} ${diagnostic.element} ${diagnostic.binding}: ${diagnostic.message} (expected ${diagnostic.expected})`;

// ---------------------------------------------------------------------------
// checkProjection / checkEvent — the same contract against what an engine did
// ---------------------------------------------------------------------------

const kindMatches = (kind: ValueKind, value: ViewValue | undefined): boolean =>
  kind === "scalar" ? ["string", "number", "boolean"].includes(typeof value) : typeof value === kind;

export const checkProjection = (view: ViewState, contract: ViewContract): readonly string[] => {
  const declared = Object.entries(contract.view).flatMap(([key, entry]) => {
    const value = view[key];
    if (value === undefined) return [`view.${key}: missing (expected ${describe(entry)})`];
    if (typeof entry === "string") return kindMatches(entry, value) ? [] : [`view.${key}: ${Array.isArray(value) ? "list" : typeof value}, expected ${entry}`];
    if (!Array.isArray(value)) return [`view.${key}: ${typeof value}, expected list`];
    return value.flatMap((item, index) => [
      ...Object.entries(entry.list).flatMap(([field, kind]) => (kindMatches(kind, item[field]) ? [] : [`view.${key}[${index}].${field}: ${item[field] === undefined ? "missing" : typeof item[field]}, expected ${kind}`])),
      ...Object.keys(item).filter((field) => entry.list[field] === undefined).map((field) => `view.${key}[${index}].${field}: not in the contract`),
    ]);
  });
  const undeclared = Object.keys(view).filter((key) => contract.view[key] === undefined).map((key) => `view.${key}: not in the contract`);
  return [...declared, ...undeclared];
};

export const checkEvent = (event: SemanticEvent, contract: ViewContract): readonly string[] => {
  const declared = contract.events[event.name];
  if (declared === undefined) return [`event ${event.name}: not an event the engine accepts`];
  const keyed = event.key !== undefined;
  return [
    ...(keyed === (declared.item !== undefined) ? [] : [`event ${event.name}: ${keyed ? "carries a row key" : "carries no row key"}, expected ${declared.item === undefined ? "none" : `a row of ${declared.item}`}`]),
    ...(declared.value === undefined || declared.value === (event.value !== undefined) ? [] : [`event ${event.name}: ${event.value !== undefined ? "carries a value" : "carries no value"}, expected ${declared.value ? "a value" : "none"}`]),
  ];
};
