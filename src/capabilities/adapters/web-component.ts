// A reference adapter for Web Components (kemiller2002/limen#30). Loaded
// separately from the adapter host: an application imports it only if it
// uses it.
//
// Everything the engine may touch is declared up front: the element's tag,
// the properties props may set, the events that become facts (their detail
// must be JSON), and the methods commands may call. Anything else is refused
// by name — an undeclared property is an error, not a silent no-op — so the
// adapter's surface is exactly its declaration.

import { defineAdapter, type Adapter } from "./index.js";

export type WebComponentOptions = {
  readonly id: string;
  readonly version: number;
  // A custom element the application has already defined.
  readonly tagName: string;
  readonly properties: readonly string[];
  // DOM event type → the fact name the engine hears.
  readonly events: Readonly<Record<string, string>>;
  // Command name → the element's method it calls, with args as its argument list.
  readonly commands?: Readonly<Record<string, string>>;
};

const failure = (name: string, message: string): Error => Object.assign(new Error(message), { name });

const propsOf = (props: unknown, allowed: readonly string[]): readonly (readonly [string, unknown])[] => {
  if (typeof props !== "object" || props === null || Array.isArray(props)) throw failure("InvalidProps", "props must be an object");
  const entries = Object.entries(props);
  const unknown = entries.find(([name]) => !allowed.includes(name));
  if (unknown !== undefined) throw failure("UnknownProperty", `property ${unknown[0]} is not declared`);
  return entries;
};

export const webComponentAdapter = (options: WebComponentOptions): Adapter => defineAdapter({
  id: options.id,
  version: options.version,
  mount: ({ slot, emit }, props) => {
    const view = slot.ownerDocument.defaultView;
    if (view === null || view.customElements.get(options.tagName) === undefined) throw failure("NotDefined", `${options.tagName} is not a defined custom element`);
    const element = slot.ownerDocument.createElement(options.tagName);
    const apply = (next: unknown): void => { propsOf(next, options.properties).forEach(([name, value]) => { Reflect.set(element, name, value); }); };
    apply(props);
    const listeners = Object.entries(options.events).map(([type, name]) => {
      const listener = (event: Event): void => { emit(name, "detail" in event ? (event as CustomEvent<unknown>).detail ?? null : null); };
      element.addEventListener(type, listener);
      return () => element.removeEventListener(type, listener);
    });
    slot.append(element);
    const commands = Object.fromEntries(Object.entries(options.commands ?? {}).map(([name, method]) => [name, (args: unknown): unknown => {
      const target: unknown = Reflect.get(element, method);
      if (typeof target !== "function") throw failure("NotAMethod", `${method} is not a method`);
      return Reflect.apply(target, element, Array.isArray(args) ? args : [args]);
    }]));
    return {
      update: apply,
      commands,
      unmount: () => {
        listeners.forEach((remove) => remove());
        element.remove();
      },
    };
  },
});
