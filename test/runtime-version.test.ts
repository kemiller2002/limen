import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { runtimeStamp } from "../scripts/stamp-runtime.ts";

const packageVersion = (JSON.parse(await readFile("package.json", "utf8")) as { readonly version: string }).version;

type Browser = {
  window?: Browser;
  console: { info(message: string): void; warn(message: string): void };
  messages: { info: string[]; warn: string[] };
  __ECHELON_RUNTIME__?: { schemaVersion: number; libraries: Record<string, { version: string }> };
  __ECHELON_REGISTER_RUNTIME__?: (name: string, metadata: Record<string, unknown>) => unknown;
};

const browser = (): Browser => {
  const result: Browser = {
    messages: { info: [], warn: [] },
    console: {
      info(message) { result.messages.info.push(message); },
      warn(message) { result.messages.warn.push(message); },
    },
  };
  result.window = result;
  return result;
};

test("the emitted browser kernel carries the exact package version", async () => {
  const emitted = await readFile("dist/kernel/browser-kernel.js", "utf8");
  assert.equal(emitted.match(/<echelon-runtime-stamp>/g)?.length, 1);
  assert.ok(emitted.includes(`r("limen",{version:${JSON.stringify(packageVersion)}})`));
  assert.doesNotMatch(emitted, /process\.env/);
});

test("the production stamp is idempotent, order-insensitive, and conflict-safe", () => {
  const first = browser();
  runInNewContext(runtimeStamp(packageVersion), first);
  first.__ECHELON_REGISTER_RUNTIME__?.("forma", { version: "forma-contract-fixture" });
  first.__ECHELON_REGISTER_RUNTIME__?.("folio", { version: "folio-contract-fixture" });
  runInNewContext(runtimeStamp(packageVersion), first);
  assert.deepEqual(JSON.parse(JSON.stringify(first.__ECHELON_RUNTIME__)), {
    schemaVersion: 1,
    libraries: {
      limen: { version: packageVersion },
      forma: { version: "forma-contract-fixture" },
      folio: { version: "folio-contract-fixture" },
    },
  });
  assert.equal(first.messages.warn.length, 0);
  assert.equal(first.messages.info.length, 3);

  const reverse = browser();
  runInNewContext(runtimeStamp(packageVersion), reverse);
  const register = reverse.__ECHELON_REGISTER_RUNTIME__;
  register?.("folio", { version: "folio-contract-fixture" });
  register?.("forma", { version: "forma-contract-fixture" });
  assert.deepEqual(Object.keys(reverse.__ECHELON_RUNTIME__?.libraries ?? {}).sort(), ["folio", "forma", "limen"]);

  register?.("limen", { version: "99.0.0", secret: "not copied" });
  assert.equal(reverse.__ECHELON_RUNTIME__?.libraries.limen?.version, packageVersion);
  assert.equal(reverse.messages.warn.length, 1);
  assert.match(reverse.messages.warn[0] ?? "", /Limen .*already registered.*ignored v99\.0\.0/);
});
