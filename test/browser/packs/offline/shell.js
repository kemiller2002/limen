// What the offline reference page needs to start with no network: the page,
// its scripts and every module they import. Declared, not discovered: the
// service worker caches exactly this list (test/browser/servers/offline.ts
// serves the worker that imports it).
const PAGE = "/test/browser/packs/offline/";
export const SHELL = [
  `${PAGE}index.html`,
  `${PAGE}main.js`,
  `${PAGE}outbox.js`,
  ...[
    "capabilities/lifecycle/generated/lifecycle.codec.js", "capabilities/lifecycle/generated/lifecycle.js", "capabilities/lifecycle/index.js",
    "capabilities/offline/generated/offline.codec.js", "capabilities/offline/generated/offline.js", "capabilities/offline/index.js",
    "generated/core.handshake.codec.js", "generated/core.js",
    "kernel/binding-policy.js", "kernel/browser-kernel.js", "kernel/capabilities.js", "kernel/diagnostics.js", "kernel/handshake.js",
    "protocol.js",
  ].map((module) => `/dist/${module}`),
];
