// The Core HTTP profile, protocol 1.3 (kemiller2002/limen#47, LCP-041):
// response representations beyond JSON, response headers on request,
// explicit credentials, HEAD/OPTIONS and the same-origin XSRF binding — with
// the JSON path unchanged, OutcomeUnknown intact, and nothing secret in
// diagnostics. Real fetch, real cookies and real bytes are proven in
// Chromium (test/browser/packs/core-http/).

import assert from "node:assert/strict";
import test from "node:test";
import { BrowserKernel } from "../dist/kernel/browser-kernel.js";
import { MAX_HTTP_TEXT_BYTES, PROTOCOL_MINOR, type BrowserToEngineMessage, type CorrelationId, type EffectOutcome, type EngineTransport, type HttpEffectRequest } from "../dist/protocol.js";
import { withDom, withFetch } from "./dom-helpers.ts";

type Request = Omit<HttpEffectRequest, "kind" | "correlationId">;
type Seen = { readonly url: string; readonly init: RequestInit | undefined };
type Run = { readonly outcome: EffectOutcome | undefined; readonly seen: readonly Seen[]; readonly diagnostics: readonly string[] };

// One Http effect through the real kernel against a scripted fetch.
const run = async (request: Request, answer: (seen: Seen) => Promise<Response> | Response, prepare: (document: Document) => void = () => {}): Promise<Run> => {
  const seen: Seen[] = [];
  const diagnostics: string[] = [];
  const state: { outcome?: EffectOutcome } = {};
  const transport: EngineTransport = {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage) => {
      if (message.kind === "EffectResult" && message.result.kind === "HttpResult") state.outcome = message.result.outcome;
      return { view: {}, cancellations: [], effects: message.kind === "Initialize" ? [{ kind: "Http", correlationId: "h1" as CorrelationId, ...request }] : [] };
    },
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const entry = { url, init };
    seen.push(entry);
    return answer(entry);
  }) as typeof fetch;
  await withFetch(fetchImpl, () => withDom("<p>http</p>", async (document) => {
    prepare(document);
    await new BrowserKernel(transport, document, { report: (event) => { diagnostics.push(JSON.stringify(event)); } }).start();
  }));
  return { outcome: state.outcome, seen, diagnostics };
};

// One after another: each run installs its own global fetch.
const sequentially = <T, R>(items: readonly T[], each: (item: T) => Promise<R>): Promise<readonly R[]> =>
  items.reduce<Promise<readonly R[]>>(async (done, item) => [...(await done), await each(item)], Promise.resolve([]));

const headersOf = (seen: readonly Seen[]): Record<string, string> => Object.fromEntries(Object.entries((seen[0]?.init?.headers ?? {}) as Record<string, string>));
const GET = { method: "GET", url: "/api", timeoutMs: 1000 } as const;

test("protocol 1.4 is what the kernel offers (1.3 added this profile; 1.4, connection-lost)", () => {
  assert.equal(PROTOCOL_MINOR, 4);
});

test("JSON stays the smallest default path: no new field, the same request and the same outcome as before", async () => {
  const { outcome, seen } = await run(GET, () => Response.json({ available: true }));
  assert.deepEqual(outcome, { kind: "Success", status: 200, body: { available: true } });
  assert.deepEqual(headersOf(seen), { accept: "application/json" });
  assert.equal(seen[0]?.init !== undefined && "credentials" in seen[0].init, false, "no credentials mode unless asked");
});

test("a text response is a string, not a fake invalid-response failure", async () => {
  const text = await run({ ...GET, response: "text" }, () => new Response("plain <b>text</b> é", { headers: { "content-type": "text/html" } }));
  assert.deepEqual(text.outcome, { kind: "Success", status: 200, body: "plain <b>text</b> é" });
  assert.equal("accept" in headersOf(text.seen), false, "no JSON accept header for a non-JSON representation");
  const asJson = await run(GET, () => new Response("plain text"));
  assert.deepEqual(asJson.outcome, { kind: "Failure", reason: "invalid-response", status: 200 }, "the same body read as JSON is still invalid-response");
});

test("a binary response is its exact bytes in base64", async () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256);
  const { outcome } = await run({ ...GET, response: "base64" }, () => new Response(bytes));
  assert.ok(outcome?.kind === "Success" && typeof outcome.body === "string");
  assert.ok(Buffer.from(outcome.body, "base64").equals(Buffer.from(bytes)));
});

test("none reads no body: HEAD and 204 succeed with null instead of failing as invalid JSON", async () => {
  const head = await run({ ...GET, method: "HEAD", response: "none" }, () => new Response(null, { status: 200, headers: { "content-length": "42" } }));
  assert.deepEqual(head.outcome, { kind: "Success", status: 200, body: null });
  assert.equal(head.seen[0]?.init?.method, "HEAD");
  const noContent = await run({ ...GET, method: "DELETE", response: "none" }, () => new Response(null, { status: 204 }));
  assert.deepEqual(noContent.outcome, { kind: "Success", status: 204, body: null });
  const options = await run({ ...GET, method: "OPTIONS", response: "none" }, () => new Response(null, { status: 204, headers: { allow: "GET, HEAD" } }));
  assert.equal(options.seen[0]?.init?.method, "OPTIONS");
});

