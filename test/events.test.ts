// The rich browser event facts pack (kemiller2002/limen#29, LCP-020) through
// the real kernel. Reference tests: keyboard modifiers, IME composition,
// JSON serialization, simple-event backward compatibility; pointer drag and
// real key presses are proven with trusted input in Chromium
// (test/browser/packs/events/).

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { EVENTS_CAPABILITY, decodeEventsResult, decodeRichEvent, eventsCapability, type RichEvent } from "../dist/capabilities/events/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type EngineTransport, type SemanticEvent, type ViewState } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const offer = { id: EVENTS_CAPABILITY.id as CapabilityId, version: EVENTS_CAPABILITY.version, fingerprint: EVENTS_CAPABILITY.fingerprint };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

type Heard = { readonly facts: RichEvent[]; readonly events: SemanticEvent[] };

const engine = (view: ViewState, select = true): { readonly transport: EngineTransport; readonly heard: Heard } => {
  const heard: Heard = { facts: [], events: [] };
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "CapabilityFact") {
        const decoded = decodeRichEvent(message.fact);
        assert.ok(decoded.ok, "every fact decodes with the generated decoder");
        assert.deepEqual(JSON.parse(JSON.stringify(message.fact)), message.fact, "every fact is plain JSON");
        heard.facts.push(decoded.value);
      }
      if (message.kind === "Event") heard.events.push(message.event);
      return {
        view, effects: [], cancellations: [],
        ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: select ? [offer] : [] } } : {}),
      };
    },
  };
  return { transport, heard };
};

const run = async (body: string, act: (document: Document, fire: (id: string, type: string, fields?: Record<string, unknown>) => Event) => Promise<void>, view: ViewState = {}, select = true): Promise<Heard> => {
  const { transport, heard } = engine(view, select);
  return withDom(body, async (document) => {
    await new BrowserKernel(transport, document, undefined, { capabilities: [eventsCapability()] }).start();
    const window = document.defaultView;
    assert.ok(window !== null);
    // jsdom lacks some event classes; the pack reads fields by name, so a
    // plain Event carrying the same fields is what a browser event looks like to it.
    const fire = (id: string, type: string, fields: Record<string, unknown> = {}): Event => {
      const target = document.getElementById(id);
      assert.ok(target !== null, `#${id}`);
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.entries(fields).forEach(([name, value]) => Object.defineProperty(event, name, { value }));
      target.dispatchEvent(event);
      return event;
    };
    await act(document, fire);
    await sleep(30);
    return { facts: [...heard.facts], events: [...heard.events] };
  });
};

test("keyboard modifiers: key, code and modifiers are reported; the key filter decides what counts and what is prevented", async () => {
  const outcomes: boolean[] = [];
  const heard = await run(`<input id="field" data-rich-event="shortcut" data-rich-on="keydown" data-rich-facts="keyboard modifiers" data-rich-keys="Enter Escape" data-rich-prevent>`, async (_document, fire) => {
    outcomes.push(fire("field", "keydown", { key: "a", code: "KeyA" }).defaultPrevented);
    outcomes.push(fire("field", "keydown", { key: "Enter", code: "Enter", ctrlKey: true, shiftKey: true }).defaultPrevented);
    outcomes.push(fire("field", "keydown", { key: "Escape", code: "Escape", repeat: true }).defaultPrevented);
  });
  assert.deepEqual(outcomes, [false, true, true], "only the declared keys are prevented");
  assert.deepEqual(heard.facts, [
    { name: "shortcut", type: "keydown", modifiers: { alt: false, ctrl: true, meta: false, shift: true }, keyboard: { key: "Enter", code: "Enter", repeat: false, composing: false } },
    { name: "shortcut", type: "keydown", modifiers: { alt: false, ctrl: false, meta: false, shift: false }, keyboard: { key: "Escape", code: "Escape", repeat: true, composing: false } },
  ]);
});

test("payloads are opt-in: only the groups a listener asked for are present, and coordinates only when requested", async () => {
  const heard = await run(`
    <div id="plain" data-rich-event="tap" data-rich-on="pointerdown" data-rich-facts="pointer"></div>
    <div id="placed" data-rich-event="place" data-rich-on="pointerdown" data-rich-facts="pointer coordinates"></div>
    <div id="bare" data-rich-event="bare" data-rich-on="pointerdown"></div>`, async (_document, fire) => {
    const pointer = { pointerType: "mouse", pointerId: 1, button: 0, buttons: 1, isPrimary: true, clientX: 10.5, clientY: 20, ctrlKey: true };
    fire("plain", "pointerdown", pointer);
    fire("placed", "pointerdown", pointer);
    fire("bare", "pointerdown", pointer);
  });
  assert.deepEqual(heard.facts, [
    { name: "tap", type: "pointerdown", pointer: { pointerType: "mouse", pointerId: 1, button: 0, buttons: 1, isPrimary: true } },
    { name: "place", type: "pointerdown", pointer: { pointerType: "mouse", pointerId: 1, button: 0, buttons: 1, isPrimary: true, x: 10.5, y: 20 } },
    { name: "bare", type: "pointerdown" },
  ]);
});

