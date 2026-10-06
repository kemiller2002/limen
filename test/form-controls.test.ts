// Form-control state (kemiller2002/limen#21, protocol 1.2): a checkbox's or
// radio's checked state, a checkbox group's or multi-select's values, and a
// form's submitter reach an engine that negotiated 1.2 — and never an engine
// that did not, whose strict decoder would refuse fields it has never heard of.
// Real-browser proof: test/browser/packs/core-form-controls/.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type EngineTransport, type SemanticEvent } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

type Revision = "1.2" | "1.1" | "legacy";

const engine = (revision: Revision): { readonly transport: EngineTransport; readonly events: SemanticEvent[] } => {
  const events: SemanticEvent[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "Event") events.push(message.event);
      const minor = revision === "1.2" ? 2 : 1;
      return {
        view: {},
        effects: [],
        cancellations: [],
        ...(message.kind === "Initialize" && revision !== "legacy" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [] } } : {}),
      };
    },
  };
  return { transport, events };
};

const PAGE = `
  <form id="prefs" data-event="save">
    <input id="terms" type="checkbox" data-event="terms">
    <input id="news" type="checkbox" name="topics" value="news" data-event="topics" checked>
    <input id="tips" type="checkbox" name="topics" value="tips" data-event="topics">
    <input id="offers" type="checkbox" name="topics" value="offers" data-event="topics" checked>
    <input id="free" type="radio" name="plan" value="free" data-event="plan" checked>
    <input id="pro" type="radio" name="plan" value="pro" data-event="plan">
    <select id="colours" multiple data-event="colours">
      <option value="red" selected>Red</option><option value="green">Green</option><option value="blue" selected>Blue</option>
    </select>
    <button id="draft" type="submit" name="draft">Save draft</button>
    <button id="publish" type="submit" name="publish">Publish</button>
    <button id="anonymous" type="submit">Submit</button>
  </form>
  <input id="outside" type="checkbox" name="topics" value="elsewhere" data-event="topics" checked>`;

const run = async (revision: Revision, act: (document: Document) => Promise<void>): Promise<readonly SemanticEvent[]> => {
  const { transport, events } = engine(revision);
  await withDom(PAGE, async (document) => {
    await new BrowserKernel(transport, document).start();
    await act(document);
    await flush();
  });
  return events;
};

const input = (document: Document, id: string): HTMLInputElement => {
  const element = document.getElementById(id);
  assert.ok(element instanceof HTMLInputElement);
  return element;
};

// jsdom's dispatchEvent accepts only its own window's Event class.
const change = (element: HTMLElement): void => {
  const view = element.ownerDocument.defaultView;
  assert.ok(view !== null);
  element.dispatchEvent(new view.Event("change", { bubbles: true }));
};

test("1.2: a single checkbox reports whether it is checked, not just its static value", async () => {
  const events = await run("1.2", async (document) => {
    input(document, "terms").checked = true;
    change(input(document, "terms"));
    await flush();
    input(document, "terms").checked = false;
    change(input(document, "terms"));
  });
  assert.deepEqual(events, [
    { kind: "Event", name: "terms", value: "on", checked: true },
    { kind: "Event", name: "terms", value: "on", checked: false },
  ]);
});

test("1.2: a checkbox group reports every checked value in its group — same name, same form only", async () => {
  const events = await run("1.2", async (document) => {
    input(document, "tips").checked = true;
    change(input(document, "tips"));
    await flush();
    input(document, "news").checked = false;
    change(input(document, "news"));
  });
  assert.deepEqual(events, [
    { kind: "Event", name: "topics", value: "tips", checked: true, values: ["news", "tips", "offers"] },
    { kind: "Event", name: "topics", value: "news", checked: false, values: ["tips", "offers"] },
  ]);
});

test("1.2: a radio reports the value that became checked", async () => {
  const events = await run("1.2", async (document) => {
    input(document, "pro").checked = true;
    change(input(document, "pro"));
  });
  assert.deepEqual(events, [{ kind: "Event", name: "plan", value: "pro", checked: true }]);
});

test("1.2: a multi-select reports every selected value", async () => {
  const events = await run("1.2", async (document) => {
    const select = document.getElementById("colours");
    assert.ok(select instanceof HTMLSelectElement);
    const green = select.options.item(1);
    assert.ok(green !== null);
    green.selected = true;
    change(select);
  });
  assert.deepEqual(events, [{ kind: "Event", name: "colours", value: "red", values: ["red", "green", "blue"] }]);
});

test("1.2: a submit reports the named button that submitted the form, and nothing for an unnamed one", async () => {
  const events = await run("1.2", async (document) => {
    const form = document.getElementById("prefs");
    assert.ok(form instanceof HTMLFormElement);
    form.requestSubmit(document.getElementById("publish"));
    await flush();
    form.requestSubmit(document.getElementById("anonymous"));
  });
  const submits = events.filter((event) => event.name === "save");
  assert.deepEqual(submits.map((event) => event.submitter), ["publish", undefined]);
});

