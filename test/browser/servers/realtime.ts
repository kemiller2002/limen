// Same-origin realtime endpoints for the capability pack smoke
// (kemiller2002/limen#26), with no dependencies: a WebSocket echo server
// (RFC 6455, just enough for small frames) and a Server-Sent Events stream
// that counts its connections, so a page can prove nothing reconnected on its
// own. Test infrastructure only; nothing here ships.

import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const counts = new Map<string, number>();

// One unmasked server frame.
const frame = (opcode: number, payload: Buffer): Buffer => {
  const header = payload.length < 126
    ? Buffer.from([0x80 | opcode, payload.length])
    : Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])]);
  return Buffer.concat([header, payload]);
};
const closeFrame = (code: number, reason: string): Buffer => frame(0x8, Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)]));

type Parsed = { readonly opcode: number; readonly payload: Buffer; readonly rest: Buffer };
// One masked client frame from the front of the buffer, if it is complete.
const parse = (buffer: Buffer): Parsed | undefined => {
  if (buffer.length < 2) return undefined;
  const opcode = (buffer[0] ?? 0) & 0x0f;
  const short = (buffer[1] ?? 0) & 0x7f;
  const extended = short === 126 ? 2 : 0;
  const length = short === 126 ? buffer.readUInt16BE(2) : short;
  const maskAt = 2 + extended;
  const end = maskAt + 4 + length;
  if (buffer.length < end) return undefined;
  const mask = buffer.subarray(maskAt, maskAt + 4);
  const payload = Buffer.from(buffer.subarray(maskAt + 4, end).map((byte, index) => byte ^ (mask[index % 4] ?? 0)));
  return { opcode, payload, rest: buffer.subarray(end) };
};

// Text is echoed. "binary" answers a 5-byte binary frame; "close-me" makes
// the server close with 4001. A client close is answered and the socket ends.
const respond = (socket: Duplex, parsed: Parsed): void => {
  const text = parsed.payload.toString();
  if (parsed.opcode === 0x8) {
    socket.end(frame(0x8, parsed.payload.subarray(0, 2)));
  } else if (parsed.opcode === 0x1 && text === "binary") {
    socket.write(frame(0x2, Buffer.from([1, 2, 3, 4, 5])));
  } else if (parsed.opcode === 0x1 && text === "close-me") {
    socket.end(closeFrame(4001, "server said so"));
  } else if (parsed.opcode === 0x1) {
    socket.write(frame(0x1, parsed.payload));
  }
};

export const upgradeRealtime = (request: IncomingMessage, socket: Duplex): boolean => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const key = request.headers["sec-websocket-key"];
  if (url.pathname !== "/__limen/ws" || typeof key !== "string") return false;
  const offered = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim()).filter((value) => value !== "");
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`,
    ...(offered[0] !== undefined ? [`Sec-WebSocket-Protocol: ${offered[0]}`] : []), "", "",
  ].join("\r\n"));
  const pending = { buffer: Buffer.alloc(0) };
  const drain = (): void => {
    const parsed = parse(pending.buffer);
    if (parsed === undefined) return;
    pending.buffer = parsed.rest;
    respond(socket, parsed);
    drain();
  };
  socket.on("data", (chunk: Buffer) => { pending.buffer = Buffer.concat([pending.buffer, chunk]); drain(); });
  socket.on("error", () => {});
  return true;
};

// GET /__limen/sse?stream=<name>: three events (unnamed, a named "price" with
// an id, an unlisted "ignored"), a 50 ms retry hint, then the stream ends —
// which a browser would retry. GET /__limen/sse-count?stream=<name> answers
// how many times that stream was opened.
export const serveRealtime = (request: IncomingMessage, response: ServerResponse): boolean => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const stream = url.searchParams.get("stream") ?? "default";
  if (url.pathname === "/__limen/sse-count") {
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ count: counts.get(stream) ?? 0 }));
    return true;
  }
  if (url.pathname !== "/__limen/sse") return false;
  counts.set(stream, (counts.get(stream) ?? 0) + 1);
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
  response.write("retry: 50\n\n");
  response.write("data: tick\n\n");
  response.write("event: price\nid: 7\ndata: 42\n\n");
  response.write("event: ignored\ndata: nobody listens\n\n");
  setTimeout(() => response.end(), 150);
  return true;
};
