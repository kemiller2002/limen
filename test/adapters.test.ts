// Governed adapters (kemiller2002/limen#30, LCP-021) through the real kernel:
// mount, update, event, command and unmount; version mismatch; fault
// isolation and quarantine; nothing but JSON crossing; a slot removed by a
// projection. The reference Web Component adapter runs against a real custom
// element in jsdom, and both adapters again in Chromium
// (test/browser/packs/adapters/).

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import {
  ADAPTERS_CAPABILITY, adaptersCapability, decodeAdaptersFact, decodeAdaptersResult, defineAdapter, isJson,
  type Adapter, type AdaptersRequest, type AdaptersResult, type InstanceId,
} from "../dist/capabilities/adapters/index.js";
import { webComponentAdapter } from "../dist/capabilities/adapters/web-component.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EngineTransport, type ViewState } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const offer = { id: ADAPTERS_CAPABILITY.id as CapabilityId, version: ADAPTERS_CAPABILITY.version, fingerprint: ADAPTERS_CAPABILITY.fingerprint };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

// A counter widget: renders its props, emits on click, answers commands, and
// records its lifecycle so the test can see exactly what was called.
const lifecycle: string[] = [];
const counter = defineAdapter({
  id: "counter",
  version: 2,
  mount: ({ slot, emit }, props) => {
    const button = slot.ownerDocument.createElement("button");
    const render = (next: unknown): void => { button.textContent = `count ${String((next as { count?: number }).count)}`; };
    render(props);
    button.addEventListener("click", () => emit("clicked", { at: button.textContent }));
    slot.append(button);
    emit("ready", { during: "mount" });
    lifecycle.push("mount");
    return {
      update: (next) => { lifecycle.push("update"); render(next); },
      commands: { reset: () => { render({ count: 0 }); return { reset: true }; }, leak: () => button },
      unmount: () => { lifecycle.push("unmount"); button.remove(); },
    };
  },
});
const faulty = defineAdapter({
  id: "faulty",
  version: 1,
  mount: ({ slot, emit }) => {
    slot.append(slot.ownerDocument.createTextNode("faulty widget"));
    return {
      update: (props) => { if ((props as { explode?: boolean }).explode === true) throw new RangeError("widget internals: secret"); },
      commands: { leakNode: () => { emit("node", slot); return null; } },
      unmount: () => { throw new TypeError("cleanup failed"); },
    };
  },
});
const broken = defineAdapter({ id: "broken", version: 1, mount: () => { throw new SyntaxError("cannot start"); } });
const shapeless = { id: "shapeless", version: 1, mount: () => ({ nothing: true }) } as unknown as Adapter;

type Heard = { readonly order: string[]; readonly results: AdaptersResult[]; readonly facts: unknown[] };
// Each step is computed from what the engine has heard so far, as a real
// engine would: later requests name the instance ids earlier answers gave.
type Step = (heard: Heard) => { readonly view?: ViewState; readonly requests: readonly AdaptersRequest[] };

const drive = async (
  page: string, steps: readonly Step[], act: (document: Document, next: () => Promise<void>, heard: Heard) => Promise<void>,
  adapters: readonly Adapter[] = [counter, faulty, broken, shapeless], prepare: (document: Document) => void = () => {},
): Promise<Heard> => {
  lifecycle.length = 0;
  const heard: Heard = { order: [], results: [], facts: [] };
  const cursor = { step: 0, effect: 0, view: {} as ViewState };
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "CapabilityFact") {
        const decoded = decodeAdaptersFact(message.fact);
        assert.ok(decoded.ok, "every fact decodes");
        assert.deepEqual(JSON.parse(JSON.stringify(message.fact)), message.fact, "every fact is plain JSON");
        heard.facts.push(decoded.value);
        heard.order.push(`fact:${decoded.value.kind}`);
      }
      if (message.kind === "EffectResult" && message.result.kind === "CapabilityResult" && message.result.outcome.kind === "Completed") {
        const decoded = decodeAdaptersResult(message.result.outcome.result);
        assert.ok(decoded.ok, "every result decodes");
        // Effects in one batch run concurrently and answer as they finish; the
        // correlation id (a1, a2, …) puts each answer back at its request.
        heard.results[Number(message.result.correlationId.slice(1)) - 1] = decoded.value;
        heard.order.push(`result:${decoded.value.kind}`);
      }
      if (message.kind !== "Initialize" && message.kind !== "Event") return { view: cursor.view, effects: [], cancellations: [] };
      const step = steps[cursor.step]?.(heard) ?? { requests: [] };
      cursor.step += 1;
      cursor.view = step.view ?? cursor.view;
      const effects = step.requests.map((request) => {
        cursor.effect += 1;
        return { kind: "Capability" as const, correlationId: `a${cursor.effect}` as CorrelationId, capability: offer.id, version: 1, request };
      });
      return {
        view: cursor.view, effects, cancellations: [],
        ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted" as const, protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } } : {}),
      };
    },
  };
  return withDom(page, async (document) => {
    prepare(document);
    await new BrowserKernel(transport, document, undefined, { capabilities: [adaptersCapability({ adapters })], requireHandshake: true }).start();
    await sleep(10);
    const next = async (): Promise<void> => {
      document.getElementById("next")?.click();
      await sleep(10);
    };
    await act(document, next, heard);
    return { order: [...heard.order], results: [...heard.results], facts: [...heard.facts] };
  });
};

