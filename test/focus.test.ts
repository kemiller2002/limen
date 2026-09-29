// The focus, selection and scroll capability pack (kemiller2002/limen#23,
// LCP-007), through the real kernel with the handshake negotiated. The
// reference scenarios from the issue: dialog-open focus target, keyed-row
// deletion restoration, invalid-target typed failures, stale request
// rejection. Real-browser proof: scripts/smoke-focus.ts.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { FOCUS_CAPABILITY, decodeFocusResult, focusCapability, type FocusRequest, type FocusResult } from "../dist/capabilities/focus/index.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type CapabilityId, type CorrelationId, type EffectRequest, type EngineToBrowserMessage, type EngineTransport, type ViewState } from "../dist/protocol.js";
import { withDom } from "./dom-helpers.ts";

const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });
const offer = { id: FOCUS_CAPABILITY.id as CapabilityId, version: FOCUS_CAPABILITY.version, fingerprint: FOCUS_CAPABILITY.fingerprint };

type Step = { readonly view: ViewState; readonly focus?: readonly FocusRequest[] };

// An engine that answers each browser message with the next scripted step,
// asking for focus effects in the same response as the projection they follow.
const focusEngine = (steps: readonly Step[], select = true): { readonly transport: EngineTransport; readonly results: FocusResult[]; readonly outcomes: string[] } => {
  const results: FocusResult[] = [];
  const outcomes: string[] = [];
  const cursor = { step: 0, effect: 0 };
  const respond = (): EngineToBrowserMessage => {
    const step = steps[Math.min(cursor.step, steps.length - 1)] ?? { view: {} };
    cursor.step += 1;
    const effects = (step.focus ?? []).map((request): EffectRequest => {
      cursor.effect += 1;
      return { kind: "Capability", correlationId: `f${cursor.effect}` as CorrelationId, capability: offer.id, version: 1, request };
    });
    return { view: step.view, effects, cancellations: [] };
  };
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "EffectResult" && message.result.kind === "CapabilityResult") {
        outcomes.push(message.result.outcome.kind);
        if (message.result.outcome.kind === "Completed") {
          const decoded = decodeFocusResult(message.result.outcome.result);
          if (decoded.ok) results.push(decoded.value);
        }
        return { view: steps[Math.max(0, cursor.step - 1)]?.view ?? {}, effects: [], cancellations: [] };
      }
      const response = respond();
      return message.kind === "Initialize"
        ? { ...response, handshake: { kind: "Accepted", protocol: { major: 1, minor: 1 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: select ? [offer] : [] } }
        : response;
    },
  };
  return { transport, results, outcomes };
};

const drive = async <T>(body: string, steps: readonly Step[], act: (document: Document) => Promise<T>, select = true) => {
  const engine = focusEngine(steps, select);
  const observed = await withDom(body, async (document) => {
    await new BrowserKernel(engine.transport, document, undefined, { capabilities: [focusCapability()], requireHandshake: true }).start();
    await flush();
    return act(document);
  });
  return { ...engine, observed };
};

const click = async (document: Document, selector: string): Promise<void> => {
  const element = document.querySelector(selector);
  assert.ok(element !== null && "click" in element && typeof element.click === "function", `no clickable ${selector}`);
  element.click();
  await flush();
  await flush();
};

const activeId = (document: Document): string => document.activeElement?.id || document.activeElement?.tagName || "none";

// ---------------------------------------------------------------------------
// Reference scenarios
// ---------------------------------------------------------------------------

test("dialog-open focus target: the engine opens a dialog and moves focus into it in the same response", async () => {
  const body = `
    <button id="open" data-event="open">Open</button>
    <template data-if="dialogOpen">
      <section data-focus-target="dialog" role="dialog">
        <p>Rename</p><button id="disabled-first" disabled>x</button><input id="name"><button id="save">Save</button>
      </section>
    </template>`;
  const { results, observed } = await drive(body, [
    { view: { dialogOpen: false } },
    { view: { dialogOpen: true }, focus: [{ operation: "focusFirst", scope: { name: "dialog" } }] },
    { view: { dialogOpen: true }, focus: [{ operation: "focusLast", scope: { name: "dialog" } }] },
  ], async (document) => {
    await click(document, "#open");
    const first = activeId(document);
    await click(document, "#open");
    return { first, last: activeId(document) };
  });
  assert.deepEqual(observed, { first: "name", last: "save" }, "a disabled control is skipped; first and last follow document order");
  assert.deepEqual(results, [{ kind: "Done" }, { kind: "Done" }]);
});

