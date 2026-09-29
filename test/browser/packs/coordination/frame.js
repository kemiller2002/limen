// A framed third party. It answers only its parent, at the exact origin it was
// told, and never with a wildcard. The intruder variant speaks up whenever the
// test harness nudges it.
const query = new URLSearchParams(location.search);
const parentOrigin = query.get("parent");
const intruder = query.has("intruder");
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  if (intruder) { window.parent.postMessage({ from: "intruder", said: event.data }, parentOrigin); return; }
  if (event.origin !== parentOrigin) return;
  window.parent.postMessage({ from: "partner", echo: event.data }, parentOrigin);
});
