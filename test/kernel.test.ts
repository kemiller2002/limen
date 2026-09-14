import assert from "node:assert/strict";
import test from "node:test";
// Imported from dist, not src: BrowserKernel's own runtime import of
// PROTOCOL_VERSION from protocol.js only resolves once built (dist/protocol.js
// exists; src/protocol.js does not — src only has the .ts source). `pretest`
// builds first, so this is always fresh.
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { DiagnosticEvent, DiagnosticsSink } from "../dist/kernel/diagnostics.js";
import type { BrowserToEngineMessage, CorrelationId, EffectOutcome, EngineToBrowserMessage, EngineTransport } from "../dist/protocol.js";
import { withDom, withFetch } from "./dom-helpers.ts";

function respond(overrides: Partial<EngineToBrowserMessage> = {}): EngineToBrowserMessage {
  return { view: {}, effects: [], cancellations: [], ...overrides };
}

type TransportHandler = (message: BrowserToEngineMessage, calls: readonly BrowserToEngineMessage[]) => EngineToBrowserMessage;

class ScriptedTransport implements EngineTransport {
  readonly calls: BrowserToEngineMessage[] = [];
  readonly handler: TransportHandler;
  constructor(handler: TransportHandler) {
    this.handler = handler;
  }
  async start(): Promise<void> {}
  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    this.calls.push(message);
    return this.handler(message, this.calls);
  }
}

function collectDiagnostics(): { sink: DiagnosticsSink; events: DiagnosticEvent[] } {
  const events: DiagnosticEvent[] = [];
  return { events, sink: { report: (event) => { events.push(event); } } };
}

function deferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// `start()` binds the DOM exactly once; a later projection can only arrive
// through a real event round-trip, never a second start() call. Dispatching
// that event is fire-and-forget from the DOM's perspective, so tests that
// assert on DOM state (as opposed to what was dispatched, which lands
// synchronously) need to yield past the pending microtasks first.
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

// ---------------------------------------------------------------------------
// WASM lifecycle — load, initialize, version-check
// ---------------------------------------------------------------------------

test("start() dispatches Initialize with the protocol version and applies the initial projection", async () => {
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ view: { statusText: "ready" } });
    return respond();
  });
  await withDom(`<p data-text="statusText"></p>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(transport.calls[0], { kind: "Initialize", protocolVersion: 1, capabilities: ["Http", "Storage"] });
    assert.equal(document.querySelector("p")!.textContent, "ready");
  });
});

test("a transport whose start() rejects is reported via diagnostics and never dispatches Initialize", async () => {
  const { sink, events } = collectDiagnostics();
  const transport: EngineTransport = {
    start: async () => { throw new Error("engine failed to load"); },
    dispatch: async () => { throw new Error("unreachable"); },
  };
  await withDom(`<p data-text="x"></p>`, async (document) => {
    await new BrowserKernel(transport, document, sink).start();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind, "BridgeError");
    assert.equal(events[0]?.kind === "BridgeError" && events[0].phase, "dispatch");
  });
});

// ---------------------------------------------------------------------------
// Command dispatch, DOM event wiring, form value extraction
// ---------------------------------------------------------------------------

test("a click on a button dispatches a bare named event", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<button data-event="save">Save</button>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    document.querySelector("button")!.click();
    const last = transport.calls.at(-1);
    assert.equal(last?.kind, "Event");
    assert.deepEqual(last?.kind === "Event" && last.event, { kind: "Event", name: "save" });
  });
});

test("a change on an input dispatches the event carrying its value", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<input data-event="emailChanged">`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const input = document.querySelector("input")!;
    input.value = "person@example.com";
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
    const last = transport.calls.at(-1);
    assert.deepEqual(last?.kind === "Event" && last.event, { kind: "Event", name: "emailChanged", value: "person@example.com" });
  });
});

