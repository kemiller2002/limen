// Same-origin endpoints for the offline reference page
// (kemiller2002/limen#40). Test infrastructure only; nothing here ships.
//
//   /__limen/offline/sw.js      the page's service worker, at the deployed
//                               version, allowed to control the page's folder;
//   /__limen/offline/deploy     POST: the next request for sw.js is v2;
//   /__limen/offline/reset      POST: v1, and no operations;
//   /__limen/offline/ops        POST an operation, keyed by Idempotency-Key.
//                               A payload "conflict:…" is refused with 409 and
//                               a version unless it was rebased; "drop:…" is
//                               applied and then the connection is dropped
//                               without an answer. A repeated key is applied
//                               once however often it arrives;
//   /__limen/offline/ops/<key>  GET: whether that operation was applied, and
//                               how many times it arrived.

import type { IncomingMessage, ServerResponse } from "node:http";

const PAGE = "/test/browser/packs/offline/";

const state = { version: "v1", applied: new Set<string>(), received: new Map<string, number>() };

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
};

const worker = (version: string): string => [
  `import { serveOffline } from "/dist/capabilities/offline/worker.js";`,
  `import { SHELL } from "${PAGE}shell.js";`,
  `serveOffline(self, { version: "${version}", shell: SHELL, fallback: "${PAGE}index.html" });`,
].join("\n");

const readBody = (request: IncomingMessage): Promise<string> => new Promise((resolve) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
});

const payloadOf = (text: string): string => {
  try {
    const value: unknown = JSON.parse(text);
    const payload = typeof value === "object" && value !== null ? Reflect.get(value, "payload") : undefined;
    return typeof payload === "string" ? payload : "";
  } catch {
    return "";
  }
};

export const serveOffline = (request: IncomingMessage, response: ServerResponse): boolean => {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/__limen/offline/sw.js") {
    response.writeHead(200, { "Content-Type": "text/javascript", "Service-Worker-Allowed": PAGE, "Cache-Control": "no-store" }).end(worker(state.version));
    return true;
  }
  if (url.pathname === "/__limen/offline/deploy" && request.method === "POST") {
    state.version = "v2";
    json(response, 200, { version: state.version });
    return true;
  }
  if (url.pathname === "/__limen/offline/reset" && request.method === "POST") {
    state.version = "v1";
    state.applied.clear();
    state.received.clear();
    json(response, 200, {});
    return true;
  }
  if (url.pathname === "/__limen/offline/ops" && request.method === "POST") {
    const key = String(request.headers["idempotency-key"] ?? "");
    void readBody(request).then((body) => {
      state.received.set(key, (state.received.get(key) ?? 0) + 1);
      const payload = payloadOf(body);
      if (payload.startsWith("conflict:") && !payload.includes("rebased")) { json(response, 409, { version: "v7" }); return; }
      state.applied.add(key);
      if (payload.startsWith("drop:")) { request.socket.destroy(); return; }
      json(response, 200, { applied: true });
    });
    return true;
  }
  if (url.pathname.startsWith("/__limen/offline/ops/") && request.method === "GET") {
    const key = decodeURIComponent(url.pathname.slice("/__limen/offline/ops/".length));
    json(response, 200, { applied: state.applied.has(key), received: state.received.get(key) ?? 0 });
    return true;
  }
  return false;
};
