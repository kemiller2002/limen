import { defineConfig } from "@playwright/test";

// `npm run ui:conformance` (after npm run build:site; Playwright and Ajv are
// installed without saving, as ci.yml does: npm install --no-save
// @playwright/test@1.56.1 ajv@8.17.1):
// visual-engineering/UI-LAYOUT-INTERACTION@1.0.0 evidence for the Limen product site.
// Chromium only: text scaling uses the Chromium DevTools protocol. The
// built site (dist-site/) is served the way GitHub Pages resolves it. The
// evidence reporter writes test-results/evidence.json.
const port = Number(process.env.UI_CONFORMANCE_PORT ?? 4347);
const executablePath = process.env.UI_CONFORMANCE_CHROMIUM || undefined;

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.mjs",
  outputDir: "test-results/artifacts",
  fullyParallel: true,
  // Machines and CI runners are shared: keep concurrency low.
  workers: Number(process.env.UI_CONFORMANCE_WORKERS ?? 2),
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [[process.env.CI ? "line" : "list"], ["./evidence-reporter.mjs"]],
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : {}
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node serve.mjs",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    env: { UI_CONFORMANCE_PORT: String(port), ...(process.env.UI_CONFORMANCE_SITE_DIR ? { UI_CONFORMANCE_SITE_DIR: process.env.UI_CONFORMANCE_SITE_DIR } : {}) }
  }
});
