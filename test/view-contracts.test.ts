// View contracts (kemiller2002/limen#48, LCP-042): the static checker against
// one fixture per failure class with a deterministic diagnostic snapshot, and
// the same contracts held against real engines — the reference engine, the
// shipped minimal counter, and (through the shared session) the F#, C# and
// Rust minimal engines. test/examples.test.ts does the same for every numbered
// example; the F# site engine's own tests hold it to site/pages/*.view.json.

import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { checkEvent, checkPage, checkProjection, formatDiagnostic, parseViewContract, tagsOf, type ViewContract } from "../dist/tooling/view-contract.js";
import { DirectTypeScriptTransport } from "../dist/engine/transport.js";
import { CORE_CONTRACT_IDENTITY, type BrowserToEngineMessage, type EngineToBrowserMessage, type SemanticEvent } from "../dist/protocol.js";
import { createFakeHost } from "../dist/tooling/fake-host.js";
import { loadContract } from "./view-conformance.ts";
// @ts-expect-error — the shipped minimal example is plain JavaScript with no declarations.
import { createCounterTransport as createMinimalCounter } from "../examples/minimal/engine.js";

const FIXTURES = "test/fixtures/views";
const fixtureContract = loadContract(`${FIXTURES}/app.view.json`);

const fixturePages = async (): Promise<readonly string[]> =>
  (await readdir(FIXTURES)).filter((name) => name.endsWith(".html")).sort();

const diagnose = async (name: string): Promise<readonly string[]> =>
  checkPage(`${FIXTURES}/${name}`, await readFile(`${FIXTURES}/${name}`, "utf8"), fixtureContract).map(formatDiagnostic);

test("a page that uses every binding correctly passes, and comments and scripts are not bindings", async () => {
  assert.deepEqual(await diagnose("valid.html"), []);
});

