// Documentation verification: every example under examples/ is driven here
// through the real BrowserKernel against its own real index.html.
//
// The point is not extra kernel coverage — test/kernel.test.ts owns that. The
// point is that the examples the documentation teaches from cannot silently
// stop working. If an example's HTML, engine, or documented behavior drifts,
// this file fails.
//
// Engines are imported as .ts directly (their only kernel imports are
// type-only, so nothing needs building first); BrowserKernel is imported from
// dist/ because it has a real runtime import. Same split as the rest of the
// suite — see test/kernel.test.ts's header.
//
// Two testing levels are used deliberately, and the docs teach the same split:
//   - Through the kernel + jsdom, for anything involving the DOM.
//   - Against the pure transition/projection functions, for outcomes that are
//     awkward or slow to provoke through a real round-trip (timeouts,
//     cancellation, stale evidence). Those need no DOM at all.
import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { CorrelationId } from "../dist/protocol.js";
import { exampleBody, withDom, withFetch } from "./dom-helpers.ts";

import { createCounterTransport } from "../examples/01-counter/engine.ts";
import { createFormTransport, transition as formTransition, initialState as formInitial } from "../examples/02-form/engine.ts";
import { createFetchTransport, transition as fetchTransition, project as fetchProject } from "../examples/03-fetch-data/engine.ts";
import { createSaveTransport, transition as saveTransition, project as saveProject } from "../examples/04-save-data/engine.ts";
import { createMultiScreenTransport } from "../examples/05-multi-screen/engine.ts";
import {
  createTimeEntriesTransport,
  transition as entriesTransition,
  project as entriesProject,
  type Entry,
} from "../examples/06-time-entries/engine.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A click dispatches to the engine as fire-and-forget from the DOM's point of
// view, so asserting on *applied* DOM state needs a yield past pending
// microtasks first. See test/kernel.test.ts for the full explanation of the
// two timing regimes.
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0); });

function find<T extends HTMLElement>(document: Document, selector: string): T {
  const el = document.querySelector<T>(selector);
  assert.ok(el, `no element matched ${selector}`);
  return el;
}

async function click(document: Document, selector: string): Promise<void> {
  find<HTMLElement>(document, selector).click();
  await flush();
}

// Sets a field's value and fires the DOM event the example binds to, exactly
// as a browser would.
async function type(document: Document, selector: string, value: string, eventType = "input"): Promise<void> {
  const el = find<HTMLInputElement | HTMLTextAreaElement>(document, selector);
  el.value = value;
  el.dispatchEvent(new (el.ownerDocument.defaultView as Window & typeof globalThis).Event(eventType, { bubbles: true }));
  await flush();
}

async function submit(document: Document, selector: string): Promise<void> {
  const form = find<HTMLFormElement>(document, selector);
  form.dispatchEvent(new (form.ownerDocument.defaultView as Window & typeof globalThis).Event("submit", { bubbles: true, cancelable: true }));
  await flush();
}

const text = (document: Document, selector: string): string =>
  document.querySelector(selector)?.textContent?.trim() ?? "";

const present = (document: Document, selector: string): boolean => document.querySelector(selector) !== null;

const isDisabled = (document: Document, selector: string): boolean =>
  find<HTMLButtonElement>(document, selector).disabled;

type StubResponse = { status: number; body: unknown };
type Route = (url: string, init: RequestInit | undefined) => StubResponse | "network-error";