const PAGE = `
  <section data-adapter-slot="main"></section>
  <section data-adapter-slot="side"></section>
  <template data-if="panel"><section id="panel" data-adapter-slot="panel"></section></template>
  <button id="next" data-event="next">next</button>`;

const mountedAt = (heard: Heard, index: number): InstanceId => {
  const result = heard.results[index];
  assert.ok(result?.kind === "Mounted", `result ${index} is Mounted, not ${JSON.stringify(result)}`);
  return result.instance;
};
const kinds = (heard: Heard): readonly string[] => heard.results.map((result) => result.kind);

test("isJson admits plain data only", () => {
  assert.deepEqual([null, true, "s", 1, [1, { a: [null] }], Object.create(null)].map((value) => isJson(value)), [true, true, true, true, true, true]);
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.deepEqual([undefined, Number.NaN, () => 1, new Date(0), new Map(), cyclic].map((value) => isJson(value)), [false, false, false, false, false, false]);
});

test("mount, event, update, command, unmount: a deterministic lifecycle, and Mounted is heard before the instance's first fact", async () => {
  const heard = await drive(PAGE, [
    () => ({ requests: [{ operation: "mount", slot: { name: "main" }, adapter: { id: "counter", version: 2 }, props: { count: 1 } }] }),
    (h) => ({ requests: [{ operation: "update", instance: mountedAt(h, 0), props: { count: 5 } }, { operation: "command", instance: mountedAt(h, 0), name: "reset", args: null }] }),
    (h) => ({ requests: [{ operation: "command", instance: mountedAt(h, 0), name: "explode", args: null }, { operation: "unmount", instance: mountedAt(h, 0) }] }),
    (h) => ({ requests: [{ operation: "update", instance: mountedAt(h, 0), props: { count: 9 } }, { operation: "unmount", instance: mountedAt(h, 0) }] }),
  ], async (document, next) => {
    const button = (): HTMLButtonElement | null => document.querySelector("[data-adapter-slot=main] button");
    assert.equal(button()?.textContent, "count 1");
    button()?.click();
    await sleep(5);
    await next();
    assert.equal(button()?.textContent, "count 0", "update then the reset command, in order");
    await next();
    assert.equal(document.querySelector("[data-adapter-slot=main]")?.childNodes.length, 0, "unmount empties the slot");
    await next();
  });
  assert.deepEqual(heard.order.slice(0, 3), ["result:Mounted", "fact:AdapterEvent", "fact:AdapterEvent"], "the fact emitted during mount waits for Mounted");
  assert.deepEqual(heard.facts.map((fact) => (fact as { name?: string; data?: unknown }).name), ["ready", "clicked"]);
  assert.deepEqual(heard.facts[1], { kind: "AdapterEvent", instance: mountedAt(heard, 0), name: "clicked", data: { at: "count 1" } });
  assert.deepEqual(kinds(heard), ["Mounted", "Updated", "CommandDone", "UnknownCommand", "Unmounted", "Stale", "Stale"]);
  assert.deepEqual(heard.results[2], { kind: "CommandDone", result: { reset: true } });
  assert.deepEqual(lifecycle, ["mount", "update", "unmount"]);
});

