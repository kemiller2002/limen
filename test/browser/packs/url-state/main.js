// Real-browser proof that a Limen application keeps its navigable state in the
// URL (LCP-097, LCP-103, LCP-104, LCP-106), in Chromium and WebKit.
//
// scripts/smoke-packs.ts serves this page under a sub-path
// (/test/browser/packs/url-state/) from a static server that answers 404 for
// any path it has no file for, as GitHub Pages does, and opens it with a deep
// link in the fragment. Everything the page then checks is what a person does:
// reload, press Back and Forward, follow a link, open a link as a fresh page,
// copy a link, sign in. Fresh page loads are same-origin iframes (a new
// document each), so their views can be read. The runner performs the reload
// and the trusted clicks; checks made before the reload travel in
// sessionStorage, which is test bookkeeping, not application state.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { createUrlStateEngine } from "./engine.js";

await new BrowserKernel(createUrlStateEngine(), document).start();

// A framed copy is one of the fresh page loads below: it only renders.
if (window.parent === window) await drive();

async function drive() {
  const KEY = "limen-url-state";
  const saved = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
  const checks = saved?.checks ?? [];
  const expect = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: JSON.stringify(detail) });
  const trusted = (action) => new Promise((resolve) => {
    window.__limenPackActionDone = resolve;
    window.__limenPackAction = action;
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const read = (doc = document) => ({
    route: doc.getElementById("route")?.textContent ?? "",
    detail: doc.getElementById("detail")?.textContent ?? "",
    location: doc.getElementById("location")?.textContent ?? "",
  });
  const until = async (predicate, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await sleep(25);
    }
    return predicate();
  };
  const view = () => ({ ...read(), hash: location.hash, length: history.length });
  const settle = async (predicate) => { await until(predicate); await sleep(50); return view(); };

  // A fresh page load of `url`, as a new tab or a pasted link would be: a new
  // document, its own kernel and engine.
  const fresh = async (url) => {
    const frame = document.createElement("iframe");
    frame.src = url;
    document.body.append(frame);
    const loaded = await until(() => (frame.contentDocument?.getElementById("route")?.textContent ?? "") !== "", 8000);
    const result = loaded ? { ...read(frame.contentDocument), hash: frame.contentWindow.location.hash } : null;
    frame.remove();
    return result;
  };
  const deep = { status: ["open", "paid"] };
  const invoice42 = (tab) => JSON.stringify({ params: { id: 42 }, query: { status: deep.status, tab } });

  if (saved === null) {
    // --- 1. A deep link opens its view, corrected to the canonical form in place.
    const opened = await settle(() => read().route === "invoices.invoice");
    expect("a deep link with an identifier and view parameters opens that view directly",
      opened.route === "invoices.invoice" && opened.detail === invoice42("history"), opened);
    expect("adopting the deep link replaces it with its canonical form (sorted set, declaration order), with no new history entry",
      opened.hash === "#/invoices/42?status=open,paid&tab=history", opened);
    sessionStorage.setItem(KEY, JSON.stringify({ checks, length: history.length }));
    await trusted({ kind: "reload" });
    return;
  }

  sessionStorage.removeItem(KEY);
  // --- 2. A reload restores the view from the URL alone.
  const reloaded = await settle(() => read().route === "invoices.invoice");
  expect("a reload of the deep link restores the same view from the URL alone, and the host serves the page (no 404)",
    reloaded.detail === invoice42("history") && reloaded.hash === "#/invoices/42?status=open,paid&tab=history" && reloaded.length === saved.length, { reloaded, before: saved.length });

  // --- 3. refine replaces: no history entry.
  document.getElementById("show-lines").click();
  const refined = await settle(() => read().detail === invoice42("lines"));
  expect("refine (an in-place tab change) replaces the URL and adds no history entry",
    refined.hash === "#/invoices/42?status=open,paid&tab=lines" && refined.length === reloaded.length, { refined, before: reloaded.length });

  // --- 4. navigate pushes; Back and Forward step between places.
  document.getElementById("show-list").click();
  const listed = await settle(() => read().route === "invoices.list");
  expect("navigate (another place) pushes one history entry", listed.hash === "#/invoices?status=open,paid" && listed.length === refined.length + 1, { listed, before: refined.length });
  history.back();
  const back = await settle(() => read().route === "invoices.invoice");
  expect("Back returns to the previous place, restored from its URL, including the refined tab",
    back.detail === invoice42("lines") && back.hash === "#/invoices/42?status=open,paid&tab=lines" && back.length === listed.length, back);
  history.forward();
  const forward = await settle(() => read().route === "invoices.list");
  expect("Forward returns to the list, and neither move added an entry", forward.hash === "#/invoices?status=open,paid" && forward.length === listed.length, forward);

  // --- 5. A real relative link: the browser moves, the engine adopts.
  const link = document.getElementById("invoice-7");
  expect("an in-app link is a real relative href", link.getAttribute("href") === "#/invoices/7", link.getAttribute("href"));
  await trusted({ kind: "click", selector: "#invoice-7" });
  const followed = await settle(() => read().route === "invoices.invoice" && read().detail.includes("\"id\":7"));
  expect("clicking the link is a navigation: one new entry, the view of the link, and the engine adds nothing",
    followed.hash === "#/invoices/7" && followed.length === forward.length + 1 && followed.location === "/invoices/7", { followed, before: forward.length });

  // --- 6. Sign-in keeps the deep link, and Back does not return to sign-in.
  const beforeSignIn = history.length;
  location.hash = "#/reports/2026-10?tags=b,a";
  const signIn = await settle(() => read().route === "signIn");
  expect("a deep link to a signed-in route goes to sign-in, carrying the canonical target as returnTo",
    signIn.hash === "#/sign-in?returnTo=%2Freports%2F2026-10%3Ftags%3Da%2Cb" && signIn.length === beforeSignIn + 1, { signIn, before: beforeSignIn });
  document.getElementById("sign-in").click();
  const resumed = await settle(() => read().route === "reports");
  expect("after sign-in the original view is restored by a replace, with no new entry",
    resumed.hash === "#/reports/2026-10?tags=a,b" && resumed.length === signIn.length && resumed.detail === JSON.stringify({ params: { period: { month: "2026-10" } }, query: { tags: ["a", "b"] } }), resumed);
  history.back();
  const afterBack = await settle(() => read().route === "invoices.invoice");
  expect("Back from the restored view skips sign-in and returns to the previous place", afterBack.hash === "#/invoices/7", afterBack);

  // --- 7. Copy link: the absolute canonical URL, and the typed outcome.
  await trusted({ kind: "click", selector: "#copy-link" });
  await until(() => !["", "copying"].includes(document.getElementById("copy-status").textContent ?? ""));
  const status = document.getElementById("copy-status").textContent;
  const shared = document.getElementById("shared-link").textContent;
  const page = `${location.origin}${location.pathname}${location.search}`;
  expect("copy link composes the absolute URL from the page's origin, its sub-path and the canonical fragment",
    shared === `${page}#/invoices/7` && location.pathname === "/test/browser/packs/url-state/index.html", { shared, page });
  expect("the clipboard outcome is rendered as a typed value (copied, or the reason it was not)", status === "copied" || /^failed: (denied|unavailable|unknown)$/.test(status), status);

  // --- 8. Fresh page loads: a shared link and a link opened in a new tab.
  const sharedView = await fresh(shared);
  expect("the copied link, opened as a fresh page, shows the same view", sharedView?.route === "invoices.invoice" && sharedView.detail.includes("\"id\":7"), sharedView);
  const tab = await fresh(link.href);
  expect("the link's href, opened as a fresh page (a new tab), shows the same view as the click", tab?.route === "invoices.invoice" && tab.detail === afterBack.detail, { tab, clicked: afterBack.detail });

  // --- 9. Outcomes from deep links: each its own view, the URL kept.
  const notFound = await fresh(`${page}#/nowhere/at/all`);
  expect("a deep link to no route renders NotFound and keeps its URL", notFound?.route === "NotFound" && notFound.hash === "#/nowhere/at/all", notFound);
  const denied = await fresh(`${page}#/admin`);
  expect("a deep link the guard refuses renders NotPermitted, distinct from NotFound, and keeps its URL", denied?.route === "NotPermitted" && denied.detail === "admin" && denied.hash === "#/admin", denied);
  const invalid = await fresh(`${page}#/invoices/abc`);
  expect("a malformed identifier renders Invalid, naming the parameter", invalid?.route === "Invalid" && invalid.detail === "id", invalid);
  const malformed = await fresh(`${page}#/%zz`);
  expect("a malformed escape renders Malformed (path), never a blank page", malformed?.route === "Malformed" && malformed.detail === "path", malformed);
  const gated = await fresh(`${page}#/reports/2026-10`);
  expect("a fresh deep link to a signed-in route lands on sign-in with its return target",
    gated?.route === "signIn" && gated.hash === "#/sign-in?returnTo=%2Freports%2F2026-10", gated);

  // --- 10. The host is GitHub-Pages-like: a path deep link would 404.
  const pathLink = await fetch(new URL("./invoices/42", location.href)).then((response) => response.status, () => -1);
  const index = await fetch(new URL("./index.html", location.href)).then((response) => response.status, () => -1);
  expect("the static host answers 404 for a path deep link and 200 for the page, which is why the route lives in the fragment", pathLink === 404 && index === 200, { pathLink, index });

  window.__limenPackResult = { pack: "URL state (@echelon-foundry/limen/routing, hash mode)", checks };
}