// A fetch stub that records what the kernel actually sent, so tests can assert
// the engine's effect request survived the trip intact.
function stubFetch(route: Route): { impl: typeof fetch; calls: Array<{ url: string; init: RequestInit | undefined }> } {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const result = route(url, init);
    if (result === "network-error") throw new Error("simulated network failure");
    return { status: result.status, json: async () => result.body };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const cid = (value: string): CorrelationId => value as CorrelationId;

// ---------------------------------------------------------------------------
// 01-counter
// ---------------------------------------------------------------------------

test("01-counter: the initial projection renders before any interaction", async () => {
  await withDom(await exampleBody("01-counter"), async (document) => {
    await new BrowserKernel(createCounterTransport(), document).start();
    assert.equal(text(document, "[data-text='count']"), "0");
    assert.equal(isDisabled(document, "[data-event='reset']"), true, "Reset starts unavailable");
  });
});

test("01-counter: clicking increment transitions state and re-projects", async () => {
  await withDom(await exampleBody("01-counter"), async (document) => {
    await new BrowserKernel(createCounterTransport(), document).start();
    await click(document, "[data-event='increment']");
    assert.equal(text(document, "[data-text='count']"), "1");
    await click(document, "[data-event='increment']");
    assert.equal(text(document, "[data-text='count']"), "2");
  });
});

test("01-counter: the engine projects Reset's availability; the DOM never derives it", async () => {
  await withDom(await exampleBody("01-counter"), async (document) => {
    await new BrowserKernel(createCounterTransport(), document).start();
    await click(document, "[data-event='increment']");
    assert.equal(isDisabled(document, "[data-event='reset']"), false);
    await click(document, "[data-event='reset']");
    assert.equal(text(document, "[data-text='count']"), "0");
    assert.equal(isDisabled(document, "[data-event='reset']"), true);
  });
});

// ---------------------------------------------------------------------------
// 02-form
// ---------------------------------------------------------------------------

test("02-form: submit is unavailable until the whole draft validates", async () => {
  await withDom(await exampleBody("02-form"), async (document) => {
    await new BrowserKernel(createFormTransport(), document).start();
    assert.equal(isDisabled(document, "button[type='submit']"), true);

    await type(document, "#name", "Ada");
    assert.equal(isDisabled(document, "button[type='submit']"), true, "still missing an email");

    await type(document, "#email", "ada@example.com");
    assert.equal(isDisabled(document, "button[type='submit']"), false);
  });
});

test("02-form: a validation message mounts only once a field is wrong, not while empty", async () => {
  await withDom(await exampleBody("02-form"), async (document) => {
    await new BrowserKernel(createFormTransport(), document).start();
    assert.equal(present(document, "[data-text='emailError']"), false, "no scolding before typing");

    await type(document, "#email", "nope");
    assert.equal(text(document, "[data-text='emailError']"), "Enter a valid email address.");

    await type(document, "#email", "ada@example.com");
    assert.equal(present(document, "[data-text='emailError']"), false, "message unmounts once valid");
  });
});

test("02-form: submitting a valid draft mounts the confirmation and locks the fields", async () => {
  await withDom(await exampleBody("02-form"), async (document) => {
    await new BrowserKernel(createFormTransport(), document).start();
    await type(document, "#name", "Ada");
    await type(document, "#email", "ada@example.com");
    await submit(document, "form");

    assert.equal(text(document, "[data-text='confirmation']"), "Account created for Ada (ada@example.com).");
    assert.equal(find<HTMLInputElement>(document, "#name").disabled, true);
    assert.equal(present(document, "[data-event='startOver']"), true);
  });
});

test("02-form: editing after submitting is rejected as an illegal transition", () => {
  const submitted = formTransition(
    formTransition(formTransition(formInitial, { kind: "EditName", value: "Ada" }).state, { kind: "EditEmail", value: "ada@example.com" }).state,
    { kind: "Submit" },
  );
  assert.equal(submitted.accepted, true);
  assert.equal(submitted.state.kind, "Submitted");

  const illegal = formTransition(submitted.state, { kind: "EditName", value: "Grace" });
  assert.equal(illegal.accepted, false);
  assert.equal(illegal.state.kind, "Submitted", "a rejected command leaves state untouched");
  assert.equal(illegal.state.draft.name, "Ada");
});

test("02-form: submitting an invalid draft is rejected and reported", () => {
  const partial = formTransition(formInitial, { kind: "EditName", value: "A" }).state;
  const result = formTransition(partial, { kind: "Submit" });
  assert.equal(result.accepted, false);
  assert.equal(result.state.kind, "Editing");
});

// ---------------------------------------------------------------------------
// 03-fetch-data
// ---------------------------------------------------------------------------

const CUSTOMERS = [
  { id: "1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "2", name: "Grace Hopper", email: "grace@example.com" },
];

test("03-fetch-data: a successful load renders one row per item via data-each", async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: CUSTOMERS }));
  await withFetch(impl, async () => {
    await withDom(await exampleBody("03-fetch-data"), async (document) => {
      await new BrowserKernel(createFetchTransport(), document).start();
      assert.equal(text(document, "[data-text='statusText']"), "Nothing loaded yet.");

      await click(document, "[data-event='load']");
      assert.equal(calls[0]?.url, "/api/customers");
      assert.equal(calls[0]?.init?.method, "GET");
      assert.equal(calls[0]?.init?.body, undefined, "a GET carries no body");

      assert.equal(text(document, "[data-text='statusText']"), "2 customer(s).");
      assert.equal(document.querySelectorAll(".list li").length, 2);
      assert.equal(text(document, ".list li [data-text='name']"), "Ada Lovelace");
    });
  });
});

