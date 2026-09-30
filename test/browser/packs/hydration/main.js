// Adopting server-rendered markup in Chromium (CA-0002, kemiller2002/limen#39).
// index.html is renderRoute's output for "/" (the same file as the renderer
// page, kept current by test/renderer.test.ts). A reader has already focused a
// link when the kernel starts; the kernel's first projection must adopt the
// rendered list, not rebuild it beside itself.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
const text = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

// The projection the server rendered: an engine that starts from the data the
// page was rendered with. "refresh" lowers the teapot's price.
const item = (id, name, price) => ({ id, name, href: `/items/${id}`, price });
const view = (teapot) => ({
  title: "Catalogue", description: "Everything we sell.", robots: "index", canonical: "http://shop.test/",
  heading: "Catalogue", status: "", showList: true,
  items: [item("kettle", "Kettle", "£24.50"), item("teapot", "Teapot", teapot), item("cups", "Cups & saucers", "£12.25")],
  showDetail: false, detailName: "", detailText: "", recent: "No recently viewed items.",
});
const engine = {
  start: async () => {},
  dispatch: async (message) => message.kind === "Initialize"
    ? { view: view("£18.00"), effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [] } }
    : { view: view("£15.00"), effects: [], cancellations: [] },
};

const list = document.querySelector("#items");
const rows = Array.from(document.querySelectorAll("#items li"));
const focused = document.querySelector('#items a[href="/items/teapot"]');
focused.focus();
const records = [];
const observer = new MutationObserver((batch) => { records.push(...batch); });
observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
const hydration = [];
const diagnostics = { report: (event) => { if (event.kind === "Hydration") hydration.push(event); else if (event.kind === "BridgeError") hydration.push(event); } };

await new BrowserKernel(engine, document, diagnostics, { requireHandshake: true }).start();
await new Promise((resolve) => setTimeout(resolve, 0));
observer.disconnect();

check("the rendered list is the mounted list: one list, the same node", document.querySelectorAll("#items").length === 1 && document.querySelector("#items") === list);
check("every rendered row is its keyed instance, in order", JSON.stringify(Array.from(document.querySelectorAll("#items li"), text)) === JSON.stringify(["Kettle £24.50", "Teapot £18.00", "Cups & saucers £12.25"])
  && Array.from(document.querySelectorAll("#items li")).every((row, index) => row === rows[index]), Array.from(document.querySelectorAll("#items li"), text).join(" | "));
check("focus survives the kernel starting", document.activeElement === focused, document.activeElement?.outerHTML ?? "none");
const added = records.flatMap((record) => Array.from(record.addedNodes)).filter((node) => node.nodeType === Node.ELEMENT_NODE);
const removed = records.flatMap((record) => Array.from(record.removedNodes)).filter((node) => node.nodeName !== "TEMPLATE");
const attributes = [...new Set(records.filter((record) => record.type === "attributes").map((record) => record.attributeName))].sort();
check("starting wrote nothing but the removal of the markers", added.length === 0 && removed.length === 0 && records.every((record) => record.type !== "characterData")
  && JSON.stringify(attributes) === JSON.stringify(["data-limen-if", "data-limen-key"]), `added ${added.length}, removed ${removed.length}, attributes ${attributes.join(",")}`);
check("each adoption is reported once, deterministically", JSON.stringify(hydration) === JSON.stringify([
  { kind: "Hydration", binding: "if:showList", adopted: 1, discarded: [] },
  { kind: "Hydration", binding: "each:items", adopted: 3, discarded: [] },
]), JSON.stringify(hydration));

document.querySelector('[data-event="refresh"]').click();
await new Promise((resolve) => setTimeout(resolve, 0));
check("an adopted row is live: the next projection updates it in place", text(rows[1]) === "Teapot £15.00" && document.querySelectorAll("#items li")[1] === rows[1], text(rows[1]));

window.__limenPackResult = { pack: "hydration", checks };