test("data-on overrides the tag's default trigger", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<input data-event="typed" data-on="input">`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const input = document.querySelector("input")!;
    input.value = "s";
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    const last = transport.calls.at(-1);
    assert.equal(last?.kind === "Event" && last.event.name, "typed");
  });
});

test("submitting a form dispatches its event and prevents native submission", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<form data-event="go"></form>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const form = document.querySelector("form")!;
    const submitEvent = new window.Event("submit", { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);
    assert.equal(submitEvent.defaultPrevented, true);
    assert.equal(transport.calls.at(-1)?.kind === "Event" && (transport.calls.at(-1) as { kind: "Event" }).kind, "Event");
  });
});

test("an invalid form does not dispatch any event", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<form data-event="go"><input required></form>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const before = transport.calls.length;
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    assert.equal(transport.calls.length, before);
  });
});

test("submitting a form flushes a pending change-bound field before its own event, in order", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<form data-event="go"><input data-event="fieldChanged"></form>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const initial = transport.calls.length;
    document.querySelector("input")!.value = "unblurred edit";
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const fired = transport.calls.slice(initial);
    assert.equal(fired.length, 2);
    assert.deepEqual(fired[0]?.kind === "Event" && fired[0].event, { kind: "Event", name: "fieldChanged", value: "unblurred edit" });
    assert.equal(fired[1]?.kind === "Event" && fired[1].event.name, "go");
  });
});

// Regression for finding P-1. #applyIf/#applyEach used to bind the cloned root
// while it was still detached, so `el.form` was null and the pending-field
// flush never registered — a conditionally-shown field edited without blurring
// was silently missing from the draft the engine saw on submit. Both now insert
// before binding.
test("a data-if field inside a form flushes before submit (P-1 regression)", async () => {
  const transport = new ScriptedTransport(() => respond({ view: { show: true } }));
  await withDom(`<form data-event="go"><template data-if="show"><input data-event="fieldChanged"></template></form>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    await flush();
    const initial = transport.calls.length;
    document.querySelector("input")!.value = "unblurred edit";
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const fired = transport.calls.slice(initial);
    assert.equal(fired.length, 2, "the conditionally-mounted field should flush before the form's own event");
    assert.deepEqual(fired[0]?.kind === "Event" && fired[0].event, { kind: "Event", name: "fieldChanged", value: "unblurred edit" });
    assert.equal(fired[1]?.kind === "Event" && fired[1].event.name, "go");
  });
});