const rowsBody = `
  <button id="add" data-focus-target="add">Add</button>
  <ul><template data-each="rows" data-key="id">
    <li data-bind-data-focus-key="id"><span data-text="label"></span><button data-event="remove" data-focus-target="remove">Remove</button></li>
  </template></ul>`;
const rows = (ids: readonly string[]) => ids.map((id) => ({ id, label: `row ${id}` }));

test("keyed-row deletion restoration: after a row is removed, focus goes to the next row's control, then to Add when none is left", async () => {
  const { results, observed } = await drive(rowsBody, [
    { view: { rows: rows(["1", "2", "3"]) } },
    { view: { rows: rows(["1", "3"]) }, focus: [{ operation: "focus", target: { name: "remove", key: "3" }, preventScroll: true }] },
    { view: { rows: rows(["1"]) }, focus: [{ operation: "focus", target: { name: "remove", key: "1" }, preventScroll: true }] },
    { view: { rows: [] }, focus: [{ operation: "focus", target: { name: "add" }, preventScroll: true }] },
  ], async (document) => {
    const trail: string[] = [];
    const focusedRow = (): string => document.activeElement?.closest("li")?.getAttribute("data-focus-key") ?? activeId(document);
    await click(document, "li:nth-child(2) button");
    trail.push(focusedRow());
    await click(document, "li:nth-child(2) button");
    trail.push(focusedRow());
    await click(document, "li button");
    trail.push(focusedRow());
    return trail;
  });
  assert.deepEqual(observed, ["3", "1", "add"]);
  assert.deepEqual(results, [{ kind: "Done" }, { kind: "Done" }, { kind: "Done" }]);
});

test("a row key that no longer exists is NotFound, not a guess at a neighbour", async () => {
  const { results } = await drive(rowsBody, [
    { view: { rows: rows(["1", "3"]) }, focus: [{ operation: "focus", target: { name: "remove", key: "2" }, preventScroll: false }] },
  ], async () => undefined);
  assert.deepEqual(results, [{ kind: "NotFound" }]);
});

test("stale focus request: a request for a replaced screen is answered Stale and focus does not move", async () => {
  const body = `
    <input id="keep">
    <main data-bind-data-focus-generation="screen"><input id="field" data-focus-target="field"></main>
    <button id="go" data-event="go">go</button>`;
  const { results, observed } = await drive(body, [
    { view: { screen: "1" }, focus: [{ operation: "focus", target: { name: "keep" }, preventScroll: false }] },
    // The engine moved to screen 2 in the same projection that still carries a
    // request made for screen 1.
    { view: { screen: "2" }, focus: [{ operation: "focus", target: { name: "field", generation: "1" }, preventScroll: false }] },
    { view: { screen: "2" }, focus: [{ operation: "focus", target: { name: "field", generation: "2" }, preventScroll: false }] },
  ], async (document) => {
    const input = document.getElementById("keep");
    if (input !== null && "focus" in input) input.focus();
    await click(document, "#go");
    const afterStale = activeId(document);
    await click(document, "#go");
    return { afterStale, afterCurrent: activeId(document) };
  });
  assert.deepEqual(results, [{ kind: "NotFound" }, { kind: "Stale", current: "2" }, { kind: "Done" }]);
  // A programmatic click does not move focus, so focus is where the user left it.
  assert.equal(observed.afterStale, "keep", "the stale request did not take focus from where the user left it");
  assert.equal(observed.afterCurrent, "field");
});

// ---------------------------------------------------------------------------
// Typed failures
// ---------------------------------------------------------------------------

const failuresBody = `
  <button data-focus-target="twin">a</button><button data-focus-target="twin">b</button>
  <button id="off" data-focus-target="off" disabled>off</button>
  <p data-focus-target="plain">not focusable</p>
  <input id="email" type="email" data-focus-target="email" value="a@b.c">
  <input id="text" data-focus-target="text" value="hello world">
  <textarea id="area" data-focus-target="area">abc</textarea>
  <button data-focus-target="button">button</button>
  <section data-focus-target="empty"><p>nothing to focus</p></section>`;

const single = async (request: FocusRequest): Promise<{ readonly result: FocusResult | undefined; readonly selection: string }> => {
  const { results, observed } = await drive(failuresBody, [{ view: {}, focus: [request] }], async (document) => {
    const active = document.activeElement;
    return active !== null && "selectionStart" in active && "selectionEnd" in active && typeof active.selectionStart === "number" ? `${active.id}:${String(active.selectionStart)}-${String(active.selectionEnd)}` : activeId(document);
  });
  return { result: results[0], selection: observed };
};

