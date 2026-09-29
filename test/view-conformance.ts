// Holds real engines to their pages' view contracts (kemiller2002/limen#48):
// a transport wrapper that checks every projection an engine returns and
// every event the kernel sends against `<page>.view.json`. The static check
// (scripts/check-views.ts) proves the HTML agrees with the contract; this
// proves the engine does, so the contract cannot drift into fiction.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkEvent, checkProjection, parseViewContract, type ViewContract } from "../dist/tooling/view-contract.js";
import type { EngineTransport } from "../dist/protocol.js";

const contracts = new Map<string, ViewContract>();
const seen = new Map<string, number>();
const violations: string[] = [];

export const loadContract = (path: string): ViewContract => {
  const parsed = parseViewContract(JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as unknown);
  if (!parsed.ok) throw new Error(`${path}: ${parsed.errors.join("; ")}`);
  return parsed.contract;
};

const contractFor = (example: string): ViewContract => {
  const cached = contracts.get(example);
  if (cached !== undefined) return cached;
  const loaded = loadContract(`examples/${example}/index.view.json`);
  contracts.set(example, loaded);
  return loaded;
};

export const conforming = (example: string, inner: EngineTransport): EngineTransport => ({
  start: () => inner.start(),
  dispatch: async (message) => {
    const contract = contractFor(example);
    if (message.kind === "Event") violations.push(...checkEvent(message.event, contract).map((problem) => `${example}: ${problem}`));
    const response = await inner.dispatch(message);
    violations.push(...checkProjection(response.view, contract).map((problem) => `${example}: ${problem}`));
    seen.set(example, (seen.get(example) ?? 0) + 1);
    return response;
  },
});

export const assertEveryProjectionConformed = (examples: readonly string[]): void => {
  assert.deepEqual(examples.filter((example) => (seen.get(example) ?? 0) === 0), [], "an example produced no projection to check");
  assert.deepEqual(Array.from(new Set(violations)).sort(), []);
};