test("a data-each field inside a form flushes before submit (P-1 regression)", async () => {
  const transport = new ScriptedTransport(() => respond({ view: { rows: [{ id: "r1" }] } }));
  await withDom(`<form data-event="go"><template data-each="rows" data-key="id"><input data-event="rowChanged"></template></form>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    await flush();
    const initial = transport.calls.length;
    document.querySelector("input")!.value = "row edit";
    document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    await flush();
    const fired = transport.calls.slice(initial);
    assert.equal(fired.length, 2);
    assert.equal(fired[0]?.kind === "Event" && fired[0].event.key, "r1", "the row's key still travels with the flushed event");
  });
});

// A binding whose element has been unmounted must not keep firing. Before the
// fix, every remount pushed another callback onto the form's flush list and
// none were ever removed.
test("unmounting a data-if drops its pending-field binding instead of accumulating", async () => {
  let show = true;
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Event" && message.event.name === "toggle") show = !show;
    return respond({ view: { show } });
  });
  await withDom(
    `<form data-event="go"><template data-if="show"><input data-event="fieldChanged"></template></form><button data-event="toggle"></button>`,
    async (document) => {
      await new BrowserKernel(transport, document).start();
      await flush();
      // Toggle off, on, off, on — four remounts of the same conditional field.
      for (let i = 0; i < 4; i += 1) {
        document.querySelector("button")!.click();
        await flush();
      }
      assert.ok(document.querySelector("input"), "the field is mounted again");
      const initial = transport.calls.length;
      document.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      await flush();
      const fired = transport.calls.slice(initial);
      assert.equal(fired.length, 2, "exactly one field flush plus the form's own event — not one per past mount");
    },
  );
});

// ---------------------------------------------------------------------------
// Misplaced binding attributes — finding P-2
// ---------------------------------------------------------------------------

test("data-if on a non-template element is reported, not silently ignored (P-2)", async () => {
  const transport = new ScriptedTransport(() => respond());
  const { sink, events } = collectDiagnostics();
  await withDom(`<p data-if="ready">never appears</p>`, async (document) => {
    await new BrowserKernel(transport, document, sink).start();
    const error = events.find((event) => event.kind === "BridgeError");
    assert.ok(error, "a BridgeError was reported");
    assert.equal(error.kind === "BridgeError" && error.phase, "binding");
    assert.match(error.kind === "BridgeError" ? error.detail : "", /only supported on a <template> element/);
    assert.match(error.kind === "BridgeError" ? error.detail : "", /<p>/);
    assert.equal(transport.calls.length, 0, "Initialize is not dispatched when binding failed");
  });
});

test("data-each on a non-template element is reported too (P-2)", async () => {
  const transport = new ScriptedTransport(() => respond());
  const { sink, events } = collectDiagnostics();
  await withDom(`<ul data-each="items" data-key="id"></ul>`, async (document) => {
    await new BrowserKernel(transport, document, sink).start();
    const error = events.find((event) => event.kind === "BridgeError");
    assert.ok(error);
    assert.equal(error.kind === "BridgeError" && error.phase, "binding");
    assert.match(error.kind === "BridgeError" ? error.detail : "", /<ul>/);
  });
});

test("start() still resolves when a binding is malformed, rather than rejecting", async () => {
  const transport = new ScriptedTransport(() => respond());
  await withDom(`<template data-each="items"><li></li></template>`, async (document) => {
    // data-each without data-key throws inside binding; start() must absorb it.
    await assert.doesNotReject(() => new BrowserKernel(transport, document).start());
  });
});

// Regression for finding P-3. A response that arrives but will not decode used
// to report `Failure { invalid-response }` with no status, so a 500 returning an
// HTML error page was indistinguishable from a 200 returning malformed JSON —
// the first is often worth retrying, the second never is.
test("an undecodable response carries the status so the engine can classify it (P-3)", async () => {
  const outcomes: EffectOutcome[] = [];
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") {
      return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/err", timeoutMs: 1000 }] });
    }
    if (message.kind === "EffectResult" && message.result.kind === "HttpResult") outcomes.push(message.result.outcome);
    return respond();
  });
  const notJson = (status: number): Response => ({
    status,
    json: async () => { throw new Error("Unexpected token < in JSON"); },
  } as unknown as Response);

  await withFetch(async () => notJson(503), async () => {
    await withDom(`<p></p>`, async (document) => {
      await new BrowserKernel(transport, document).start();
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      assert.deepEqual(outcomes[0], { kind: "Failure", reason: "invalid-response", status: 503 });
    });
  });
});

test("a network failure carries no status, because nothing came back (P-3)", async () => {
  const outcomes: EffectOutcome[] = [];
  const correlationId = withCorrelation("c2");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") {
      return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/gone", timeoutMs: 1000 }] });
    }
    if (message.kind === "EffectResult" && message.result.kind === "HttpResult") outcomes.push(message.result.outcome);
    return respond();
  });
  await withFetch(async () => { throw new Error("DNS failure"); }, async () => {
    await withDom(`<p></p>`, async (document) => {
      await new BrowserKernel(transport, document).start();
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      assert.deepEqual(outcomes[0], { kind: "Failure", reason: "network" });
      assert.ok(!("status" in (outcomes[0] ?? {})), "absence of status is what distinguishes it");
    });
  });
});

test("clicking inside a data-each item includes that item's key", async () => {
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ view: { items: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] } });
    return respond();
  });
  await withDom(`<ul><template data-each="items" data-key="id"><li data-event="select"><span data-text="label"></span></li></template></ul>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const items = document.querySelectorAll("li");
    assert.equal(items.length, 2);
    items[1]!.dispatchEvent(new window.Event("click", { bubbles: true }));
    const last = transport.calls.at(-1);
    assert.deepEqual(last?.kind === "Event" && last.event, { kind: "Event", name: "select", key: "b" });
  });
});

