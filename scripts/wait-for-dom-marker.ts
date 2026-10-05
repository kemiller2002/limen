// Loads one page in headless Chrome and waits, in REAL time, until its DOM
// contains a marker or a deadline passes; prints the last DOM seen on stdout and
// exits 0 only when the marker was present.
//
// Why not `--virtual-time-budget --dump-dom`: Chrome's virtual clock advances
// whenever the page's main thread has nothing queued, which is most of the
// time the .NET WebAssembly runtime spends loading. On a slow or contended
// machine the whole budget is spent - at 20 or 200 virtual seconds alike -
// before the runtime has even requested dotnet.native.wasm, and the DOM is
// dumped before the engine has projected anything. A deadline on the wall
// clock does not have that failure mode.
//
// Usage: wait-for-dom-marker.ts <chrome> <url> <marker> <timeoutMs>
// Dependency-free: Node's own child_process, fetch and WebSocket speak CDP.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Target = { readonly type: string; readonly url: string; readonly webSocketDebuggerUrl: string };
type Reply = { readonly id?: number; readonly result?: { readonly result?: { readonly value?: unknown } } };

type Outcome = { readonly found: boolean; readonly dom: string };

const POLL_MS = 250;
const HARD_CAP_GRACE_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

const chromeArgs = (profile: string, url: string): readonly string[] => [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  url,
];

// Chrome announces its DevTools endpoint on stderr; everything else it writes
// there is forwarded so failures keep their diagnostics.
const devToolsPort = (chrome: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    const scan = (text: string): void => {
      process.stderr.write(text);
      const found = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(text);
      if (found) resolve(Number(found[1]));
    };
    chrome.stderr?.setEncoding("utf8").on("data", scan);
    chrome.once("exit", (code) => reject(new Error(`Chrome exited (${code}) before opening DevTools.`)));
  });

const pageTarget = async (port: number, url: string): Promise<Target> => {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as readonly Target[];
  const page = targets.find((target) => target.type === "page" && target.url.startsWith(url))
    ?? targets.find((target) => target.type === "page");
  if (!page) throw new Error("Chrome exposed no page target.");
  return page;
};

const connect = (endpoint: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    socket.addEventListener("open", () => resolve(socket), { once: true });
    socket.addEventListener("error", () => reject(new Error(`Could not connect to ${endpoint}.`)), { once: true });
  });

// One request, one reply: each evaluation gets its own id and listener.
const evaluate = (socket: WebSocket, id: number, expression: string): Promise<string> =>
  new Promise((resolve) => {
    const onMessage = (event: MessageEvent): void => {
      const reply = JSON.parse(String(event.data)) as Reply;
      if (reply.id !== id) return;
      socket.removeEventListener("message", onMessage);
      const value = reply.result?.result?.value;
      resolve(typeof value === "string" ? value : "");
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });

const DOM = "document.documentElement ? document.documentElement.outerHTML : ''";

const pollUntilMarker = async (socket: WebSocket, marker: string, deadline: number, id = 1): Promise<Outcome> => {
  const dom = await evaluate(socket, id, DOM);
  if (dom.includes(marker)) return { found: true, dom };
  if (Date.now() >= deadline) return { found: false, dom };
  await sleep(POLL_MS);
  return pollUntilMarker(socket, marker, deadline, id + 1);
};

// A hard wall-clock cap over the whole DevTools exchange: a Chrome that stops
// answering must fail this attempt, never hang the job. The timer is cleared
// as soon as the exchange settles, so a pass costs no extra time.
const withHardCap = (observed: Promise<Outcome>, capMs: number): Promise<Outcome> => {
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const abandoned = new Promise<Outcome>((resolve) => {
    timer.handle = setTimeout(() => {
      process.stderr.write(`DevTools exchange exceeded its ${capMs} ms hard cap.\n`);
      resolve({ found: false, dom: "" });
    }, capMs);
  });
  return Promise.race([observed, abandoned]).finally(() => clearTimeout(timer.handle));
};

const run = async (chromePath: string, url: string, marker: string, timeoutMs: number): Promise<boolean> => {
  const profile = await mkdtemp(join(tmpdir(), "limen-smoke-chrome-"));
  const chrome = spawn(chromePath, chromeArgs(profile, url), { stdio: ["ignore", "ignore", "pipe"] });
  const exited = new Promise<void>((done) => chrome.once("exit", () => done()));
  try {
    const deadline = Date.now() + timeoutMs;
    const observed = (async () => {
      const port = await devToolsPort(chrome);
      const socket = await connect((await pageTarget(port, url)).webSocketDebuggerUrl);
      const outcome = await pollUntilMarker(socket, marker, deadline);
      socket.close();
      return outcome;
    })();
    const outcome = await withHardCap(observed, timeoutMs + HARD_CAP_GRACE_MS);
    process.stdout.write(outcome.dom);
    return outcome.found;
  } finally {
    chrome.kill("SIGKILL");
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
};

const [chromePath, url, marker, timeout] = process.argv.slice(2);
if (!chromePath || !url || !marker || !timeout || !(Number(timeout) > 0)) {
  process.stderr.write("usage: wait-for-dom-marker.ts <chrome> <url> <marker> <timeoutMs>\n");
  process.exit(2);
}
process.exitCode = await run(chromePath, url, marker, Number(timeout)).then(
  (found) => (found ? 0 : 1),
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  },
);