for (const revision of ["1.1", "legacy"] as const) {
  test(`${revision}: an engine that did not negotiate 1.2 receives exactly the 1.1 event shape`, async () => {
    const events = await run(revision, async (document) => {
      input(document, "tips").checked = true;
      change(input(document, "tips"));
      await flush();
      const select = document.getElementById("colours");
      assert.ok(select instanceof HTMLSelectElement);
      change(select);
      await flush();
      const form = document.getElementById("prefs");
      assert.ok(form instanceof HTMLFormElement);
      form.requestSubmit(document.getElementById("publish"));
    });
    assert.ok(events.length >= 3);
    for (const event of events) assert.deepEqual(Object.keys(event).filter((key) => !["kind", "name", "key", "value"].includes(key)), [], JSON.stringify(event));
  });
}

// ---------------------------------------------------------------------------
// The submit flush follows the browser's form data set (kemiller2002/limen#80)
//
// Before a form's own event, the kernel re-fires its fields' bindings so an
// edit made without blurring reaches the engine. It re-fires exactly the
// controls a native submission would include: enabled inputs, selects and
// textareas, checkboxes and radios only when checked, never buttons. Before
// this fix every radio in a group was re-sent, so a 1.1 engine following the
// documented radio recipe (one event name per group) saw the *last* radio in
// document order win, checked or not. Found by Signal (kemiller2002/signal#11).
// ---------------------------------------------------------------------------

const SURVEY = `
  <form id="survey" data-event="save">
    <input type="radio" name="colour" value="red" data-event="colour">
    <input type="radio" name="colour" value="green" data-event="colour" checked>
    <input type="radio" name="colour" value="blue" data-event="colour">
    <input type="radio" name="size" value="small" data-event="size">
    <input type="radio" name="size" value="large" data-event="size">
    <input type="checkbox" name="agree" data-event="agree">
    <input type="checkbox" name="topics" value="news" data-event="topics" checked>
    <input type="checkbox" name="topics" value="tips" data-event="topics">
    <select name="country" data-event="country"><option value="uk">UK</option><option value="fr" selected>France</option></select>
    <select name="tags" multiple data-event="tags"><option value="a">A</option><option value="b">B</option></select>
    <input name="note" value="hello" data-event="note">
    <textarea name="body" data-event="body">text</textarea>
    <input name="locked" value="x" disabled data-event="locked">
    <input type="radio" name="tier" value="gold" checked disabled data-event="tier">
    <fieldset disabled>
      <input name="inner" value="y" data-event="inner">
      <input type="checkbox" name="innerBox" checked data-event="innerBox">
    </fieldset>
    <button type="button" data-event="addRow">Add row</button>
    <input type="button" value="Preview" data-event="preview">
    <button id="send" type="submit" name="send">Send</button>
  </form>`;

const submitSurvey = async (revision: Revision): Promise<readonly SemanticEvent[]> => {
  const { transport, events } = engine(revision);
  await withDom(SURVEY, async (document) => {
    await new BrowserKernel(transport, document).start();
    const form = document.getElementById("survey");
    assert.ok(form instanceof HTMLFormElement);
    form.requestSubmit(document.getElementById("send"));
    await flush();
  });
  return events;
};

test("1.2: submitting flushes only what a native submission would include — checked radios and checkboxes, enabled fields, no buttons", async () => {
  assert.deepEqual(await submitSurvey("1.2"), [
    { kind: "Event", name: "colour", value: "green", checked: true },
    { kind: "Event", name: "topics", value: "news", checked: true, values: ["news"] },
    { kind: "Event", name: "country", value: "fr" },
    { kind: "Event", name: "note", value: "hello" },
    { kind: "Event", name: "body", value: "text" },
    { kind: "Event", name: "save", submitter: "send" },
  ]);
});

test("1.1: an engine without `checked` never sees an unchecked radio's value on submit, so the checked one is the only answer", async () => {
  assert.deepEqual(await submitSurvey("1.1"), [
    { kind: "Event", name: "colour", value: "green" },
    { kind: "Event", name: "topics", value: "news" },
    { kind: "Event", name: "country", value: "fr" },
    { kind: "Event", name: "note", value: "hello" },
    { kind: "Event", name: "body", value: "text" },
    { kind: "Event", name: "save" },
  ]);
});

test("a control's own change still reports an unchecked radio or checkbox — only the submit flush follows the form data set", async () => {
  const { transport, events } = engine("1.2");
  await withDom(SURVEY, async (document) => {
    await new BrowserKernel(transport, document).start();
    const agree = document.querySelector("input[name=agree]");
    assert.ok(agree instanceof HTMLInputElement);
    change(agree);
    await flush();
  });
  assert.deepEqual(events, [{ kind: "Event", name: "agree", value: "on", checked: false, values: [] }]);
});