test("03-fetch-data: a network failure becomes a retryable state, not an exception", async () => {
  const { impl } = stubFetch(() => "network-error");
  await withFetch(impl, async () => {
    await withDom(await exampleBody("03-fetch-data"), async (document) => {
      await new BrowserKernel(createFetchTransport(), document).start();
      await click(document, "[data-event='load']");
      assert.equal(text(document, "[data-text='statusText']"), "Could not reach the server.");
      assert.equal(present(document, "[data-event='retry']"), true);
    });
  });
});

test("03-fetch-data: a well-formed response with the wrong shape is a non-retryable failure", async () => {
  const { impl } = stubFetch(() => ({ status: 200, body: { oops: true } }));
  await withFetch(impl, async () => {
    await withDom(await exampleBody("03-fetch-data"), async (document) => {
      await new BrowserKernel(createFetchTransport(), document).start();
      await click(document, "[data-event='load']");
      assert.equal(text(document, "[data-text='statusText']"), "The server sent something unexpected.");
      assert.equal(present(document, "[data-event='retry']"), false, "retrying cannot fix a schema mismatch");
    });
  });
});

test("03-fetch-data: a timeout is represented as OutcomeUnknown, and a GET stays retryable", () => {
  const loading = fetchTransition({ kind: "Idle" }, { kind: "Load", correlationId: cid("load-1") });
  assert.equal(loading.state.kind, "Loading");
  assert.equal(loading.effects.length, 1);

  const unknown = fetchTransition(loading.state, {
    kind: "RecordLoad",
    correlationId: cid("load-1"),
    outcome: { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" },
  });
  assert.equal(unknown.state.kind, "LoadOutcomeUnknown");
  assert.equal(fetchProject(unknown.state)["canRetry"], true, "a GET is idempotent, so retrying is safe");
});

test("03-fetch-data: a result for a superseded request is discarded", () => {
  const loading = fetchTransition({ kind: "Idle" }, { kind: "Load", correlationId: cid("load-2") }).state;
  const stale = fetchTransition(loading, {
    kind: "RecordLoad",
    correlationId: cid("load-1"),
    outcome: { kind: "Success", status: 200, body: CUSTOMERS },
  });
  assert.equal(stale.state.kind, "Loading", "the stale success must not land");
});

// ---------------------------------------------------------------------------
// 04-save-data
// ---------------------------------------------------------------------------

test("04-save-data: startup reads the saved draft through a Storage effect", async () => {
  const { impl } = stubFetch(() => ({ status: 201, body: {} }));
  await withFetch(impl, async () => {
    await withDom(await exampleBody("04-save-data"), async (document) => {
      window.localStorage.setItem("example-04-draft", "restored text");
      await new BrowserKernel(createSaveTransport(), document).start();
      await flush();
      assert.equal(find<HTMLTextAreaElement>(document, "#note").value, "restored text");
      window.localStorage.clear();
    });
  });
});

test("04-save-data: typing persists a draft, and a successful save clears it", async () => {
  const { impl, calls } = stubFetch(() => ({ status: 201, body: { id: "n1" } }));
  await withFetch(impl, async () => {
    await withDom(await exampleBody("04-save-data"), async (document) => {
      window.localStorage.clear();
      await new BrowserKernel(createSaveTransport(), document).start();
      await flush();

      await type(document, "#note", "hello world");
      assert.equal(window.localStorage.getItem("example-04-draft"), "hello world");
      assert.equal(isDisabled(document, "[data-event='save']"), false);

      await click(document, "[data-event='save']");
      assert.equal(calls[0]?.init?.method, "POST");
      assert.equal(calls[0]?.init?.body, JSON.stringify({ text: "hello world" }));
      assert.equal(text(document, "[data-text='statusText']"), "Saved.");
      assert.equal(window.localStorage.getItem("example-04-draft"), null, "the draft is obsolete once saved");
    });
  });
});

test("04-save-data: an unreadable draft store still yields a usable editor", () => {
  const restored = saveTransition({ kind: "Restoring" }, {
    kind: "RestoreDraft",
    outcome: { kind: "Failure", reason: "unavailable" },
  });
  assert.equal(restored.state.kind, "Editing");
  assert.equal(saveProject(restored.state)["text"], "");
});

test("04-save-data: a timed-out POST offers reconciliation, never a blind retry", () => {
  const editing = saveTransition({ kind: "Restoring" }, { kind: "RestoreDraft", outcome: { kind: "Success", value: "draft" } }).state;
  const saving = saveTransition(editing, { kind: "Save", correlationId: cid("save-1") });
  assert.equal(saving.state.kind, "Saving");

  const unknown = saveTransition(saving.state, {
    kind: "RecordSave",
    correlationId: cid("save-1"),
    outcome: { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" },
  });
  assert.equal(unknown.state.kind, "SaveOutcomeUnknown");
  const view = saveProject(unknown.state);
  assert.equal(view["needsReconciliation"], true);
  assert.equal(view["canRetry"], false, "a POST that may have succeeded must not be repeated");
});

// ---------------------------------------------------------------------------
// 05-multi-screen
// ---------------------------------------------------------------------------

// Exactly what examples/05-multi-screen/main.ts ships, routing included, so
// these tests drive the real configuration rather than a simpler one.
const mountMultiScreen = (document: Document): Promise<void> =>
  new BrowserKernel(createMultiScreenTransport(), document, undefined, { historyEvent: "urlChanged" }).start();

const windowOf = (document: Document): Window => {
  assert.ok(document.defaultView, "the test document has no window");
  return document.defaultView;
};

// history.back()/forward() are queued traversals, not synchronous calls, so
// waiting on the observable result beats guessing at a delay.
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

const screenIsMounted = (document: Document, selector: string) => (): boolean => present(document, selector);

test("05-multi-screen: exactly one screen is mounted at a time", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    await mountMultiScreen(document);
    assert.equal(text(document, "[data-text='greeting']"), "Hello, Guest.");
    assert.equal(present(document, "#filter"), false, "the Customers screen is not mounted");
    assert.equal(present(document, "#display-name"), false, "the Settings screen is not mounted");
    assert.equal(document.querySelectorAll("section.panel").length, 1, "exactly one screen exists in the DOM");
  });
});