test("identity and version: an unknown adapter, a version mismatch, an occupied slot and a missing slot are answered, not guessed", async () => {
  const heard = await drive(PAGE, [
    () => ({ requests: [
      { operation: "mount", slot: { name: "main" }, adapter: { id: "nope", version: 1 }, props: {} },
      { operation: "mount", slot: { name: "main" }, adapter: { id: "counter", version: 1 }, props: {} },
      { operation: "mount", slot: { name: "main" }, adapter: { id: "counter", version: 2 }, props: { count: 0 } },
      { operation: "mount", slot: { name: "main" }, adapter: { id: "counter", version: 2 }, props: { count: 0 } },
      { operation: "mount", slot: { name: "nowhere" }, adapter: { id: "counter", version: 2 }, props: { count: 0 } },
      { operation: "describe" },
    ] }),
  ], async () => {});
  assert.deepEqual(heard.results.slice(0, 2), [{ kind: "UnknownAdapter" }, { kind: "VersionMismatch", registered: 2 }]);
  const id = mountedAt(heard, 2);
  assert.deepEqual(heard.results.slice(3), [
    { kind: "SlotOccupied", instance: id },
    { kind: "NotFound" },
    { kind: "Adapters", registered: [{ id: "counter", version: 2 }, { id: "faulty", version: 1 }, { id: "broken", version: 1 }, { id: "shapeless", version: 1 }] },
  ]);
});

test("fault isolation: a throwing adapter is quarantined by exception name only; the other instance and the application keep working", async () => {
  const heard = await drive(PAGE, [
    () => ({ requests: [
      { operation: "mount", slot: { name: "main" }, adapter: { id: "faulty", version: 1 }, props: {} },
      { operation: "mount", slot: { name: "side" }, adapter: { id: "counter", version: 2 }, props: { count: 3 } },
      { operation: "mount", slot: { name: "panel" }, adapter: { id: "broken", version: 1 }, props: {} },
    ], view: { panel: true } }),
    (h) => ({ requests: [
      { operation: "update", instance: mountedAt(h, 0), props: { explode: true } },
      { operation: "update", instance: mountedAt(h, 0), props: {} },
      { operation: "command", instance: mountedAt(h, 0), name: "leakNode", args: null },
      { operation: "update", instance: mountedAt(h, 1), props: { count: 4 } },
    ] }),
    (h) => ({ requests: [{ operation: "unmount", instance: mountedAt(h, 0) }, { operation: "update", instance: mountedAt(h, 0), props: {} }] }),
  ], async (document, next) => {
    assert.equal(document.getElementById("panel")?.childNodes.length, 0, "a failed mount leaves the slot empty");
    await next();
    assert.equal(document.querySelector("[data-adapter-slot=side] button")?.textContent, "count 4", "the healthy instance is unaffected");
    await next();
    assert.equal(document.querySelector("[data-adapter-slot=main]")?.childNodes.length, 0, "a throwing unmount still empties the slot");
  });
  assert.deepEqual(heard.results.slice(2), [
    { kind: "Faulted", phase: "mount", reason: "SyntaxError" },
    { kind: "Faulted", phase: "update", reason: "RangeError" },
    { kind: "Faulted", phase: "update", reason: "RangeError" },
    { kind: "Faulted", phase: "update", reason: "RangeError" },
    { kind: "Updated" },
    { kind: "Faulted", phase: "unmount", reason: "TypeError" },
    { kind: "Stale", reason: "disposed" },
  ]);
  assert.ok(!JSON.stringify(heard).includes("secret"), "no exception message crosses");
});

test("nothing but JSON crosses: a DOM node emitted or returned quarantines the instance; a shapeless instance is refused", async () => {
  const heard = await drive(PAGE, [
    () => ({ requests: [
      { operation: "mount", slot: { name: "main" }, adapter: { id: "faulty", version: 1 }, props: {} },
      { operation: "mount", slot: { name: "side" }, adapter: { id: "counter", version: 2 }, props: { count: 0 } },
      { operation: "mount", slot: { name: "panel" }, adapter: { id: "shapeless", version: 1 }, props: {} },
    ], view: { panel: true } }),
    (h) => ({ requests: [
      { operation: "command", instance: mountedAt(h, 0), name: "leakNode", args: null },
      { operation: "command", instance: mountedAt(h, 1), name: "leak", args: null },
    ] }),
    // Quarantine applies from the fault on: a command sent after it is refused.
    (h) => ({ requests: [{ operation: "command", instance: mountedAt(h, 1), name: "reset", args: null }] }),
  ], async (_document, next) => { await next(); await next(); });
  assert.deepEqual(heard.results[2], { kind: "Faulted", phase: "mount", reason: "invalid-instance" });
  const [faultyId, counterId] = [mountedAt(heard, 0), mountedAt(heard, 1)];
  assert.deepEqual(heard.results.slice(3), [
    { kind: "CommandDone", result: null },
    { kind: "Faulted", phase: "command", reason: "not-json" },
    { kind: "Faulted", phase: "command", reason: "not-json" },
  ]);
  assert.deepEqual(heard.facts.filter((fact) => (fact as { kind: string }).kind === "AdapterFaulted"), [{ kind: "AdapterFaulted", instance: faultyId, phase: "emit", reason: "not-json" }]);
  assert.ok(counterId !== faultyId);
});

