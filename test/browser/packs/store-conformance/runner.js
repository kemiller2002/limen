// The TypeScript store pack's runner for the language-neutral vectors in
// conformance/store/store.vectors.json (LCP-075). Plain JavaScript, so the
// same file runs under node (test/store-conformance.test.ts, over an
// in-memory IndexedDB with injected faults) and in real browsers (this
// directory's page). The F# fake has its own runner over the same file.
//
// An environment supplies what differs between those places:
//   supports: Set of the requirement names it can perform;
//   origin(vector, index): a fresh origin with
//     tab(name) -> { ask(request, { cancelled }), facts: [] },
//     inject(step), holdOpen(database, tab), release(database), dispose().
// A vector whose requirement the environment lacks is reported unsupported,
// never passed.

// {"$any": "bool"|"int"|"string"} matches any value of that kind; everything
// else must be JSON-equal, with exactly the same object keys.
export const matches = (expected, actual) => {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected) && Object.keys(expected).length === 1 && "$any" in expected) {
    switch (expected.$any) {
      case "bool": return typeof actual === "boolean";
      case "int": return Number.isInteger(actual);
      case "string": return typeof actual === "string";
      default: return false;
    }
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(item, actual[index]));
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    const keys = Object.keys(expected).sort();
    const found = Object.keys(actual).filter((key) => actual[key] !== undefined).sort();
    return keys.length === found.length && keys.every((key, index) => key === found[index] && matches(expected[key], actual[key]));
  }
  return expected === actual;
};

const settle = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Facts arrive asynchronously: wait until the tab has at least as many as
// expected (or a deadline), then take them all.
const factsOf = async (tab, count) => {
  const deadline = Date.now() + 2000;
  while (tab.facts.length < count && Date.now() < deadline) await settle(10);
  await settle(20);
  return tab.facts.splice(0);
};

const runStep = async (origin, step, number) => {
  const where = `step ${number}`;
  if ("request" in step) {
    const actual = await origin.tab(step.tab).ask(step.request, { cancelled: step.cancelled === true });
    return matches(step.expect, actual) ? undefined : `${where} (${step.request.operation}): expected ${JSON.stringify(step.expect)}, got ${JSON.stringify(actual)}`;
  }
  if ("facts" in step) {
    const actual = await factsOf(origin.tab(step.facts), step.expect.length);
    return matches(step.expect, actual) ? undefined : `${where} (facts of ${step.facts}): expected ${JSON.stringify(step.expect)}, got ${JSON.stringify(actual)}`;
  }
  if ("inject" in step) { await origin.inject(step); return undefined; }
  if ("holdOpen" in step) { await origin.holdOpen(step.holdOpen, step.tab ?? "a"); return undefined; }
  if ("release" in step) { await origin.release(step.release); return undefined; }
  return `${where}: unknown step ${JSON.stringify(step)}`;
};

export const runStoreVectors = async (vectors, environment) => {
  const results = [];
  for (const [index, vector] of vectors.entries()) {
    const missing = (vector.requires ?? []).filter((requirement) => !environment.supports.has(requirement));
    if (missing.length > 0) {
      results.push({ name: vector.name, status: "unsupported", detail: `needs ${missing.join(", ")}` });
      continue;
    }
    const origin = await environment.origin(vector, index);
    try {
      const failure = await vector.steps.reduce(async (previous, step, number) => (await previous) ?? runStep(origin, step, number), Promise.resolve(undefined));
      results.push({ name: vector.name, status: failure === undefined ? "passed" : "failed", detail: failure ?? "" });
    } catch (error) {
      results.push({ name: vector.name, status: "failed", detail: `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}` });
    } finally {
      await origin.dispose();
    }
  }
  const count = (status) => results.filter((result) => result.status === status).length;
  return { passed: count("passed"), failed: count("failed"), unsupported: count("unsupported"), results };
};

// The namespace a vector's tab registers with: one per vector and app, so
// vectors never see each other's databases.
export const namespaceOf = (prefix, index, vector, tab) => `${prefix}${String(index)}-${vector.tabs?.[tab]?.app ?? "one"}`;

// The registration options a vector's tab uses.
export const optionsOf = (prefix, index, vector, tab) => ({
  namespace: namespaceOf(prefix, index, vector, tab),
  ...(vector.registration?.limits !== undefined ? { limits: vector.registration.limits } : {}),
});

// Every StoreResult and StoreFact variant a vector expects somewhere.
export const kindsExpected = (vectors) => new Set(vectors.flatMap((vector) => vector.steps.flatMap((step) =>
  "request" in step ? [step.expect.kind] : "facts" in step ? step.expect.map((fact) => fact.kind) : [])));
