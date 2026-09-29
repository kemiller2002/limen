// The fast edit loop's server (kemiller2002/limen#36): serves a directory and
// streams file changes to the page as Server-Sent Events at
// /__limen/dev/events, one JSON change per message ({ kind, path }), which
// src/tooling/hot-reload.ts turns into a reload plan. Development only.
//
//   npm run dev -- [directory] [port]      (defaults: the repository, 4180)

import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, relative, sep } from "node:path";

type Kind = "css" | "html" | "engine" | "other";

export const kindOf = (path: string): Kind => {
  switch (extname(path)) {
    case ".css": return "css";
    case ".html": return "html";
    case ".js":
    case ".mjs":
    case ".wasm": return "engine";
    default: return "other";
  }
};

const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml" };

// node_modules and build caches change constantly and mean nothing to a page.
const ignored = (path: string): boolean => path.split(sep).some((part) => part === "node_modules" || part === ".git" || part === "obj" || part === "bin");

export const startDevServer = (root: string, port: number): Promise<{ readonly server: Server; readonly close: () => void }> => {
  const clients = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/__limen/dev/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    const path = normalize(decodeURIComponent(url.pathname));
    const file = join(root, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(root)) { response.writeHead(403).end(); return; }
    readFile(file).then(
      (body) => response.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" }).end(body),
      () => response.writeHead(404).end(),
    );
  });
  // Editors often write a file more than once per save; one message per file
  // per 50 ms is enough.
  const recent = new Map<string, number>();
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (name === null || ignored(name)) return;
    const now = Date.now();
    if ((recent.get(name) ?? 0) > now - 50) return;
    recent.set(name, now);
    const path = "/" + relative(root, join(root, name)).split(sep).join("/");
    const message = `data: ${JSON.stringify({ kind: kindOf(path), path })}\n\n`;
    clients.forEach((client) => client.write(message));
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({
      server,
      close: () => { watcher.close(); clients.forEach((client) => client.end()); server.close(); },
    }));
  });
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = normalize(join(process.cwd(), process.argv[2] ?? "."));
  const port = Number(process.argv[3] ?? 4180);
  await startDevServer(root, port);
  console.log(`Limen dev server: http://127.0.0.1:${port}/ (changes stream at /__limen/dev/events)`);
}