test("invalid targets are typed failures, never exceptions or guesses", async () => {
  assert.deepEqual((await single({ operation: "focus", target: { name: "nope" }, preventScroll: false })).result, { kind: "NotFound" });
  assert.deepEqual((await single({ operation: "focus", target: { name: "twin" }, preventScroll: false })).result, { kind: "Ambiguous", count: 2 });
  assert.deepEqual((await single({ operation: "focus", target: { name: "off" }, preventScroll: false })).result, { kind: "NotFocusable" });
  assert.deepEqual((await single({ operation: "focus", target: { name: "plain" }, preventScroll: false })).result, { kind: "NotFocusable" });
  assert.deepEqual((await single({ operation: "focusFirst", scope: { name: "empty" } })).result, { kind: "NotFocusable" });
});

test("selection: ranges on text controls, typed refusals elsewhere", async () => {
  assert.deepEqual(await single({ operation: "select", target: { name: "text" }, start: 0, end: 5 }), { result: { kind: "Done" }, selection: "text:0-5" });
  assert.deepEqual(await single({ operation: "selectAll", target: { name: "area" } }), { result: { kind: "Done" }, selection: "area:0-3" });
  assert.deepEqual((await single({ operation: "select", target: { name: "email" }, start: 0, end: 1 })).result, { kind: "NotSelectable" });
  assert.deepEqual((await single({ operation: "selectAll", target: { name: "button" } })).result, { kind: "NotSelectable" });
  assert.deepEqual((await single({ operation: "select", target: { name: "text" }, start: 4, end: 2 })).result, { kind: "InvalidRange" });
  assert.deepEqual((await single({ operation: "select", target: { name: "text" }, start: -1, end: 2 })).result, { kind: "InvalidRange" });
});

test("an operation this browser lacks is Unavailable (jsdom has no scrollIntoView)", async () => {
  assert.deepEqual((await single({ operation: "scrollIntoView", target: { name: "text" }, block: "center", smooth: false })).result, { kind: "Unavailable" });
});

test("blur removes focus from the target, and is a no-op when it does not have it", async () => {
  const { results, observed } = await drive(failuresBody, [
    { view: {}, focus: [{ operation: "focus", target: { name: "text" }, preventScroll: false }, { operation: "blur", target: { name: "text" } }, { operation: "blur", target: { name: "area" } }] },
  ], async (document) => activeId(document));
  assert.deepEqual(results, [{ kind: "Done" }, { kind: "Done" }, { kind: "Done" }]);
  assert.equal(observed, "BODY");
});

// ---------------------------------------------------------------------------
// Optional, negotiated, conformant
// ---------------------------------------------------------------------------

test("an engine that did not select the capability gets Unsupported, and nothing moves", async () => {
  const { outcomes, observed } = await drive(failuresBody, [{ view: {}, focus: [{ operation: "focus", target: { name: "text" }, preventScroll: false }] }], async (document) => activeId(document), false);
  assert.deepEqual(outcomes, ["Unsupported"]);
  assert.equal(observed, "BODY");
});

test("the focus pack passes the shared provider conformance suite", async () => {
  await withDom(failuresBody, async (document) => {
    assert.deepEqual(await runProviderConformance(focusCapability(), {
      document,
      decodeResult: decodeFocusResult,
      valid: [
        { name: "focus", payload: { operation: "focus", target: { name: "text" }, preventScroll: true } },
        { name: "focus-keyed-missing", payload: { operation: "focus", target: { name: "text", key: "9" }, preventScroll: false } },
        { name: "select", payload: { operation: "select", target: { name: "text" }, start: 1, end: 3 } },
        { name: "scroll", payload: { operation: "scrollIntoView", target: { name: "text" }, block: "nearest", smooth: true } },
        { name: "first", payload: { operation: "focusFirst", scope: { name: "empty" } } },
      ],
      malformed: [
        { name: "unknown-operation", payload: { operation: "teleport", target: { name: "text" } } },
        { name: "missing-target", payload: { operation: "focus", preventScroll: false } },
        { name: "bad-block", payload: { operation: "scrollIntoView", target: { name: "text" }, block: "middle", smooth: false } },
        { name: "fractional-range", payload: { operation: "select", target: { name: "text" }, start: 0.5, end: 1 } },
        { name: "extra-field", payload: { operation: "blur", target: { name: "text", element: {} } } },
        { name: "not-an-object", payload: "focus" },
      ],
      cancellable: { name: "focus", payload: { operation: "focus", target: { name: "text" }, preventScroll: false } },
    }), []);
  });
});