test("IME composition: uncommitted text is never reported; the committed text arrives at compositionend", async () => {
  const heard = await run(`
    <input id="field" data-rich-event="typed" data-rich-on="input" data-rich-facts="input value">
    <input id="ime" data-rich-event="ime" data-rich-on="compositionend" data-rich-facts="composition">
    <input id="update" data-rich-event="imeUpdate" data-rich-on="compositionupdate" data-rich-facts="composition">`, async (document, fire) => {
    const field = document.getElementById("field");
    assert.ok(field instanceof HTMLInputElement);
    field.value = "に";
    fire("field", "input", { inputType: "insertCompositionText", data: "に", isComposing: true });
    field.value = "日本";
    fire("field", "input", { inputType: "insertCompositionText", data: "日本", isComposing: true });
    fire("update", "compositionupdate", { data: "にほ" });
    fire("ime", "compositionend", { data: "日本" });
    field.value = "日本!";
    fire("field", "input", { inputType: "insertText", data: "!", isComposing: false });
  });
  assert.deepEqual(heard.facts, [
    { name: "imeUpdate", type: "compositionupdate", composition: { phase: "update" } },
    { name: "ime", type: "compositionend", composition: { phase: "end", committed: "日本" } },
    { name: "typed", type: "input", value: "日本!", input: { inputType: "insertText", data: "!" } },
  ]);
});

test("high-volume events can be coalesced to the latest per frame, on request", async () => {
  const heard = await run(`<div id="canvas" data-rich-event="move" data-rich-on="pointermove" data-rich-facts="pointer coordinates" data-rich-coalesce="frame"></div>`, async (_document, fire) => {
    [1, 2, 3, 4, 5].forEach((x) => fire("canvas", "pointermove", { pointerType: "pen", pointerId: 7, button: -1, buttons: 1, isPrimary: true, clientX: x, clientY: 0 }));
  });
  assert.deepEqual(heard.facts.map((fact) => fact.pointer?.x), [5]);
});

test("coalescing never reorders: a discrete event flushes the moves before it and is never merged", async () => {
  const heard = await run(`<div id="canvas" data-rich-event="drag" data-rich-on="pointerdown pointermove pointerup" data-rich-facts="pointer coordinates" data-rich-coalesce="frame"></div>`, async (_document, fire) => {
    const at = (x: number, buttons: number) => ({ pointerType: "mouse", pointerId: 1, button: 0, buttons, isPrimary: true, clientX: x, clientY: 0 });
    fire("canvas", "pointermove", at(1, 0));
    fire("canvas", "pointermove", at(2, 0));
    fire("canvas", "pointerdown", at(2, 1));
    fire("canvas", "pointermove", at(3, 1));
    fire("canvas", "pointermove", at(4, 1));
    fire("canvas", "pointerup", at(4, 0));
  });
  assert.deepEqual(heard.facts.map((fact) => `${fact.type}@${String(fact.pointer?.x)}`), ["pointermove@2", "pointerdown@2", "pointermove@4", "pointerup@4"]);
});

test("rows carry the engine-projected key; templates mounted later are bound; once fires once", async () => {
  const heard = await run(`
    <ul><template data-each="rows" data-key="id"><li data-bind-data-rich-key="id"><span data-bind-id="domId" data-rich-event="pick" data-rich-on="click" data-rich-once></span></li></template></ul>`, async (_document, fire) => {
    fire("row-b", "click");
    fire("row-b", "click");
    fire("row-a", "click");
  }, { rows: [{ id: "a", domId: "row-a" }, { id: "b", domId: "row-b" }] });
  assert.deepEqual(heard.facts.map((fact) => [fact.name, fact.key]), [["pick", "b"], ["pick", "a"]]);
});

test("declarations the browser could not honour are refused, and describe says why", async () => {
  const body = `
    <div data-rich-event="scroller" data-rich-on="wheel" data-rich-passive data-rich-prevent></div>
    <div data-rich-event="bad" data-rich-on="click" data-rich-facts="keyboard telepathy"></div>
    <div data-rich-event="ok" data-rich-on="click"></div>`;
  await withDom(body, async (document) => {
    const answer = await eventsCapability().execute({ operation: "describe" }, { correlationId: "d" as never, signal: new AbortController().signal, document });
    const decoded = answer.kind === "Completed" ? decodeEventsResult(answer.result) : undefined;
    assert.deepEqual(decoded?.ok === true && decoded.value, { kind: "Listening", listeners: [
      { name: "scroller", type: "wheel", refused: "a passive listener cannot prevent the default action" },
      { name: "bad", type: "click", refused: "unknown fact group(s): telepathy" },
      { name: "ok", type: "click" },
    ] });
  });
});

test("the simple SemanticEvent path is unchanged, and an engine that did not select the pack hears no facts", async () => {
  const body = `<button id="go" data-event="go" data-rich-event="goRich" data-rich-on="click" data-rich-facts="modifiers">go</button>`;
  const selected = await run(body, async (document) => { document.getElementById("go")?.click(); });
  assert.deepEqual(selected.events, [{ kind: "Event", name: "go" }]);
  assert.equal(selected.facts.length, 1);
  const unselected = await run(body, async (document) => { document.getElementById("go")?.click(); }, {}, false);
  assert.deepEqual(unselected.events, [{ kind: "Event", name: "go" }]);
  assert.deepEqual(unselected.facts, []);
});

test("the events pack passes the shared provider conformance suite", async () => {
  await withDom(`<div data-rich-event="x" data-rich-on="click"></div>`, async (document) => {
    assert.deepEqual(await runProviderConformance(eventsCapability(), {
      document,
      decodeResult: decodeEventsResult,
      valid: [{ name: "describe", payload: { operation: "describe" } }],
      malformed: [{ name: "listen", payload: { operation: "listen", type: "click" } }, { name: "extra", payload: { operation: "describe", all: true } }],
      cancellable: { name: "describe", payload: { operation: "describe" } },
    }), []);
  });
});