test("05-multi-screen: a nav click carries the screen name as the item key", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    await mountMultiScreen(document);
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"));
    assert.deepEqual(buttons.map((b) => b.textContent), ["Home", "Customers", "Settings"]);

    buttons[1]!.click();
    await flush();
    assert.equal(present(document, "#filter"), true, "the Customers screen mounted");
    assert.equal(present(document, "[data-text='greeting']"), false, "the Home screen unmounted");
    assert.equal(document.querySelectorAll(".list li").length, 3);
  });
});

test("05-multi-screen: filtering is done by the engine, not the DOM", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    await mountMultiScreen(document);
    Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"))[1]!.click();
    await flush();

    await type(document, "#filter", "grace");
    assert.equal(document.querySelectorAll(".list li").length, 1);
    assert.equal(text(document, ".list li"), "Grace Hopper");

    await type(document, "#filter", "zzz");
    assert.equal(document.querySelectorAll(".list li").length, 0);
  });
});

test("05-multi-screen: shared state survives navigation; screen-local state does not", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    await mountMultiScreen(document);
    const nav = (index: number): HTMLButtonElement =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"))[index]!;

    // Set a screen-local filter on Customers.
    nav(1).click();
    await flush();
    await type(document, "#filter", "ada");
    assert.equal(document.querySelectorAll(".list li").length, 1);

    // Change shared state on Settings.
    nav(2).click();
    await flush();
    await type(document, "#display-name", "Ada");
    await click(document, "[data-event='saveDisplayName']");

    // Shared state reached Home.
    nav(0).click();
    await flush();
    assert.equal(text(document, "[data-text='greeting']"), "Hello, Ada.");

    // Screen-local state was discarded on the way out.
    nav(1).click();
    await flush();
    assert.equal(find<HTMLInputElement>(document, "#filter").value, "");
    assert.equal(document.querySelectorAll(".list li").length, 3);
  });
});