// ---------------------------------------------------------------------------
// Projection rendering / rendering helpers
// ---------------------------------------------------------------------------

test("data-text sets textContent from the view", async () => {
  const transport = new ScriptedTransport(() => respond({ view: { message: "hello" } }));
  await withDom(`<p data-text="message"></p>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal(document.querySelector("p")!.textContent, "hello");
  });
});

test("data-bind-disabled toggles a boolean IDL property", async () => {
  const transport = new ScriptedTransport(() => respond({ view: { busy: true } }));
  await withDom(`<button data-bind-disabled="busy"></button>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal(document.querySelector("button")!.disabled, true);
  });
});

test("data-bind-<attr> for a non-boolean attribute sets it via setAttribute, not a property", async () => {
  const transport = new ScriptedTransport(() => respond({ view: { expanded: true } }));
  await withDom(`<div data-bind-aria-expanded="expanded"></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal(document.querySelector("div")!.getAttribute("aria-expanded"), "true");
  });
});

async function tick(document: Document): Promise<void> {
  document.querySelector('[data-event="tick"]')!.dispatchEvent(new window.Event("click", { bubbles: true }));
  await flush();
}

test("data-bind-value only writes when the value actually differs, preserving caret position", async () => {
  let view: Record<string, unknown> = { draft: "hello" };
  const transport = new ScriptedTransport(() => respond({ view }));
  await withDom(`<input data-bind-value="draft"><button data-event="tick"></button>`, async (document) => {
    const kernel = new BrowserKernel(transport, document);
    await kernel.start();
    const input = document.querySelector("input")! as HTMLInputElement;
    assert.equal(input.value, "hello");
    input.setSelectionRange(2, 2);
    // Re-send the identical value: a real re-assignment would reset the caret to the end.
    view = { draft: "hello" };
    await tick(document);
    assert.equal(input.selectionStart, 2, "unchanged value must not re-assign .value");
    view = { draft: "hello world" };
    await tick(document);
    assert.equal(input.value, "hello world");
  });
});

test("data-if mounts on a true view key and unmounts on false", async () => {
  let view: Record<string, unknown> = { open: false };
  const transport = new ScriptedTransport(() => respond({ view }));
  await withDom(`<template data-if="open"><p id="panel">Open</p></template><button data-event="tick"></button>`, async (document) => {
    const kernel = new BrowserKernel(transport, document);
    await kernel.start();
    assert.equal(document.getElementById("panel"), null);
    view = { open: true };
    await tick(document);
    assert.equal(document.getElementById("panel")?.textContent, "Open");
    view = { open: false };
    await tick(document);
    assert.equal(document.getElementById("panel"), null);
  });
});

test("data-if content reapplies its own bindings on later projections while mounted", async () => {
  let view: Record<string, unknown> = { open: true, count: 1 };
  const transport = new ScriptedTransport(() => respond({ view }));
  await withDom(`<template data-if="open"><span id="count" data-text="count"></span></template><button data-event="tick"></button>`, async (document) => {
    const kernel = new BrowserKernel(transport, document);
    await kernel.start();
    assert.equal(document.getElementById("count")!.textContent, "1");
    view = { open: true, count: 2 };
    await tick(document);
    assert.equal(document.getElementById("count")!.textContent, "2");
  });
});

// ---------------------------------------------------------------------------
// List rendering (data-each) — add, remove, reorder with identity preservation
// ---------------------------------------------------------------------------

test("data-each renders one keyed instance per item and removes instances whose key disappears", async () => {
  let view: Record<string, unknown> = { items: [{ id: "1", label: "One" }, { id: "2", label: "Two" }] };
  const transport = new ScriptedTransport(() => respond({ view }));
  await withDom(`<ul><template data-each="items" data-key="id"><li data-text="label"></li></template></ul><button data-event="tick"></button>`, async (document) => {
    const kernel = new BrowserKernel(transport, document);
    await kernel.start();
    assert.deepEqual(Array.from(document.querySelectorAll("li")).map((li) => li.textContent), ["One", "Two"]);
    view = { items: [{ id: "2", label: "Two" }] };
    await tick(document);
    assert.deepEqual(Array.from(document.querySelectorAll("li")).map((li) => li.textContent), ["Two"]);
  });
});

test("data-each reorders by moving existing DOM nodes rather than recreating them", async () => {
  let view: Record<string, unknown> = { items: [{ id: "1", label: "One" }, { id: "2", label: "Two" }] };
  const transport = new ScriptedTransport(() => respond({ view }));
  await withDom(`<ul><template data-each="items" data-key="id"><li data-text="label"></li></template></ul><button data-event="tick"></button>`, async (document) => {
    const kernel = new BrowserKernel(transport, document);
    await kernel.start();
    const firstNodeBefore = document.querySelectorAll("li")[0]!;
    view = { items: [{ id: "2", label: "Two" }, { id: "1", label: "One" }] };
    await tick(document);
    const nodesAfter = Array.from(document.querySelectorAll("li"));
    assert.deepEqual(nodesAfter.map((li) => li.textContent), ["Two", "One"]);
    assert.equal(nodesAfter[1], firstNodeBefore, "the node for id=1 must be the same object, only moved");
  });
});

// ---------------------------------------------------------------------------
// Effect execution / Effect result return (Succeeded, Failed, Cancelled, OutcomeUnknown) / Network adapter
// ---------------------------------------------------------------------------

function withCorrelation(id: string): CorrelationId {
  return id as CorrelationId;
}

test("a successful fetch reports Success with the decoded body, uninterpreted", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/x", timeoutMs: 1000 }] });
    return respond();
  });
  const fetchImpl = (async () => ({ status: 200, json: async () => ({ available: true }) })) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const result = transport.calls.at(-1);
    assert.equal(result?.kind, "EffectResult");
    assert.deepEqual(result?.kind === "EffectResult" && result.result.outcome, { kind: "Success", status: 200, body: { available: true } });
  }));
});

test("a network-level fetch rejection reports Failure with reason network", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/x", timeoutMs: 1000 }] });
    return respond();
  });
  const fetchImpl = (async () => { throw new Error("dns failure"); }) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const result = transport.calls.at(-1);
    assert.deepEqual(result?.kind === "EffectResult" && result.result.outcome, { kind: "Failure", reason: "network" });
  }));
});

test("a response that fails to decode reports Failure with reason invalid-response, not network", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/x", timeoutMs: 1000 }] });
    return respond();
  });
  const fetchImpl = (async () => ({ status: 200, json: async () => { throw new Error("not json"); } })) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const result = transport.calls.at(-1);
    // The status rides along now (finding P-3): a response did arrive, it just
    // would not decode, and 200-with-broken-JSON must stay distinguishable from
    // a server that refused with an HTML error page.
    assert.deepEqual(result?.kind === "EffectResult" && result.result.outcome, { kind: "Failure", reason: "invalid-response", status: 200 });
  }));
});

test("a PUT effect with headers and a body reaches fetch with all three, headers merged over the default accept", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") {
      return respond({
        effects: [{
          kind: "Http",
          correlationId,
          method: "PUT",
          url: "/documents/42",
          headers: { authorization: "token secret-abc", accept: "application/vnd.github+json" },
          body: JSON.stringify({ content: "hello", sha: "abc123" }),
          timeoutMs: 1000,
        }],
      });
    }
    return respond();
  });
  let captured;
  const fetchImpl = (async (url, init) => {
    captured = { url, init };
    return { status: 200, json: async () => ({ ok: true }) };
  }) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal(captured.url, "/documents/42");
    assert.equal(captured.init.method, "PUT");
    assert.equal(captured.init.body, JSON.stringify({ content: "hello", sha: "abc123" }));
    assert.deepEqual(captured.init.headers, { accept: "application/vnd.github+json", authorization: "token secret-abc" });
  }));
});

test("a GET effect with no body omits the body from the fetch call entirely", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/x", timeoutMs: 1000 }] });
    return respond();
  });
  let captured;
  const fetchImpl = (async (url, init) => { captured = init; return { status: 200, json: async () => ({}) }; }) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.equal("body" in captured, false);
  }));
});

test("a diagnostics sink never receives request headers or body — only correlationId and timing", async () => {
  const { sink, events } = collectDiagnostics();
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") {
      return respond({ effects: [{ kind: "Http", correlationId, method: "POST", url: "/x", headers: { authorization: "token secret-abc" }, body: "top secret payload", timeoutMs: 1000 }] });
    }
    return respond();
  });
  const fetchImpl = (async () => ({ status: 200, json: async () => ({}) })) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document, sink).start();
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("secret"), false);
  }));
});

test("a timeout always reports OutcomeUnknown, never a confident Failure", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/x", timeoutMs: 15 }] });
    return respond();
  });
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error(String(init.signal?.reason))));
  })) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    const result = transport.calls.at(-1);
    assert.deepEqual(result?.kind === "EffectResult" && result.result.outcome, { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" });
  }));
});

test("an engine-requested cancellation on an in-flight effect reports Cancelled", async () => {
  const correlationId = withCorrelation("c1");
  const started = deferredVoid();
  const settled = deferredValue<EffectOutcome>();
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/x", timeoutMs: 5000 }] });
    if (message.kind === "Event" && message.event.name === "cancel") return respond({ cancellations: [correlationId] });
    if (message.kind === "EffectResult") { settled.resolve(message.result.outcome); return respond(); }
    return respond();
  });
  const fetchImpl = ((_input: unknown, init?: { signal?: AbortSignal }) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error(String(init.signal?.reason))));
    });
  }) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<button data-event="cancel">Cancel</button>`, async (document) => {
    const kernel = new BrowserKernel(transport, document);
    const startPromise = kernel.start();
    await started.promise;
    document.querySelector("button")!.click();
    const outcome = await settled.promise;
    assert.deepEqual(outcome, { kind: "Cancelled" });
    await startPromise;
  }));
});

