// The security smoke's engine and composition root, in plain JavaScript so it
// needs no build step: every projected value is hostile, and each round
// rotates which unsafe URL form is used. See scripts/smoke-security.ts.
import { BrowserKernel } from "../../../dist/kernel/browser-kernel.js";

const PAYLOAD = `<img src=x onerror="window.__limenPwned=1"><script>window.__limenPwned=1</script>`;
const UNSAFE = [
  "javascript:window.__limenPwned=1",
  "JaVaScRiPt:window.__limenPwned=1",
  "java\tscript:window.__limenPwned=1",
  " javascript:window.__limenPwned=1",
  "data:text/html,<script>window.__limenPwned=1</script>",
  "vbscript:msgbox(1)",
];

const project = (round) => ({
  payload: PAYLOAD,
  unsafeUrl: UNSAFE[round % UNSAFE.length],
  safeUrl: "/safe?round=" + round,
  round,
  rows: UNSAFE.map((url, index) => ({ id: String(index), label: PAYLOAD, link: index % 2 === 0 ? url : "https://example.com/" + index })),
});

let round = 0;
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Event" && message.event.name === "next") round += 1;
    return { view: project(round), effects: [], cancellations: [] };
  },
};

const diagnostics = [];
window.__limenDiagnostics = diagnostics;
await new BrowserKernel(engine, document, { report: (event) => { diagnostics.push(event); } }).start();
window.__limenReady = true;
