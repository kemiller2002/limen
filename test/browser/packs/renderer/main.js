// The server renderer's output in Chromium (kemiller2002/limen#38): index.html
// here is renderRoute's static output for "/" (kept current by
// test/renderer.test.ts). This script imports nothing from Limen and starts no
// kernel: it reads what the browser parsed from the markup alone — what a
// reader, a crawler or a page with JavaScript disabled gets.
const checks = [];
const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail: String(detail) });
const text = (element) => (element?.textContent ?? "").replace(/\s+/g, " ").trim();

check("the head metadata is the route's, from the markup alone", document.title === "Catalogue"
  && document.querySelector("meta[name=description]")?.getAttribute("content") === "Everything we sell."
  && document.querySelector("meta[name=robots]")?.getAttribute("content") === "index"
  && document.querySelector("link[rel=canonical]")?.getAttribute("href") === "http://shop.test/", document.head.outerHTML.slice(0, 400));
const rows = Array.from(document.querySelectorAll("#items li"), text);
check("the data route's rows are in the page, in order, with their links", JSON.stringify(rows) === JSON.stringify(["Kettle £24.50", "Teapot £18.00", "Cups & saucers £12.25"])
  && JSON.stringify(Array.from(document.querySelectorAll("#items a"), (link) => link.getAttribute("href"))) === JSON.stringify(["/items/kettle", "/items/teapot", "/items/cups"]), JSON.stringify(rows));
check("rendered sections carry hydration markers; keyed rows carry their keys", document.querySelector("#items")?.getAttribute("data-limen-if") === "showList"
  && JSON.stringify(Array.from(document.querySelectorAll("[data-limen-key]"), (row) => row.getAttribute("data-limen-key"))) === JSON.stringify(["kettle", "teapot", "cups"]));
check("the client-only section shows its authored fallback", text(document.querySelector("#stock")) === "Live stock levels appear once the page is running.");
check("templates stay inert: the unrendered detail section is not in the page", document.querySelector("#detail") === null);
check("the heading and status are the projection's", text(document.querySelector("h1")) === "Catalogue" && text(document.querySelector("#status")) === "");

window.__limenPackResult = { pack: "renderer", checks };
