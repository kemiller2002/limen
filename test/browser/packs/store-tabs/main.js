// Two real tabs of one application on one origin (LCP-051, LCP-057,
// LCP-058, LCP-077). This tab opens peer.html in a second tab through the
// runner's openPage action, and the tabs talk over a BroadcastChannel.
// Each scenario asserts the stored state afterwards, not only the answers.
import { BATCH, BIG, channel, open, store, transact } from "./shared.js";

const tab = store();
const port = channel();
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const trusted = (action) => new Promise((resolve) => {
  window.__limenPackActionDone = resolve;
  window.__limenPackAction = action;
});
const count = async (name) => (await tab.ask(transact([{ op: "count", store: name }], "readonly"))).results?.[0]?.count;
const openPeer = async (version) => {
  const ready = port.next("ready");
  await trusted({ kind: "openPage", url: `test/browser/packs/store-tabs/peer.html?version=${version}` });
  return (await ready).opened;
};

await tab.ask({ operation: "deleteDatabase", database: "db" });
const opened = await tab.ask(open(1));
await tab.ask(transact([{ op: "put", store: "records", value: { id: 1, rev: 1 } }]));
const peerOpened = await openPeer(1);
expect("two real tabs open the same database", opened.kind === "Opened" && peerOpened.kind === "Opened", { opened, peerOpened });

// LCP-058: both tabs compare-and-put the same record from the same read.
const expected = { id: 1, rev: 1 };
const peerRace = port.next("raced");
port.send({ kind: "race", expected });
const mine = await tab.ask(transact([{ op: "putIf", store: "records", value: { id: 1, rev: 2, by: "main" }, expected }]));
const theirs = (await peerRace).result;
const winners = [mine, theirs].filter((result) => result.kind === "Committed");
const loser = [mine, theirs].find((result) => result.kind === "Aborted");
const stored = (await tab.ask(transact([{ op: "get", store: "records", key: 1 }], "readonly"))).results?.[0]?.value;
expect("LCP-058: two tabs putIf the same record from the same read: exactly one commits, the other aborts as conflict reporting the winner's value, and the winner's value is stored", winners.length === 1 && loser?.reason === "conflict" && loser?.current?.by === stored?.by && stored?.rev === 2, { mine, theirs, stored });

// LCP-051: a reader in the other tab sees a committed batch entirely or not at all.
const watched = port.next("watched");
port.send({ kind: "watch" });
await new Promise((resolve) => setTimeout(resolve, 30));
const batch = await tab.ask(transact(Array.from({ length: BATCH }, (_, id) => ({ op: "put", store: "batch", value: { id } }))));
await new Promise((resolve) => setTimeout(resolve, 60));
port.send({ kind: "stop" });
const seen = (await watched).seen;
expect(`LCP-051: a readonly reader in another tab sees a ${BATCH}-record batch entirely before or after its commit, never part of it`, batch.kind === "Committed" && seen.length > 0 && seen.every((value) => value === 0 || value === BATCH) && seen.at(-1) === BATCH && (await count("batch")) === BATCH, { batch: batch.kind, observations: seen.length, distinct: [...new Set(seen)] });

// LCP-051, LCP-077: the other tab closes while its transaction runs.
const started = port.next("started");
port.send({ kind: "bigwrite" });
await started;
await trusted({ kind: "closePage" });
await new Promise((resolve) => setTimeout(resolve, 300));
const afterClose = await count("big");
expect(`LCP-051: a tab closed between transact and its answer leaves all ${BIG} records or none`, afterClose === 0 || afterClose === BIG, { afterClose });

// LCP-057: a newer tab's upgrade; this older tab is told, and its next write is never sent.
const upgraded = await openPeer(2);
await new Promise((resolve) => setTimeout(resolve, 100));
const changed = tab.facts.find((fact) => fact.kind === "VersionChanged");
const refused = await tab.ask(transact([{ op: "put", store: "records", value: { id: 9 } }]));
expect("LCP-057: a newer tab's upgrade completes; the older tab hears VersionChanged and its next write is NotOpen", upgraded.kind === "Opened" && upgraded.version === 2 && changed?.newVersion === 2 && refused.kind === "NotOpen", { upgraded, changed, refused });
await trusted({ kind: "closePage" });

const reopened = await tab.ask(open(2));
const nine = (await tab.ask(transact([{ op: "get", store: "records", key: 9 }], "readonly"))).results?.[0];
expect("the refused write was never applied", reopened.kind === "Opened" && nine?.kind === "Missing", { reopened, nine });
await tab.ask({ operation: "close", database: "db" });
await tab.ask({ operation: "deleteDatabase", database: "db" });
// What this run measured, for the record (docs/41): how often the other tab
// read during the batch, and whether the closed tab's transaction had
// committed before the close.
checks.push({ name: `measured: the reader saw ${[...new Set(seen)].join(" and ")} across ${String(seen.length)} reads; the closed tab left ${String(afterClose)} of ${String(BIG)} records`, ok: true, detail: "" });
window.__limenPackResult = { pack: "limen.store (two real tabs)", checks };