// --- routing and history -----------------------------------------------------
//
// The user-visible claim these defend: the address bar and the screen never
// disagree, and Back/Forward move between screens instead of leaving the app.

test("05-multi-screen: navigating updates the address bar", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    await mountMultiScreen(document);
    // Opening with no route at all canonicalizes to Home rather than leaving
    // a URL that does not round-trip.
    assert.equal(view.location.hash, "#/");

    Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"))[1]!.click();
    await flush();
    assert.equal(view.location.hash, "#/customers");
    assert.equal(present(document, "#filter"), true);
  });
});

test("05-multi-screen: a deep link opens directly on that screen", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    view.history.replaceState(null, "", "#/settings");
    await mountMultiScreen(document);

    // Settings is the *first* thing projected — not Home corrected a moment
    // later. That is why the location rides on Initialize rather than
    // arriving as an event after it.
    assert.equal(present(document, "#display-name"), true, "the Settings screen mounted");
    assert.equal(present(document, "[data-text='greeting']"), false, "Home was never shown");
  });
});

test("05-multi-screen: a URL naming no screen lands on Home and is corrected without a history entry", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    view.history.replaceState(null, "", "#/not-a-screen");
    const entries = view.history.length;
    await mountMultiScreen(document);

    assert.equal(present(document, "[data-text='greeting']"), true, "an unknown route is Home");
    assert.equal(view.location.hash, "#/");
    assert.equal(view.history.length, entries, "correcting the URL is a replace, not a step to go Back from");
  });
});

test("05-multi-screen: a hash edited to a nonexistent route is corrected, not just ignored", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    await mountMultiScreen(document);

    // Editing the hash in the address bar is a same-document move: the page
    // does not reload, so this arrives as a history event rather than through
    // Initialize. Found by driving the example in a real browser — the first
    // version of this engine left the address bar saying "#/nonsense" while
    // Home was on screen, which is precisely the disagreement the architecture
    // exists to prevent.
    view.location.hash = "#/nonsense";
    await until(() => view.location.hash === "#/", "the bad route to be corrected");

    assert.equal(present(document, "[data-text='greeting']"), true, "an unknown route is Home");
  });
});

test("05-multi-screen: Back and Forward move between screens", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    await mountMultiScreen(document);
    const nav = (index: number): HTMLButtonElement =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"))[index]!;

    nav(1).click();
    await flush();
    nav(2).click();
    await flush();
    assert.equal(present(document, "#display-name"), true, "on Settings");

    view.history.back();
    await until(screenIsMounted(document, "#filter"), "Back to return to Customers");
    assert.equal(view.location.hash, "#/customers");
    assert.equal(present(document, "#display-name"), false, "Settings unmounted");

    view.history.forward();
    await until(screenIsMounted(document, "#display-name"), "Forward to return to Settings");
    assert.equal(view.location.hash, "#/settings");
  });
});

