// The fatal fallback host in Chromium: an engine that throws on "crash" (a
// runtime fault, not a domain error), the host covering the page, a trusted
// click on the covered page doing nothing, and a real click on "Try again"
// restoring the page with a fresh engine.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { startWithFallback } from "../../../../dist/hosts/fallback.js";

const engines = [];
const makeEngine = () => {
  const engine = { count: 0, heard: [] };
  engine.transport = {
    start: async () => {},
    dispatch: async (message) => {
      const name = message.kind === "Event" ? message.event.name : message.kind;
      engine.heard.push(name);
      if (name === "crash") throw new TypeError("engine invariant broken for order 42 (secret)");
      if (name === "add") engine.count += 1;
      return { view: { title: "Orders", count: String(engine.count) }, effects: [], cancellations: [] };
    },
  };
  engines.push(engine);
  return engine;
};

const healths = [];
const trusted = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

const host = await startWithFallback({
  document,
  connect: (guard) => new BrowserKernel(guard(makeEngine().transport), document),
  onHealth: (health) => healths.push(health),
});
expect("the engine starts and the host reports it available", host.health().kind === "available" && document.getElementById("title").textContent === "Orders", host.health());

await trusted({ kind: "click", selector: "#add" });
await sleep(50);
expect("the application works normally", document.getElementById("count").textContent === "1", document.getElementById("count").textContent);

await trusted({ kind: "click", selector: "#crash" });
await sleep(100);
const surface = document.querySelector("[data-limen-fallback]");
expect("an engine that throws while handling an event is covered by the fallback surface, with a redacted id", host.health().kind === "unavailable" && host.health().id === "LIMEN-DISPATCH-TypeError" && surface !== null && surface.getAttribute("role") === "alert" && !surface.textContent.includes("secret") && surface.textContent.includes("LIMEN-DISPATCH-TypeError"), { health: host.health(), text: surface?.textContent });
expect("the last good view is preserved under the surface, and focus moves to the surface", document.getElementById("count").textContent === "1" && surface.contains(document.activeElement), { count: document.getElementById("count").textContent, active: document.activeElement?.className });

const before = engines[0].heard.length;
const heardClick = { value: false };
document.getElementById("add").addEventListener("click", () => { heardClick.value = true; });
await trusted({ kind: "click", selector: "#add", force: true });
await sleep(50);
expect("a real mouse click on the covered, inert page reaches nothing: not the element, not the engine", !heardClick.value && window.__limenPackActionError === null && engines[0].heard.length === before && document.getElementById("count").textContent === "1", { heard: engines[0].heard, clicked: heardClick.value, error: window.__limenPackActionError });

await trusted({ kind: "click", selector: ".limen-fallback-restart" });
await sleep(100);
expect("a real click on Try again restores the page and starts a fresh engine", host.health().kind === "available" && host.health().attempt === 2 && engines.length === 2 && document.querySelector("[data-limen-fallback]") === null && document.getElementById("count").textContent === "0", { health: host.health(), engines: engines.length });

await trusted({ kind: "click", selector: "#add" });
await sleep(50);
expect("the restarted application works, on the new engine only", document.getElementById("count").textContent === "1" && engines[1].heard.join() === "Initialize,add" && engines[0].heard.at(-1) === "crash", { first: engines[0].heard, second: engines[1].heard });

expect("health moved through starting, available, unavailable, starting, available", healths.map((health) => health.kind).join() === "starting,available,unavailable,starting,available", healths);
window.__limenPackResult = { pack: "core-fallback", checks };
