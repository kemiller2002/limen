import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalize, fingerprintOf, parseUnit } from "../tools/contract-gen/model.ts";
import { check, classify, render, withHeader } from "../tools/contract-gen/main.ts";
import { decodeBrowserToEngineMessage, decodeEffectRequest, decodeEngineHandshake, decodeEngineToBrowserMessage, decodeViewState } from "../src/generated/core.codec.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const coreRaw = JSON.parse(await readFile(new URL("../contract/core.contract.json", import.meta.url), "utf8")) as Record<string, unknown>;

const unitWith = (types: unknown[]): unknown => ({ unit: "limen.test", role: "capability", version: 1, types });

// ---------------------------------------------------------------------------
// One source of truth, deterministically rendered
// ---------------------------------------------------------------------------

test("the core contract is well-formed", () => {
  const parsed = parseUnit(coreRaw, "contract/core.contract.json");
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("\n"));
});

test("every generated binding on disk is exactly what the contract produces", async () => {
  assert.deepEqual(await check(ROOT), []);
});

test("two renders are byte-for-byte identical", async () => {
  const first = await render(ROOT);
  const second = await render(ROOT);
  assert.deepEqual(first, second);
});

test("the fingerprint ignores documentation but not wire shape", () => {
  const reworded = { ...coreRaw, doc: "Entirely different prose." };
  assert.equal(fingerprintOf(reworded), fingerprintOf(coreRaw));
  const types = coreRaw.types as Record<string, unknown>[];
  const widened = { ...coreRaw, types: types.map((type) => type.name === "HttpMethod" ? { ...type, values: [...(type.values as string[]), "HEAD"] } : type) };
  assert.notEqual(fingerprintOf(widened), fingerprintOf(coreRaw));
});

test("canonical form sorts keys and is independent of source formatting", () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: 3, c: 4 }], doc: "x" }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});

test("the generated TypeScript binding carries the same fingerprint as the contract", async () => {
  const generated = await readFile(new URL("../src/generated/core.ts", import.meta.url), "utf8");
  assert.ok(generated.includes(fingerprintOf(coreRaw)));
});

// ---------------------------------------------------------------------------
// Malformed contracts are rejected before any binding is produced
// ---------------------------------------------------------------------------

const rejects = (raw: unknown, pattern: RegExp): void => {
  const parsed = parseUnit(raw, "fixture");
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.ok(parsed.errors.some((error) => pattern.test(error)), parsed.errors.join("\n"));
};

test("an unresolved type reference is rejected", () => {
  rejects(unitWith([{ name: "A", kind: "record", fields: [{ name: "b", type: "Missing" }] }]), /unresolved reference Missing/);
});

test("a shape-union whose variants share a JSON kind is rejected", () => {
  rejects(unitWith([{ name: "A", kind: "shape-union", variants: [{ name: "X", type: "int" }, { name: "Y", type: "number" }] }]), /share JSON kind number/);
});

test("a variant field that shadows the union tag is rejected", () => {
  rejects(unitWith([{ name: "A", kind: "union", tag: "kind", variants: [{ name: "X", fields: [{ name: "kind", type: "string" }] }] }]), /shadows tag/);
});

test("flattening a union with the same tag as its parent is rejected", () => {
  rejects(unitWith([
    { name: "Inner", kind: "union", tag: "kind", variants: [{ name: "X", fields: [] }] },
    { name: "Outer", kind: "union", tag: "kind", variants: [{ name: "Inner", flatten: "Inner" }] },
  ]), /different tag/);
});

test("a unit without a role is rejected", () => {
  rejects({ unit: "limen.test", version: 1, types: [] }, /role must be/);
});

test("an untyped operation/payload escape hatch cannot be expressed: unknown composite kinds fail", () => {
  rejects(unitWith([{ name: "A", kind: "record", fields: [{ name: "payload", type: { object: "any" } }] }]), /unknown composite type "object"/);
});

// ---------------------------------------------------------------------------
// Generated files are read-only: stale output and hand edits are told apart
// ---------------------------------------------------------------------------

const sampleUnit = (() => {
  const parsed = parseUnit(unitWith([{ name: "A", kind: "record", fields: [{ name: "b", type: "string" }] }]), "fixture.contract.json");
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.value;
})();
const target = { unit: "limen.test", kind: "typescript-types", path: "out.ts", typesModule: undefined } as const;

