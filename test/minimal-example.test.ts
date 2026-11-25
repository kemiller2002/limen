// The minimal example ships inside the npm package (scripts/check-package.ts),
// so its manifest is what a consumer copies. Its dependency range must admit
// the version it ships with: on 0.x a caret range admits one minor line only,
// so a range left behind at an earlier minor silently excludes the release.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

type Version = readonly [number, number, number];

const parse = (text: string): Version | undefined => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
};

const compare = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The npm caret rule: the leftmost non-zero component is fixed.
const caretAdmits = (floor: Version, version: Version): boolean => {
  const sameLine =
    floor[0] !== 0 ? version[0] === floor[0]
    : floor[1] !== 0 ? version[0] === 0 && version[1] === floor[1]
    : version[0] === 0 && version[1] === 0 && version[2] === floor[2];
  return sameLine && compare(version, floor) >= 0;
};

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

test("the caret rule admits one 0.x minor line from its floor", () => {
  assert.equal(caretAdmits([0, 9, 1], [0, 9, 1]), true);
  assert.equal(caretAdmits([0, 9, 1], [0, 9, 4]), true);
  assert.equal(caretAdmits([0, 9, 1], [0, 9, 0]), false);
  assert.equal(caretAdmits([0, 7, 0], [0, 9, 1]), false);
  assert.equal(caretAdmits([1, 2, 0], [1, 9, 0]), true);
  assert.equal(caretAdmits([1, 2, 0], [2, 0, 0]), false);
});

test("the shipped minimal example's Limen range admits the package version", async () => {
  const pkg = await readJson("package.json");
  const example = await readJson("examples/minimal/package.json");
  const range = (example.dependencies as Record<string, string> | undefined)?.[pkg.name as string];
  assert.ok(range, `examples/minimal/package.json must depend on ${String(pkg.name)}`);
  const floor = range.startsWith("^") ? parse(range.slice(1)) : undefined;
  const version = parse(pkg.version as string);
  assert.ok(floor, `expected a caret range on an exact version, found "${range}"`);
  assert.ok(version, `package.json version "${String(pkg.version)}" is not a release version`);
  assert.ok(caretAdmits(floor, version), `"${range}" does not admit the package version ${String(pkg.version)}`);
});