test("a slot removed by a projection unmounts its instance: SlotRemoved once, then Stale", async () => {
  const heard = await drive(PAGE, [
    () => ({ view: { panel: true }, requests: [{ operation: "mount", slot: { name: "panel" }, adapter: { id: "counter", version: 2 }, props: { count: 1 } }] }),
    () => ({ view: { panel: false }, requests: [] }),
    (h) => ({ requests: [{ operation: "update", instance: mountedAt(h, 0), props: { count: 2 } }] }),
  ], async (_document, next) => {
    await next();
    await next();
  });
  assert.deepEqual(heard.facts.filter((fact) => (fact as { kind: string }).kind === "SlotRemoved"), [{ kind: "SlotRemoved", instance: mountedAt(heard, 0) }]);
  assert.deepEqual(heard.results.at(-1), { kind: "Stale", reason: "disposed" });
  assert.deepEqual(lifecycle, ["mount", "unmount"]);
});

test("the reference Web Component adapter: declared properties, events and commands only", async () => {
  const page = `<section data-adapter-slot="rating"></section><section data-adapter-slot="other"></section><button id="next" data-event="next">next</button>`;
  const rating = webComponentAdapter({ id: "rating", version: 1, tagName: "x-rating", properties: ["value", "max"], events: { change: "rated" }, commands: { bump: "bump" } });
  const undefinedTag = webComponentAdapter({ id: "missing", version: 1, tagName: "x-missing", properties: [], events: {} });
  const heard = await drive(page, [
    () => ({ requests: [
      { operation: "mount", slot: { name: "rating" }, adapter: { id: "rating", version: 1 }, props: { value: 2, max: 5 } },
      { operation: "mount", slot: { name: "other" }, adapter: { id: "missing", version: 1 }, props: {} },
    ] }),
    (h) => ({ requests: [
      { operation: "command", instance: mountedAt(h, 0), name: "bump", args: [2] },
      { operation: "update", instance: mountedAt(h, 0), props: { innerHTML: "<img src=x onerror=alert(1)>" } },
    ] }),
  ], async (document, next) => {
    const element = document.querySelector("x-rating");
    assert.ok(element !== null);
    assert.deepEqual([Reflect.get(element, "value"), Reflect.get(element, "max")], [2, 5]);
    element.dispatchEvent(new (document.defaultView?.CustomEvent ?? CustomEvent)("change", { detail: { value: 3 } }));
    await sleep(5);
    await next();
    assert.equal(element.innerHTML, "", "an undeclared property is refused, never written");
  }, [rating, undefinedTag], (document) => {
    // A minimal custom element: a value, a maximum, and a method.
    const view = document.defaultView;
    assert.ok(view !== null);
    view.customElements.define("x-rating", class extends view.HTMLElement {
      value = 0;
      max = 5;
      bump(by: number): number { this.value = Math.min(this.max, this.value + by); return this.value; }
    });
  });
  assert.deepEqual(heard.results.slice(1), [
    { kind: "Faulted", phase: "mount", reason: "NotDefined" },
    { kind: "CommandDone", result: 4 },
    { kind: "Faulted", phase: "update", reason: "UnknownProperty" },
  ]);
  assert.deepEqual(heard.facts, [{ kind: "AdapterEvent", instance: mountedAt(heard, 0), name: "rated", data: { value: 3 } }]);
});

test("the adapters pack passes the shared provider conformance suite", async () => {
  await withDom(PAGE, async (document) => {
    assert.deepEqual(await runProviderConformance(adaptersCapability({ adapters: [counter] }), {
      document,
      decodeResult: decodeAdaptersResult,
      valid: [{ name: "describe", payload: { operation: "describe" } }, { name: "unmount stale", payload: { operation: "unmount", instance: "x.1" } }],
      malformed: [
        { name: "no version", payload: { operation: "mount", slot: { name: "main" }, adapter: { id: "counter" }, props: {} } },
        { name: "no props", payload: { operation: "mount", slot: { name: "main" }, adapter: { id: "counter", version: 2 } } },
        { name: "extra", payload: { operation: "describe", element: {} } },
      ],
      cancellable: { name: "describe", payload: { operation: "describe" } },
    }), []);
  });
});
