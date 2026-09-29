// A malformed projection cannot partially mutate the current view
// (kemiller2002/limen#50, LCP-032). Before this, a projection whose
// data-each value was not an array still rewrote an earlier data-text,
// because values were written in document order and the error came later.
// Each case below applies one good projection, then a malformed one, and
// checks the page is exactly as the good one left it, with the malformed
// projection's effects not run.

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import type { BrowserToEngineMessage, CorrelationId, EngineTransport, ViewState } from "../dist/protocol.js";
import { withDom, withFetch } from "./dom-helpers.ts";

const PAGE = `
  <h1 data-text="title"></h1>
  <a data-bind-href="link" data-text="title"></a>
  <template data-if="panel"><section id="panel"><p data-text="panelText"></p><template data-if="inner"><em data-text="innerText"></em></template></section></template>
  <ul><template data-each="rows" data-key="id"><li><span data-text="label"></span><template data-each="tags" data-key="t"><b data-text="t"></b></template></li></template></ul>
  <button id="go" data-event="go">go</button>`;

const good: ViewState = { title: "one", link: "/one", panel: true, panelText: "p1", inner: false, rows: [{ id: "a", label: "A", tags: [] }] };

type Seen = { readonly diagnostics: string[]; readonly fetched: number };

const scenario = async (bad: ViewState): Promise<{ readonly before: string; readonly after: string; readonly seen: Seen }> => {
  const state = { view: good, fetched: 0 };
  const diagnostics: string[] = [];
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => ({
      view: state.view, cancellations: [],
      effects: message.kind === "Event" ? [{ kind: "Http", correlationId: "e1" as CorrelationId, method: "GET", url: "/x", timeoutMs: 100 }] : [],
    }),
  };
  const fetchImpl = (async () => { state.fetched += 1; return Response.json({}); }) as typeof fetch;
  return withFetch(fetchImpl, () => withDom(PAGE, async (document) => {
    await new BrowserKernel(transport, document, { report: (event) => { if (event.kind === "BridgeError") diagnostics.push(event.detail); } }).start();
    const before = document.body.innerHTML;
    state.view = bad;
    document.getElementById("go")?.click();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    return { before, after: document.body.innerHTML, seen: { diagnostics, fetched: state.fetched } };
  }));
};

const unchanged = async (bad: ViewState, expected: string): Promise<void> => {
  const { before, after, seen } = await scenario(bad);
  assert.equal(after, before, "the page is exactly as the last good projection left it");
  assert.deepEqual(seen.diagnostics, [expected]);
  assert.equal(seen.fetched, 0, "the malformed projection's effects were not run");
};

test("a list that is not an array: the earlier text is not rewritten", async () => {
  await unchanged({ ...good, title: "two", rows: "not an array" }, `data-each="rows" requires an array view value`);
});

test("a missing scalar late in the document: nothing earlier changes", async () => {
  await unchanged({ ...good, title: "two", link: "/two", panelText: { nested: true } as never }, `View value for "panelText" is missing or not scalar`);
});

test("a row that would mount with a missing field: no row is added and nothing else changes", async () => {
  await unchanged({ ...good, title: "two", rows: [{ id: "a", label: "A", tags: [] }, { id: "b", tags: [] }] }, `View value for "label" is missing or not scalar`);
});

test("a nested list inside a new row that is not an array", async () => {
  await unchanged({ ...good, title: "two", rows: [{ id: "a", label: "A", tags: [] }, { id: "b", label: "B", tags: "x" }] }, `data-each="tags" requires an array view value`);
});

test("a row without its key field", async () => {
  await unchanged({ ...good, title: "two", rows: [{ label: "no id" }] }, `data-each item missing key field "id"`);
});

test("a nested section that would mount with a missing value", async () => {
  await unchanged({ ...good, title: "two", inner: true }, `View value for "innerText" is missing or not scalar`);
});

test("an existing row whose new values are malformed", async () => {
  await unchanged({ ...good, title: "two", rows: [{ id: "a", label: ["not", "scalar"] as never, tags: [] }] }, `View value for "label" is missing or not scalar`);
});

test("a well-formed projection still applies completely, including new rows, nested lists and sections", async () => {
  const { after, seen } = await scenario({ ...good, title: "two", inner: true, innerText: "deep", rows: [{ id: "a", label: "A2", tags: [{ t: "x" }] }, { id: "b", label: "B", tags: [] }] });
  assert.deepEqual(seen.diagnostics, []);
  assert.equal(seen.fetched, 1);
  assert.match(after, />two<\/h1>/);
  assert.match(after, />deep<\/em>/);
  assert.match(after, />A2<\/span><!--each:tags--><b data-text="t">x<\/b>/);
  assert.match(after, />B<\/span>/);
});
