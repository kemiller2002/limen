// IME composition on the simple event path (kemiller2002/limen#29, LCP-020):
// with data-on="input", an input event fired during composition carries text
// the user has not committed, and must not reach the engine. The committed
// value is reported once, at compositionend. Plain typing is unchanged.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { BrowserToEngineMessage, EngineTransport, SemanticEvent } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

test("uncommitted composition text is never reported; the committed text is, once", async () => {
  const events: SemanticEvent[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "Event") events.push(message.event);
      return { view: {}, effects: [], cancellations: [] };
    },
  };
  await withDom(`<input id="field" data-event="typed" data-on="input">`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const field = document.getElementById("field");
    const view = document.defaultView;
    assert.ok(field instanceof HTMLInputElement && view !== null);
    const type = (value: string, composing: boolean): void => {
      field.value = value;
      field.dispatchEvent(new view.InputEvent("input", { bubbles: true, isComposing: composing }));
    };
    type("a", false);
    await flush();
    // Composing 日本 through a romaji IME: every intermediate value is uncommitted.
    field.dispatchEvent(new view.CompositionEvent("compositionstart", { data: "" }));
    type("an", true);
    type("aに", true);
    type("aにほ", true);
    type("a日本", true);
    field.dispatchEvent(new view.CompositionEvent("compositionend", { data: "日本" }));
    await flush();
    type("a日本!", false);
    await flush();
  });
  assert.deepEqual(events.map((event) => event.value), ["a", "a日本", "a日本!"]);
});
