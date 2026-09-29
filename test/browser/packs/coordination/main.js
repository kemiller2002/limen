// The coordination pack in Chromium (kemiller2002/limen#46): two real tabs
// exchanging over BroadcastChannel and over a real SharedWorker hub; leadership
// handed over by release, lost to a steal, and passed on when a tab closes;
// exact-origin frame messaging that accepts the partner and refuses the wrong
// origin and the wrong source.
import { startEngine } from "./harness.js";

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const act = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const { ask, facts, waitFor } = await startEngine();
const received = (predicate) => facts.find((fact) => fact.kind === "Received" && predicate(fact));

const me = (await ask({ operation: "identity" })).context;
await ask({ operation: "open", channel: "chat", via: "broadcast" });
const hub = await ask({ operation: "open", channel: "chat-hub", via: "hub" });
expect("a real SharedWorker hub opens through the host's Trusted Types policy", hub.kind === "Opened", hub);
const lead = await ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: true, steal: false });
expect("this tab acquires the leader lock first", lead.kind === "Acquired", lead);

// --- a second tab --------------------------------------------------------------
await act({ kind: "openPage", url: "test/browser/packs/coordination/peer.html" });
await waitFor(() => received((fact) => fact.channel === "chat" && fact.message?.hello !== undefined) && received((fact) => fact.channel === "chat-hub" && fact.message?.hello !== undefined));
const helloChat = received((fact) => fact.channel === "chat" && fact.message?.hello !== undefined);
const helloHub = received((fact) => fact.channel === "chat-hub" && fact.message?.hello !== undefined);
const peer = helloChat?.message.hello;
expect("two tabs exchange over BroadcastChannel and over the SharedWorker hub, each message tagged with its sender's identity",
  helloChat !== undefined && helloHub !== undefined && helloChat.from === peer && helloHub.from === peer && peer !== me, { helloChat, helloHub, me });
await ask({ operation: "broadcast", channel: "chat", message: { ping: 7 } });
await waitFor(() => received((fact) => fact.message?.pong === 7));
expect("a ping and its pong: validated JSON both ways, never echoed to the sender", received((fact) => fact.message?.pong === 7) !== undefined && !received((fact) => fact.message?.ping !== undefined), facts.filter((fact) => fact.kind === "Received"));

// --- leadership: handed over, lost, passed on ----------------------------------------
await ask({ operation: "release", lock: lead.lock });
await waitFor(() => received((fact) => fact.message?.leader === peer));
expect("released: the queued tab acquires and announces itself; what leading means is its engine's", received((fact) => fact.message?.leader === peer) !== undefined, null);
const stolen = await ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: false, steal: true });
await waitFor(() => received((fact) => fact.message?.steppedDown === peer));
expect("stolen: this tab takes the lock and the other hears LockLost and steps down", stolen.kind === "Acquired" && received((fact) => fact.message?.steppedDown === peer) !== undefined, stolen);
await ask({ operation: "release", lock: stolen.lock });
await waitFor(() => facts.filter((fact) => fact.kind === "Received" && fact.message?.leader === peer).length === 2);
const waiting = ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: true, steal: false });
await act({ kind: "closePage" });
const passedOn = await Promise.race([waiting, new Promise((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 5000))]);
expect("the leader's tab closes: its lock is released, and this tab's queued acquire completes", passedOn.kind === "Acquired", passedOn);
const busy = await ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: false, steal: false });
expect("held again: a contender that will not wait is Busy", busy.kind === "Busy", busy);

// --- a closed channel ------------------------------------------------------------------
await ask({ operation: "close", channel: "chat" });
const afterClose = await ask({ operation: "broadcast", channel: "chat", message: 1 });
expect("a closed channel is explicit: broadcasting on it is NotOpen", afterClose.kind === "NotOpen", afterClose);

// --- frames -------------------------------------------------------------------------------
const wildcard = await ask({ operation: "listen", target: { kind: "frame", name: "partner" }, origin: "*" });
const partner = await ask({ operation: "listen", target: { kind: "frame", name: "partner" }, origin: "http://localhost:4194" });
const misdeclared = await ask({ operation: "listen", target: { kind: "frame", name: "partner" }, origin: "http://127.0.0.1:4194" });
expect("a wildcard origin is refused before anything is sent", wildcard.kind === "InvalidOrigin", wildcard);
await ask({ operation: "post", peer: partner.peer, message: { hello: "partner" } });
await waitFor(() => facts.some((fact) => fact.kind === "PeerMessage" && fact.peer === partner.peer));
const echoed = facts.find((fact) => fact.kind === "PeerMessage" && fact.peer === partner.peer);
expect("the partner frame at its exact origin receives the message and its echo is accepted", echoed?.message?.echo?.hello === "partner", echoed);
const wrongOrigin = facts.find((fact) => fact.kind === "PeerRefused" && fact.peer === misdeclared.peer && fact.reason === "wrong-origin");
expect("the same frame's echo, for a peer declared at another origin, is refused as wrong-origin", wrongOrigin?.origin === "http://localhost:4194" && !facts.some((fact) => fact.kind === "PeerMessage" && fact.peer === misdeclared.peer), wrongOrigin);
// The test harness nudges the intruder directly; no engine asks it anything.
document.querySelector("[data-frame-target=intruder]").contentWindow.postMessage("speak", location.origin);
await waitFor(() => facts.some((fact) => fact.kind === "PeerRefused" && fact.reason === "wrong-source"));
const wrongSource = facts.find((fact) => fact.kind === "PeerRefused" && fact.reason === "wrong-source");
expect("an intruder frame at the declared origin but not the declared frame is refused as wrong-source; the correctly declared peer never hears it",
  wrongSource?.peer === misdeclared.peer && wrongSource.origin === location.origin && !facts.some((fact) => fact.kind === "PeerMessage" && fact.message?.from === "intruder"), wrongSource);
expect("every fact decoded", !facts.some((fact) => fact.kind === "Undecodable"), null);

window.__limenPackResult = { pack: "coordination", checks };
