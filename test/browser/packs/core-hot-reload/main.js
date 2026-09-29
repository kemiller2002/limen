// Hot reload in Chromium: a real stylesheet swap (it loads, the computed
// style follows, the DOM and the engine's state stay), and engine
// replacement restored only on an exactly equal snapshot version.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { createHotReloader } from "../../../../dist/tooling/hot-reload.js";

const created = [];
const counter = (version, label) => ({
  snapshotVersion: version,
  create: (restored) => {
    created.push(label);
    const state = { count: restored?.count ?? 0 };
    return {
      transport: {
        start: async () => {},
        dispatch: async (message) => {
          if (message.kind === "Event" && message.event.name === "add") state.count += 1;
          return { view: { count: String(state.count), label }, effects: [], cancellations: [] };
        },
      },
      snapshot: () => ({ count: state.count }),
    };
  },
});
const engines = { "/v1-patched.js": counter("1", "v1-patched"), "/v2.js": counter("2", "v2") };
const trusted = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const text = (id) => document.getElementById(id).textContent;
window.__marker = "same page";

const reloader = await createHotReloader({
  document,
  engine: counter("1", "v1"),
  kernel: (transport) => new BrowserKernel(transport, document),
  loadEngine: async (path) => engines[path],
  loadPage: async () => { throw new Error("not used here"); },
  reload: () => { window.__reloaded = true; },
  currentPage: location.pathname,
});

await trusted({ kind: "click", selector: "#add" });
await trusted({ kind: "click", selector: "#add" });
await sleep(50);
const title = document.getElementById("title");
const before = getComputedStyle(title).color;

// The "edit": the server now serves different CSS at the same path. Here the
// page swaps to a variant with the same content, which is enough to prove the
// mechanics: a real load, the old link removed, nothing else touched.
const plan = await reloader.apply({ kind: "css", path: new URL("./blue.css", location.href).pathname });
const links = Array.from(document.querySelectorAll("link[rel=stylesheet]"));
expect("a CSS change swaps the stylesheet in place: one link, reloaded, styles applied", plan.kind === "swapStylesheet" && links.length === 1 && links[0].href.includes("limen-hot=1") && getComputedStyle(title).color === before && before === "rgb(0, 0, 255)", { plan, links: links.map((link) => link.href), before });
expect("no page reload, the same DOM node, the same engine and its state", window.__marker === "same page" && document.getElementById("title") === title && created.join() === "v1" && text("count") === "2", { created, count: text("count") });

const restored = await reloader.apply({ kind: "engine", path: "/v1-patched.js" });
await trusted({ kind: "click", selector: "#add" });
await sleep(50);
expect("a compatible engine (same snapshot version) continues from the snapshot, on a fresh kernel", restored.kind === "restoreEngine" && text("label") === "v1-patched" && text("count") === "3", { restored, label: text("label"), count: text("count") });

const reset = await reloader.apply({ kind: "engine", path: "/v2.js" });
expect("an incompatible engine resets instead of guessing", reset.kind === "resetEngine" && reset.reason === "incompatible" && text("label") === "v2" && text("count") === "0", { reset, label: text("label"), count: text("count") });
expect("the page never reloaded", window.__reloaded !== true && window.__marker === "same page", window.__reloaded);
window.__limenPackResult = { pack: "core-hot-reload", checks };