test("an identical file is current", () => {
  const content = withHeader(sampleUnit, target, "export type A = { readonly b: string };\n");
  assert.equal(classify({ path: "out.ts", content }, content), undefined);
});

test("a missing file is reported as missing", () => {
  assert.deepEqual(classify({ path: "out.ts", content: "x" }, undefined), { kind: "missing", path: "out.ts" });
});

test("a hand edit to a generated file is reported as hand-edited", () => {
  const content = withHeader(sampleUnit, target, "export type A = { readonly b: string };\n");
  const edited = content.replace("readonly b: string", "readonly b: string; readonly c: number");
  assert.deepEqual(classify({ path: "out.ts", content }, edited), { kind: "hand-edited", path: "out.ts" });
});

test("output from an older contract, untouched since generation, is reported as stale", () => {
  const old = withHeader(sampleUnit, target, "export type A = { readonly b: number };\n");
  const current = withHeader(sampleUnit, target, "export type A = { readonly b: string };\n");
  assert.deepEqual(classify({ path: "out.ts", content: current }, old), { kind: "stale", path: "out.ts" });
});

test("a file whose header was stripped is reported as hand-edited", () => {
  const current = withHeader(sampleUnit, target, "export type A = { readonly b: string };\n");
  assert.deepEqual(classify({ path: "out.ts", content: current }, "export type A = { readonly b: string };\n"), { kind: "hand-edited", path: "out.ts" });
});

// ---------------------------------------------------------------------------
// The generated codec is strict: malformed and unknown wire data fail closed
// ---------------------------------------------------------------------------

test("a well-formed Initialize decodes", () => {
  const decoded = decodeBrowserToEngineMessage({ kind: "Initialize", protocolVersion: 1, capabilities: ["Http"], location: { origin: "https://a", path: "/", query: "", hash: "" } });
  assert.equal(decoded.ok, true);
});

test("an unknown message kind fails at the compatibility boundary, naming the path", () => {
  const decoded = decodeBrowserToEngineMessage({ kind: "Teleport" });
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.deepEqual(decoded.error.path, "$.kind");
});

test("an unexpected field is corrupted wire data, not silently ignored", () => {
  const decoded = decodeEffectRequest({ kind: "Clipboard", correlationId: "c", operation: "writeText", text: "x", extra: 1 });
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.equal(decoded.error.path, "$.extra");
});

test("a missing required field fails", () => {
  const decoded = decodeEffectRequest({ kind: "Http", correlationId: "c", method: "GET", url: "/x" });
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.equal(decoded.error.path, "$.timeoutMs");
});

test("a flattened sub-union decodes by its own tag and rejects an unknown operation", () => {
  assert.equal(decodeEffectRequest({ kind: "Storage", correlationId: "c", operation: "get", key: "k" }).ok, true);
  const decoded = decodeEffectRequest({ kind: "Storage", correlationId: "c", operation: "clear" });
  assert.equal(decoded.ok, false);
  if (!decoded.ok) assert.equal(decoded.error.path, "$.operation");
});

test("an unknown enum value fails rather than becoming a string", () => {
  const decoded = decodeEffectRequest({ kind: "Http", correlationId: "c", method: "TRACE", url: "/x", timeoutMs: 1 });
  assert.equal(decoded.ok, false);
});

test("a view value is dispatched on its JSON shape and a nested object is rejected", () => {
  assert.equal(decodeViewState({ a: "x", b: 1, c: true, d: [{ id: "1", n: 2 }] }).ok, true);
  assert.equal(decodeViewState({ a: { nested: true } }).ok, false);
  assert.equal(decodeViewState({ d: [{ id: { deep: 1 } }] }).ok, false);
});

test("a non-integer where the contract says int fails", () => {
  assert.equal(decodeEngineHandshake({ kind: "Accepted", protocol: { major: 1.5, minor: 1 }, contract: { unit: "u", version: 1, fingerprint: "f" }, capabilities: [] }).ok, false);
});

test("an engine response with every optional absent decodes, and null where a list belongs fails", () => {
  assert.equal(decodeEngineToBrowserMessage({ view: {}, effects: [], cancellations: [] }).ok, true);
  assert.equal(decodeEngineToBrowserMessage({ view: {}, effects: null, cancellations: [] }).ok, false);
});