test("the kernel reports effect timing via diagnostics regardless of outcome", async () => {
  const { sink, events } = collectDiagnostics();
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Http", correlationId, method: "GET", url: "/x", timeoutMs: 1000 }] });
    return respond();
  });
  const fetchImpl = (async () => ({ status: 200, json: async () => ({}) })) as typeof fetch;
  await withFetch(fetchImpl, () => withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document, sink).start();
    const timing = events.find((event) => event.kind === "EffectTiming");
    assert.ok(timing);
    assert.equal(timing?.kind === "EffectTiming" && timing.correlationId, correlationId);
    assert.equal(timing?.kind === "EffectTiming" && typeof timing.durationMs === "number", true);
  }));
});

// ---------------------------------------------------------------------------
// Error boundary — bridge/WASM integration failures are reported, not thrown
// ---------------------------------------------------------------------------

test("a transport.dispatch() rejection is reported via diagnostics instead of throwing", async () => {
  const { sink, events } = collectDiagnostics();
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async () => { throw new Error("engine crashed"); },
  };
  await withDom(`<div></div>`, async (document) => {
    await assert.doesNotReject(new BrowserKernel(transport, document, sink).start());
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind === "BridgeError" && events[0].phase, "dispatch");
  });
});

test("a malformed projection is reported via diagnostics instead of throwing, and does not execute effects", async () => {
  const { sink, events } = collectDiagnostics();
  const transport = new ScriptedTransport(() =>
    // "message" is bound by data-text below but the view never provides it.
    respond({ view: {}, effects: [{ kind: "Http", correlationId: withCorrelation("c1"), method: "GET", url: "/x", timeoutMs: 1000 }] }),
  );
  await withDom(`<p data-text="message"></p>`, async (document) => {
    await assert.doesNotReject(new BrowserKernel(transport, document, sink).start());
    assert.equal(events.length, 1);
    assert.equal(events[0]?.kind === "BridgeError" && events[0].phase, "projection");
    // The malformed view must not be treated as a green light to run its effects.
    assert.equal(transport.calls.some((call) => call.kind === "EffectResult"), false);
  });
});