test("05-multi-screen: Back does not push, so Forward still works after it", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    await mountMultiScreen(document);
    const nav = (index: number): HTMLButtonElement =>
      Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"))[index]!;

    nav(1).click();
    await flush();
    const entries = view.history.length;

    view.history.back();
    await until(screenIsMounted(document, "[data-text='greeting']"), "Back to return to Home");

    // If catching up with the browser pushed an entry of its own, the forward
    // history would have been destroyed and the count would have grown. This
    // is the whole reason RestoreRoute is a separate command from Navigate.
    assert.equal(view.history.length, entries, "responding to history must not rewrite it");

    view.history.forward();
    await until(screenIsMounted(document, "#filter"), "Forward to still be available");
  });
});

test("05-multi-screen: re-clicking the current tab adds no history entry", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    await mountMultiScreen(document);
    const customers = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"))[1]!;

    customers.click();
    await flush();
    const entries = view.history.length;

    customers.click();
    await flush();
    customers.click();
    await flush();

    // Otherwise leaving the page would take one press of Back per idle click.
    assert.equal(view.history.length, entries);
    assert.equal(view.location.hash, "#/customers");
  });
});

test("05-multi-screen: without the navigation binding the example still works and never touches the URL", async () => {
  await withDom(await exampleBody("05-multi-screen"), async (document) => {
    const view = windowOf(document);
    const before = { hash: view.location.hash, entries: view.history.length };
    // No fourth argument: the kernel announces no Navigation capability and
    // sends no location, so the engine stays within one page load. An
    // existing consumer that never opts in is unaffected by any of this.
    await new BrowserKernel(createMultiScreenTransport(), document).start();

    Array.from(document.querySelectorAll<HTMLButtonElement>(".nav button"))[1]!.click();
    await flush();

    assert.equal(present(document, "#filter"), true, "screens still work");
    assert.equal(view.location.hash, before.hash, "the URL was never touched");
    assert.equal(view.history.length, before.entries);
  });
});

// ---------------------------------------------------------------------------
// 06-time-entries
// ---------------------------------------------------------------------------

const ENTRY: Entry = { id: "e1", date: "2026-09-01", hours: 3, description: "Wrote docs", status: "Saved" };
const asJson = (entries: readonly Entry[]): unknown => entries.map((entry) => ({ ...entry }));

test("06-time-entries: the list loads on startup without any user interaction", async () => {
  const { impl, calls } = stubFetch(() => ({ status: 200, body: asJson([ENTRY]) }));
  await withFetch(impl, async () => {
    await withDom(await exampleBody("06-time-entries"), async (document) => {
      await new BrowserKernel(createTimeEntriesTransport(), document).start();
      await flush();
      assert.equal(calls[0]?.url, "/api/time-entries");
      assert.equal(document.querySelectorAll(".list li").length, 1);
      assert.equal(text(document, "[data-text='summary']"), "1 entry, 3 hour(s).");
    });
  });
});

test("06-time-entries: adding an entry POSTs the validated draft, then re-reads the list", async () => {
  const added: Entry = { id: "e2", date: "2026-09-02", hours: 1.5, description: "Review", status: "Saved" };
  let posted = false;
  const { impl, calls } = stubFetch((url, init) => {
    if (init?.method === "POST") { posted = true; return { status: 201, body: { id: "e2" } }; }
    return { status: 200, body: asJson(posted ? [ENTRY, added] : [ENTRY]) };
  });

  await withFetch(impl, async () => {
    await withDom(await exampleBody("06-time-entries"), async (document) => {
      await new BrowserKernel(createTimeEntriesTransport(), document).start();
      await flush();

      assert.equal(isDisabled(document, "form button[type='submit']"), true, "an empty draft cannot be added");
      await type(document, "#date", "2026-09-02");
      await type(document, "#hours", "1.5");
      assert.equal(isDisabled(document, "form button[type='submit']"), true, "still missing a description");
      await type(document, "#description", "Review");
      assert.equal(isDisabled(document, "form button[type='submit']"), false);

      await submit(document, "form");
      await flush();

      const post = calls.find((call) => call.init?.method === "POST");
      assert.ok(post, "a POST was issued");
      assert.equal(post.init?.body, JSON.stringify({ date: "2026-09-02", hours: 1.5, description: "Review" }));
      assert.equal(document.querySelectorAll(".list li").length, 2);
      assert.equal(text(document, "[data-text='notice']"), "Entry added.");
      assert.equal(find<HTMLInputElement>(document, "#description").value, "", "the draft cleared on a confirmed add");
    });
  });
});

