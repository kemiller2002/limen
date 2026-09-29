// The Core HTTP profile (protocol 1.3) in Chromium: real fetch, real bytes,
// real response headers, real cookies. The engine is a scripted stand-in
// that sends one Http effect per click and collects the outcome.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const state = { queued: null, waiting: null, sequence: 0, diagnostics: [] };
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") {
      return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [] } };
    }
    if (message.kind === "EffectResult") {
      const resolve = state.waiting;
      state.waiting = null;
      resolve?.(message.result.outcome);
      return { view: {}, effects: [], cancellations: [] };
    }
    const request = state.queued;
    state.queued = null;
    if (request === null) return { view: {}, effects: [], cancellations: [] };
    state.sequence += 1;
    return { view: {}, effects: [{ kind: "Http", correlationId: "http-" + state.sequence, timeoutMs: 5000, method: "GET", ...request }], cancellations: [] };
  },
};
const http = (request) => new Promise((resolve) => {
  state.queued = request;
  state.waiting = resolve;
  document.getElementById("poke").click();
});

const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, { report: (event) => state.diagnostics.push(JSON.stringify(event)) }, { requireHandshake: true }).start();

const json = await http({ url: "/__limen/http/json" });
expect("JSON, the default, is unchanged: the decoded body and no headers unless asked", json.kind === "Success" && json.body.ok === true && !("headers" in json), json);

const withHeaders = await http({ url: "/__limen/http/json", responseHeaders: ["ETag", "X-Request-Id", "Set-Cookie"] });
expect("named response headers come back by lower-case name; a forbidden one (Set-Cookie) never does", withHeaders.kind === "Success" && withHeaders.headers.etag === "\"v7\"" && withHeaders.headers["x-request-id"] === "req-42" && !("set-cookie" in withHeaders.headers), withHeaders);

const text = await http({ url: "/__limen/http/text", response: "text" });
expect("a text response is a string, decoded as UTF-8", text.kind === "Success" && text.body === "name,total\nÉlan,3\n", text);

const bytes = await http({ url: "/__limen/http/bytes", response: "base64" });
const decoded = bytes.kind === "Success" ? Array.from(atob(bytes.body), (character) => character.charCodeAt(0)) : [];
expect("a binary response arrives as its exact bytes", decoded.length === 256 && decoded.every((byte, index) => byte === index), { length: decoded.length });

const head = await http({ url: "/__limen/http/empty", method: "HEAD", response: "none", responseHeaders: ["X-Count"] });
const noContent = await http({ url: "/__limen/http/empty", method: "DELETE", response: "none" });
const noContentAsJson = await http({ url: "/__limen/http/empty", method: "DELETE" });
expect("HEAD and 204 with response none succeed with a null body; read as JSON, a 204 is still invalid-response", head.kind === "Success" && head.body === null && head.headers["x-count"] === "12" && noContent.kind === "Success" && noContent.status === 204 && noContentAsJson.kind === "Failure" && noContentAsJson.reason === "invalid-response", { head, noContent, noContentAsJson });

const huge = await http({ url: "/__limen/http/huge", response: "text" });
expect("a text body over 8 MiB is Failure too-large, with the status", huge.kind === "Failure" && huge.reason === "too-large" && huge.status === 200, huge);

// --- Credentials and XSRF ----------------------------------------------------
await http({ url: "/__limen/http/login" });
const sameOrigin = await http({ url: "/__limen/http/whoami" });
const omitted = await http({ url: "/__limen/http/whoami", credentials: "omit" });
const explicit = await http({ url: "/__limen/http/whoami", credentials: "same-origin" });
expect("credentials: the default and same-origin send the session cookie; omit does not", sameOrigin.body.session === true && explicit.body.session === true && omitted.body.session === false, { sameOrigin, omitted, explicit });

const noXsrf = await http({ url: "/__limen/http/whoami", method: "POST", body: "{}" });
const withXsrf = await http({ url: "/__limen/http/whoami", method: "POST", body: "{}", xsrf: { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" } });
expect("the XSRF binding copies the cookie into the header, and only when asked; the token never reaches the engine", noXsrf.body.xsrfSent === false && withXsrf.body.xsrfMatches === true && !JSON.stringify(withXsrf).includes("tok-789"), { noXsrf, withXsrf });

// --- OutcomeUnknown ------------------------------------------------------------
const slow = await http({ url: "/__limen/http/slow", method: "POST", body: "{}", timeoutMs: 100, response: "text" });
expect("a timeout after dispatch is OutcomeUnknown, never a confident failure", slow.kind === "OutcomeUnknown" && slow.reason === "timeout-after-dispatch", slow);

// A write whose connection drops after the server has it (protocol 1.4).
// Chromium resends a reset POST once before fetch rejects, so the server may
// have it twice: calling that a retryable Failure would invite a third.
const lost = await http({ url: "/__limen/http/reset", method: "POST", body: "{\"pay\":10}" });
const receivedAfterPost = (await http({ url: "/__limen/http/reset-count" })).body.received;
expect("a POST whose connection drops after the server received it is OutcomeUnknown{connection-lost}, never Failure{network}", lost.kind === "OutcomeUnknown" && lost.reason === "connection-lost" && receivedAfterPost >= 1, { lost, receivedAfterPost });
const lostRead = await http({ url: "/__limen/http/reset" });
expect("a GET whose connection drops is still Failure{network}: reading again changes nothing", lostRead.kind === "Failure" && lostRead.reason === "network", lostRead);

expect("no diagnostic carries a cookie, a token or a header value", !state.diagnostics.some((line) => /tok-789|abc|req-42|v7/.test(line)), state.diagnostics);
window.__limenPackResult = { pack: "core-http", checks };