// ---------------------------------------------------------------------------
// Storage effect (get / set / remove)
// ---------------------------------------------------------------------------

test("a Storage set then get round-trips the same value", async () => {
  const key = "kernel-test-round-trip";
  const setId = withCorrelation("set-1");
  const getId = withCorrelation("get-1");
  const results = [];
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Storage", correlationId: setId, operation: "set", key, value: "hello" }] });
    if (message.kind === "EffectResult") {
      results.push(message.result);
      if (message.result.correlationId === setId) return respond({ effects: [{ kind: "Storage", correlationId: getId, operation: "get", key }] });
    }
    return respond();
  });
  await withDom(`<div></div>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    assert.deepEqual(results[0], { kind: "StorageResult", correlationId: setId, outcome: { kind: "Success", value: null } });
    assert.deepEqual(results[1], { kind: "StorageResult", correlationId: getId, outcome: { kind: "Success", value: "hello" } });
    assert.equal(window.localStorage.getItem(key), "hello");
  });
});

test("a Storage remove then get reports absence as value: null, not a failure", async () => {
  const key = "kernel-test-removed";
  const removeId = withCorrelation("remove-1");
  const getId = withCorrelation("get-1");
  const results = [];
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Storage", correlationId: removeId, operation: "remove", key }] });
    if (message.kind === "EffectResult") {
      results.push(message.result);
      if (message.result.correlationId === removeId) return respond({ effects: [{ kind: "Storage", correlationId: getId, operation: "get", key }] });
    }
    return respond();
  });
  await withDom(`<div></div>`, async (document) => {
    window.localStorage.setItem(key, "will be removed");
    await new BrowserKernel(transport, document).start();
    assert.deepEqual(results.at(-1), { kind: "StorageResult", correlationId: getId, outcome: { kind: "Success", value: null } });
  });
});

test("a Storage failure (e.g. quota exceeded) is classified, not thrown", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Storage", correlationId, operation: "set", key: "k", value: "v" }] });
    return respond();
  });
  await withDom(`<div></div>`, async (document) => {
    // localStorage supports direct key assignment (localStorage.foo = "bar"),
    // so jsdom proxies property *writes* on the instance through to storage
    // keys rather than letting them shadow real methods — patch the
    // prototype method instead, which is a plain, writable data property.
    const proto = Object.getPrototypeOf(window.localStorage);
    const realSetItem = proto.setItem;
    proto.setItem = () => { throw new window.DOMException("quota exceeded", "QuotaExceededError"); };
    try {
      await assert.doesNotReject(new BrowserKernel(transport, document).start());
    } finally {
      proto.setItem = realSetItem;
    }
    const result = transport.calls.at(-1);
    assert.deepEqual(result?.kind === "EffectResult" && result.result.outcome, { kind: "Failure", reason: "quota-exceeded" });
  });
});

test("a cancellation naming an already-completed Storage effect is a harmless no-op", async () => {
  const correlationId = withCorrelation("c1");
  const transport = new ScriptedTransport((message) => {
    if (message.kind === "Initialize") return respond({ effects: [{ kind: "Storage", correlationId, operation: "get", key: "absent" }] });
    if (message.kind === "Event" && message.event.name === "cancelStale") return respond({ cancellations: [correlationId] });
    return respond();
  });
  await withDom(`<button data-event="cancelStale"></button>`, async (document) => {
    await new BrowserKernel(transport, document).start();
    // By now the Storage effect has already completed synchronously and its
    // correlationId was never registered in #controllers (there is nothing
    // async to abort) — naming it in a later cancellation must not throw.
    await assert.doesNotReject((async () => {
      document.querySelector("button").click();
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    })());
  });
});
