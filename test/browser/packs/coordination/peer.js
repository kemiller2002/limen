// A second tab of the same application, with its own engine: it says hello on
// both channels, answers pings, and competes to lead. What leading means is
// this engine's decision: announcing itself, and stepping down when it hears
// LockLost.
import { startEngine } from "./harness.js";

const state = { lock: null, context: null };
const engine = await startEngine((fact) => {
  if (fact.kind === "Received" && fact.message?.ping !== undefined) void engine.ask({ operation: "broadcast", channel: fact.channel, message: { pong: fact.message.ping, from: state.context } });
  if (fact.kind === "LockLost") { state.lock = null; void engine.ask({ operation: "broadcast", channel: "chat", message: { steppedDown: state.context } }).then(lead); }
});
const lead = async () => {
  const acquired = await engine.ask({ operation: "acquire", name: "leader", mode: "exclusive", wait: true, steal: false });
  if (acquired.kind !== "Acquired") return;
  state.lock = acquired.lock;
  await engine.ask({ operation: "broadcast", channel: "chat", message: { leader: state.context } });
};
state.context = (await engine.ask({ operation: "identity" })).context;
await engine.ask({ operation: "open", channel: "chat", via: "broadcast" });

await engine.ask({ operation: "open", channel: "chat-hub", via: "hub" });
await engine.ask({ operation: "broadcast", channel: "chat", message: { hello: state.context } });
await engine.ask({ operation: "broadcast", channel: "chat-hub", message: { hello: state.context } });
void lead();
