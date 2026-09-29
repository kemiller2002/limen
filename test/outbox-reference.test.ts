// The offline reference page's JavaScript outbox against the same
// language-neutral scenarios the F# reference library runs
// (conformance/outbox/outbox.vectors.json): the snapshot as a subset, what a
// command emitted and why it was ignored, exactly. Two implementations, one
// definition (kemiller2002/limen#40, LCP-034).

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { apply, empty } from "./browser/packs/offline/outbox.js";

type Step = Record<string, unknown> & { readonly expect: Record<string, unknown>; readonly ignored?: string };
type Scenario = { readonly name: string; readonly steps: readonly Step[] };

const vectors = JSON.parse(await readFile(new URL("../conformance/outbox/outbox.vectors.json", import.meta.url), "utf8")) as { readonly scenarios: readonly Scenario[] };

const subset = (expected: unknown, actual: unknown): boolean => {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((item, index) => subset(item, actual[index]));
  if (expected !== null && typeof expected === "object") {
    return actual !== null && typeof actual === "object" && Object.entries(expected).every(([key, value]) => key in actual && subset(value, Reflect.get(actual, key)));
  }
  return expected === actual;
};

vectors.scenarios.forEach((scenario) => {
  test(`outbox (JavaScript): ${scenario.name}`, () => {
    scenario.steps.reduce<unknown>((outbox, step, index) => {
      const [next, emitted, ignored] = apply(step, outbox);
      const { emitted: expectedEmitted = [], ...snapshot } = step.expect;
      assert.deepEqual(emitted, expectedEmitted, `step ${index + 1} emitted`);
      assert.equal(ignored, step.ignored ?? null, `step ${index + 1} ignored`);
      assert.ok(subset(snapshot, next), `step ${index + 1}: expected ${JSON.stringify(snapshot)}, got ${JSON.stringify(next)}`);
      return next;
    }, empty);
  });
});

test("the JavaScript outbox ran every scenario", () => {
  assert.equal(vectors.scenarios.length, 8);
});