const failing: readonly (readonly [string, RegExp])[] = [
  ["missing-text.html", /data-text: "titel" is not in the view contract \(expected one of: busy, count, flag, rows, title\)/],
  ["missing-bind.html", /data-bind-disabled: "bussy" is not in the view contract/],
  ["if-kind.html", /data-if: "count" is number \(expected boolean/],
  ["each-missing-list.html", /data-each: "items" is not in the view contract/],
  ["each-missing-field.html", /data-text: "name" is not a field of rows's items \(expected one of: done, id, label\)/],
  ["each-missing-key.html", /data-key: data-each="rows" has no data-key/],
  ["each-invalid-key.html", /data-key: "uid" is not a field of rows's items/],
  ["each-nested.html", /data-each="rows" is nested in another data-each/],
  ["unknown-event.html", /data-event: "delete" is not an event the engine accepts \(expected one of: add, remove, rename\)/],
  ["event-scope.html", /"remove" must be sent from a row of rows/],
  ["event-value.html", /"rename" expects a value, but <button> sends none/],
  ["boolean-property.html", /"flag" is string \(expected boolean — disabled is set with Boolean\(value\)/],
  ["list-as-scalar.html", /data-text: "rows" is list \(expected a string, number, boolean or scalar, not a list/],
  ["misplaced.html", /data-if is only supported on <template>/],
  ["trigger-without-event.html", /data-on without data-event does nothing/],
  ["forbidden-target.html", /data-bind-onclick is not a projection target: onclick is an event-handler attribute/],
  ["unbindable-element.html", /<script> loads, runs or rewrites code or other attributes; it takes no data-text or data-bind-\* bindings/],
];

for (const [page, pattern] of failing) {
  test(`fixture ${page} fails with its own diagnostic, naming file, line, element, binding and expectation`, async () => {
    const diagnostics = await diagnose(page);
    assert.ok(diagnostics.some((line) => pattern.test(line)), diagnostics.join("\n"));
    assert.ok(diagnostics.every((line) => line.startsWith(`${FIXTURES}/${page}:`)), "every diagnostic names the file and line");
  });
}

test("every fixture page is covered by a case above", async () => {
  assert.deepEqual((await fixturePages()).filter((page) => page !== "valid.html" && !failing.some(([name]) => name === page)), []);
});

test("diagnostics are deterministic: the snapshot of every fixture is exact", async () => {
  const snapshot = (await Promise.all((await fixturePages()).map(diagnose))).flat().join("\n") + "\n";
  const path = `${FIXTURES}/diagnostics.snapshot.txt`;
  if (process.env.UPDATE_SNAPSHOTS === "1") await writeFile(path, snapshot);
  assert.equal(snapshot, await readFile(path, "utf8"));
});

test("the tokenizer reads attributes in every quoting style, skips comments, and reads script and style tags but not their content", () => {
  const tags = tagsOf(`<!-- <b data-text="x"> -->\n<p data-text=bare data-bind-title='single' data-bind-lang="double"></p><style>a[data-text="y"]{}</style>`);
  assert.deepEqual(tags.map((tag) => [tag.line, tag.name, tag.closing, Object.fromEntries(tag.attributes)]), [
    [2, "p", false, { "data-text": "bare", "data-bind-title": "single", "data-bind-lang": "double" }],
    [2, "p", true, {}],
    [2, "style", false, {}],
  ]);
});

test("a malformed contract is refused with every problem named", () => {
  const parsed = parseViewContract({ view: { a: "text", rows: { list: { id: "date" } } }, events: { go: { item: "a", extra: 1 } }, version: 2 });
  assert.equal(parsed.ok, false);
  assert.deepEqual(!parsed.ok && parsed.errors, [
    "version: unknown field",
    "view.a: expected one of string, number, boolean, scalar, or { \"list\": { field: kind } }",
    "view.rows.list.id: expected one of string, number, boolean, scalar",
    "events.go.extra: unknown field",
    "events.go.item: \"a\" is not a list in view",
  ]);
});

test("checkProjection names missing keys, wrong kinds, bad items and keys the contract lacks", () => {
  assert.deepEqual(checkProjection({ title: "t", count: "3", busy: false, flag: "x", rows: [{ id: "1", label: "a", done: "no" }, { id: "2", done: true, extra: 1 }], stray: 1 }, fixtureContract), [
    "view.count: string, expected number",
    "view.rows[0].done: string, expected boolean",
    "view.rows[1].label: missing, expected string",
    "view.rows[1].extra: not in the contract",
    "view.stray: not in the contract",
  ]);
});

test("checkEvent names undeclared events, and a row key or value where the contract says otherwise", () => {
  const event = (name: string, key?: string, value?: string): SemanticEvent => ({ kind: "Event", name, ...(key === undefined ? {} : { key }), ...(value === undefined ? {} : { value }) });
  assert.deepEqual([event("add"), event("remove", "1"), event("rename", undefined, "x")].flatMap((e) => checkEvent(e, fixtureContract)), []);
  assert.deepEqual([event("delete"), event("remove"), event("add", "1"), event("rename")].flatMap((e) => checkEvent(e, fixtureContract)), [
    "event delete: not an event the engine accepts",
    "event remove: carries no row key, expected a row of rows",
    "event add: carries a row key, expected none",
    "event rename: carries no value, expected a value",
  ]);
});

// ---------------------------------------------------------------------------
// Real engines against their pages' contracts
// ---------------------------------------------------------------------------

const drive = async (contract: ViewContract, transport: { dispatch: (message: BrowserToEngineMessage) => Promise<EngineToBrowserMessage>; start: () => Promise<void> }, events: readonly SemanticEvent[]): Promise<readonly string[]> => {
  const problems: string[] = [];
  const checked = {
    start: () => transport.start(),
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "Event") problems.push(...checkEvent(message.event, contract));
      const response = await transport.dispatch(message);
      problems.push(...checkProjection(response.view, contract));
      return response;
    },
  };
  const host = createFakeHost({ transport: checked, outcomes: { http: () => ({ kind: "Success", status: 200, body: { available: true } }) } });
  await host.start();
  for (const event of events) await host.event(event.name, event.key, event.value);
  return problems;
};

test("the reference engine projects exactly index.view.json and accepts its events", async () => {
  assert.deepEqual(await drive(loadContract("index.view.json"), new DirectTypeScriptTransport(), [
    { kind: "Event", name: "emailChanged", value: "ada@example.com" },
    { kind: "Event", name: "checkAvailability" },
  ]), []);
});

test("the shipped minimal counter projects exactly examples/minimal/index.view.json", async () => {
  const transport = (createMinimalCounter as () => { dispatch: (message: BrowserToEngineMessage) => Promise<EngineToBrowserMessage>; start: () => Promise<void> })();
  assert.deepEqual(await drive(loadContract("examples/minimal/index.view.json"), transport, [
    { kind: "Event", name: "increment" }, { kind: "Event", name: "increment" }, { kind: "Event", name: "reset" },
  ]), []);
});

type SessionStep = { readonly send: BrowserToEngineMessage; readonly expect: EngineToBrowserMessage };

test("the F#, C# and Rust minimal engines are held to the guest host's contract through the shared session", async () => {
  // Each guest's session runner asserts its responses equal these expected
  // messages step for step, so checking the expectations checks all three.
  const contract = loadContract("guests/minimal/host/index.view.json");
  const text = (await readFile("conformance/sessions/minimal.session.json", "utf8")).replaceAll("{{core.fingerprint}}", CORE_CONTRACT_IDENTITY.fingerprint);
  const sessions = (JSON.parse(text) as { sessions: readonly { name: string; steps: readonly SessionStep[] }[] }).sessions;
  const steps = sessions.flatMap((session) => session.steps.map((step, index) => ({ at: `${session.name}#${index}`, step })));
  // The session deliberately sends events no page can send ("teleport",
  // "noise-N") to prove unknown input changes nothing but the log; those are
  // the only events allowed outside the contract.
  const deliberatelyUnknown = /^(teleport|noise-\d+)$/;
  const problems = steps.flatMap(({ at, step }) => [
    ...(step.send.kind === "Event" && !deliberatelyUnknown.test(step.send.event.name) ? checkEvent(step.send.event, contract) : []),
    ...checkProjection(step.expect.view, contract),
  ].map((problem) => `${at}: ${problem}`));
  assert.ok(steps.length >= 60, "the session is the full shared session");
  assert.ok(steps.filter(({ step }) => step.send.kind === "Event" && !deliberatelyUnknown.test(step.send.event.name)).length >= 7, "every declared event is exercised");
  assert.deepEqual(problems, []);
  const html = await readFile("guests/minimal/host/index.html", "utf8");
  assert.deepEqual(checkPage("guests/minimal/host/index.html", html, contract), []);
});