test("a text body larger than MAX_HTTP_TEXT_BYTES is Failure too-large, read incrementally and abandoned", async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(65);
  const pulled = { chunks: 0 };
  const stream = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      pulled.chunks += 1;
      controller.enqueue(chunk);
      if (pulled.chunks > 100) controller.close();
    },
  });
  const { outcome } = await run({ ...GET, response: "text" }, () => new Response(stream, { status: 200 }));
  assert.deepEqual(outcome, { kind: "Failure", reason: "too-large", status: 200 });
  assert.ok(pulled.chunks <= MAX_HTTP_TEXT_BYTES / chunk.length + 2, `stopped reading after the limit (${pulled.chunks} chunks)`);
});

test("response headers: exactly the named ones, by lower-case name, and only when asked", async () => {
  const response = () => new Response("{}", { headers: { ETag: "\"v7\"", Location: "/api/7", "Set-Cookie": "session=secret", "X-Other": "no" } });
  const asked = await run({ ...GET, responseHeaders: ["ETag", "location", "x-missing"] }, response);
  assert.deepEqual(asked.outcome, { kind: "Success", status: 200, body: {}, headers: { etag: "\"v7\"", location: "/api/7" } });
  const notAsked = await run(GET, response);
  assert.deepEqual(notAsked.outcome, { kind: "Success", status: 200, body: {} });
});

test("credentials: passed to fetch exactly as asked", async () => {
  const modes = await sequentially(["omit", "same-origin", "include"] as const, async (credentials) => (await run({ ...GET, credentials }, () => Response.json({}))).seen[0]?.init?.credentials);
  assert.deepEqual(modes, ["omit", "same-origin", "include"]);
});

test("XSRF: one named cookie into one named header, same-origin only, and the value never reaches diagnostics or the engine", async () => {
  const cookie = (document: Document): void => { document.cookie = "XSRF-TOKEN=tok%3Dsecret-123"; document.cookie = "other=x"; };
  const xsrf = { cookie: "XSRF-TOKEN", header: "X-XSRF-TOKEN" };
  const same = await run({ ...GET, method: "POST", body: "{}", xsrf }, () => Response.json({}), cookie);
  assert.equal(headersOf(same.seen)["X-XSRF-TOKEN"], "tok=secret-123");
  const absolute = await run({ ...GET, url: "http://localhost/api", xsrf }, () => Response.json({}), cookie);
  assert.equal(headersOf(absolute.seen)["X-XSRF-TOKEN"], "tok=secret-123", "an absolute URL on the same origin counts");
  const cross = await run({ ...GET, url: "https://api.example.test/x", xsrf }, () => Response.json({}), cookie);
  assert.equal("X-XSRF-TOKEN" in headersOf(cross.seen), false, "never sent to another origin");
  const missing = await run({ ...GET, xsrf: { cookie: "NOPE", header: "X-XSRF-TOKEN" } }, () => Response.json({}), cookie);
  assert.equal("X-XSRF-TOKEN" in headersOf(missing.seen), false, "no cookie, no header");
  const failed = await run({ ...GET, xsrf, headers: { authorization: "Bearer secret-456" } }, () => { throw new Error("network down: tok=secret-123 Bearer secret-456"); }, cookie);
  assert.deepEqual(failed.outcome, { kind: "Failure", reason: "network" });
  assert.ok(!JSON.stringify(failed.diagnostics).includes("secret"), "diagnostics carry no token or credential");
  assert.ok(!JSON.stringify(same.outcome).includes("secret"), "the engine never receives the cookie value");
});

test("a timeout after dispatch stays OutcomeUnknown in every representation, including while a body is being read", async () => {
  const hang = (seen: Seen): Promise<Response> => new Promise((_resolve, reject) => { seen.init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
  const slowBody = (seen: Seen): Response => new Response(new ReadableStream({
    start: (controller) => { seen.init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted"))); },
  }));
  const outcomes = await sequentially([
    () => run({ ...GET, timeoutMs: 10 }, hang),
    () => run({ ...GET, timeoutMs: 10, response: "text" }, hang),
    () => run({ ...GET, timeoutMs: 10, response: "base64" }, slowBody),
    () => run({ ...GET, timeoutMs: 10, response: "none", method: "HEAD" }, hang),
  ], (start) => start());
  assert.deepEqual(outcomes.map((result) => result.outcome), Array(4).fill({ kind: "OutcomeUnknown", reason: "timeout-after-dispatch" }));
});
