// The second tab. It opens the database at the version it is told, then
// answers the first tab's scenarios.
import { BIG, channel, open, store, transact } from "./shared.js";

const tab = store();
const port = channel();
const version = Number(new URLSearchParams(location.search).get("version") ?? "1");
const opened = await tab.ask(open(version));
port.send({ kind: "ready", opened });

const serve = async () => {
  const message = await port.next("race", "watch", "bigwrite");
  switch (message.kind) {
    case "race": {
      const result = await tab.ask(transact([{ op: "putIf", store: "records", value: { id: 1, rev: 2, by: "peer" }, expected: message.expected }]));
      port.send({ kind: "raced", result });
      break;
    }
    case "watch": {
      const seen = [];
      const stop = port.next("stop").then(() => true);
      const stopped = { done: false };
      void stop.then(() => { stopped.done = true; });
      while (!stopped.done) {
        const read = await tab.ask(transact([{ op: "count", store: "batch" }], "readonly"));
        seen.push(read.kind === "Committed" ? read.results[0].count : read.kind);
      }
      port.send({ kind: "watched", seen });
      break;
    }
    case "bigwrite": {
      const operations = Array.from({ length: BIG }, (_, id) => ({ op: "put", store: "big", value: { id, payload: "y".repeat(200) } }));
      const pending = tab.ask(transact(operations));
      port.send({ kind: "started" });
      await pending;
      port.send({ kind: "finished" });
      break;
    }
  }
  return serve();
};
void serve();
