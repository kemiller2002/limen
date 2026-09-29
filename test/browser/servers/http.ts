// Same-origin HTTP endpoints for the Core HTTP profile smoke
// (kemiller2002/limen#47). Test infrastructure only; nothing here ships.

import type { IncomingMessage, ServerResponse } from "node:http";

const cookiesOf = (request: IncomingMessage): Readonly<Record<string, string>> =>
  Object.fromEntries(String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part !== "").map((part) => {
    const at = part.indexOf("=");
    return [part.slice(0, at), part.slice(at + 1)] as const;
  }));

// How many requests /__limen/http/reset received before dropping them.
const dropped = { count: 0 };

export const serveHttp = (request: IncomingMessage, response: ServerResponse): boolean => {
  const url = new URL(request.url ?? "/", "http://localhost");
  switch (url.pathname) {
    case "/__limen/http/json":
      response.writeHead(200, { "Content-Type": "application/json", ETag: "\"v7\"", "X-Request-Id": "req-42" }).end(JSON.stringify({ ok: true }));
      return true;
    case "/__limen/http/text":
      response.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" }).end("name,total\nÉlan,3\n");
      return true;
    case "/__limen/http/bytes":
      response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(Buffer.from(Array.from({ length: 256 }, (_, index) => index)));
      return true;
    case "/__limen/http/empty":
      response.writeHead(request.method === "HEAD" ? 200 : 204, { "X-Count": "12" }).end();
      return true;
    case "/__limen/http/huge":
      response.writeHead(200, { "Content-Type": "text/plain" });
      Array.from({ length: 9 }).forEach(() => response.write(Buffer.alloc(1024 * 1024, 65)));
      response.end();
      return true;
    case "/__limen/http/login":
      response.writeHead(200, { "Set-Cookie": ["session=abc; Path=/; SameSite=Strict", "XSRF-TOKEN=tok-789; Path=/; SameSite=Strict"], "Content-Type": "application/json" }).end("{}");
      return true;
    case "/__limen/http/whoami":
      // Reports what arrived, never echoing a secret back: which cookies were
      // present, and whether the XSRF header matched the cookie.
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        session: "session" in cookiesOf(request),
        xsrfMatches: request.headers["x-xsrf-token"] !== undefined && request.headers["x-xsrf-token"] === cookiesOf(request)["XSRF-TOKEN"],
        xsrfSent: request.headers["x-xsrf-token"] !== undefined,
      }));
      return true;
    case "/__limen/http/upload": {
      // Consumes the whole body and reports its size, its content type and,
      // for multipart, the part names and file names it saw.
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const type = String(request.headers["content-type"] ?? "");
        const text = type.startsWith("multipart/form-data") ? body.toString("latin1") : "";
        const names = Array.from(text.matchAll(/name="([^"]*)"(?:; filename="([^"]*)")?/g), (match) => (match[2] === undefined ? match[1] : `${match[1]}:${match[2]}`));
        const field = /name="title"\r\n\r\n([^\r]*)/.exec(text)?.[1];
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ bytes: body.length, type: type.split(";")[0], names, field: field ?? null }));
      });
      return true;
    }
    case "/__limen/http/download":
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(3 * 1024 * 1024) }).end(Buffer.alloc(3 * 1024 * 1024, 7));
      return true;
    case "/__limen/http/reset":
      // Reads the whole request, counts it, then drops the connection without
      // answering: the server has the request, the browser has no response.
      request.on("data", () => {});
      request.on("end", () => { dropped.count += 1; request.socket.destroy(); });
      return true;
    case "/__limen/http/reset-count":
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ received: dropped.count }));
      return true;
    case "/__limen/http/slow":
      setTimeout(() => { if (!response.writableEnded) response.writeHead(200, { "Content-Type": "application/json" }).end("{}"); }, 2000);
      return true;
    default:
      return false;
  }
};
