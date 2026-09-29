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