test("06-time-entries: marking a row processed PATCHes that row's id", async () => {
  let processed = false;
  const { impl, calls } = stubFetch((url, init) => {
    if (init?.method === "PATCH") { processed = true; return { status: 200, body: {} }; }
    return { status: 200, body: asJson([{ ...ENTRY, status: processed ? "Processed" : "Saved" }]) };
  });

  await withFetch(impl, async () => {
    await withDom(await exampleBody("06-time-entries"), async (document) => {
      await new BrowserKernel(createTimeEntriesTransport(), document).start();
      await flush();
      assert.equal(isDisabled(document, ".list li [data-event='markProcessed']"), false);

      await click(document, ".list li [data-event='markProcessed']");
      await flush();

      const patch = calls.find((call) => call.init?.method === "PATCH");
      assert.ok(patch, "a PATCH was issued");
      assert.equal(patch.url, "/api/time-entries/e1");
      assert.equal(text(document, ".list li [data-text='status']"), "Processed");
      assert.equal(isDisabled(document, ".list li [data-event='markProcessed']"), true, "processing twice is not offered");
    });
  });
});

test("06-time-entries: a failed refresh keeps the entries already on screen", () => {
  const ready = { kind: "Ready", entries: [ENTRY], draft: { date: "", hours: "", description: "" }, notice: "" } as const;
  const refreshing = entriesTransition(ready, { kind: "Load", correlationId: cid("entries-9") });
  assert.equal(refreshing.state.kind, "Refreshing");

  const failed = entriesTransition(refreshing.state, {
    kind: "RecordResult",
    correlationId: cid("entries-9"),
    outcome: { kind: "Failure", reason: "network" },
  });
  assert.equal(failed.state.kind, "Ready", "a failed refresh does not discard a usable list");
  assert.equal(entriesProject(failed.state)["notice"], "Could not reach the server.");
  assert.equal(entriesProject(failed.state)["hasEntries"], true);
});

test("06-time-entries: a failed initial load has nothing to show, so it becomes LoadFailed", () => {
  const loading = entriesTransition({ kind: "Loading" }, { kind: "Load", correlationId: cid("entries-1") });
  const failed = entriesTransition(loading.state, {
    kind: "RecordResult",
    correlationId: cid("entries-1"),
    outcome: { kind: "Failure", reason: "network" },
  });
  assert.equal(failed.state.kind, "LoadFailed");
  assert.equal(entriesProject(failed.state)["loadFailed"], true);
});

test("06-time-entries: a timed-out write reports uncertainty instead of retrying", () => {
  const ready = { kind: "Ready", entries: [ENTRY], draft: { date: "2026-09-02", hours: "2", description: "Work" }, notice: "" } as const;
  const submitting = entriesTransition(ready, { kind: "AddEntry", correlationId: cid("entries-5") });
  assert.equal(submitting.state.kind, "Submitting");

  const unknown = entriesTransition(submitting.state, {
    kind: "RecordResult",
    correlationId: cid("entries-5"),
    outcome: { kind: "OutcomeUnknown", reason: "timeout-after-dispatch" },
  });
  assert.equal(unknown.state.kind, "Ready");
  assert.equal(unknown.effects.length, 0, "no automatic retry of a non-idempotent write");
  assert.match(String(entriesProject(unknown.state)["notice"]), /may or may not have been applied/);
});

test("06-time-entries: marking an already-processed entry issues no effect", () => {
  const ready = {
    kind: "Ready",
    entries: [{ ...ENTRY, status: "Processed" as const }],
    draft: { date: "", hours: "", description: "" },
    notice: "",
  } as const;
  const result = entriesTransition(ready, { kind: "MarkProcessed", entryId: "e1", correlationId: cid("entries-7") });
  assert.equal(result.state.kind, "Ready");
  assert.equal(result.effects.length, 0);
});
