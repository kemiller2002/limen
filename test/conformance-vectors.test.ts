// The TypeScript host's side of the shared semantic vectors in
// conformance/vectors/. F#, C# and Rust run the same file through their own
// generated bindings (guests/*); all four must agree on every vector.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as codec from "../src/generated/core.codec.ts";
import { CONTRACT_IDENTITY } from "../src/generated/core.ts";
import { fingerprintOf } from "../tools/contract-gen/model.ts";

type Vector = { readonly name: string; readonly type: string; readonly valid: boolean; readonly errorPath?: string; readonly json: unknown };
type Decoder = (value: unknown, path?: string) => { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly path: string } };

const file = JSON.parse(await readFile(new URL("../conformance/vectors/core.vectors.json", import.meta.url), "utf8")) as { readonly vectors: readonly Vector[] };
const decoders: Readonly<Record<string, Decoder>> = Object.fromEntries(
  Object.entries(codec).filter(([name]) => name.startsWith("decode")).map(([name, decoder]) => [name.slice("decode".length), decoder as Decoder]),
);

test("the TypeScript binding's fingerprint is the contract's, computed independently", async () => {
  const contract = JSON.parse(await readFile(new URL("../contract/core.contract.json", import.meta.url), "utf8")) as unknown;
  assert.equal(CONTRACT_IDENTITY.fingerprint, fingerprintOf(contract));
});

for (const vector of file.vectors) {
  test(`${vector.valid ? "accepts" : "rejects"}: ${vector.type} — ${vector.name}`, () => {
    const decode = decoders[vector.type];
    assert.ok(decode, `no generated decoder for ${vector.type}`);
    const result = decode(vector.json, "$");
    if (vector.valid) {
      assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
      // The TypeScript binding's values are the wire shape itself, so a round
      // trip is the decoded value serialized again.
      if (result.ok) assert.deepEqual(JSON.parse(JSON.stringify(result.value)), vector.json);
    } else {
      assert.equal(result.ok, false, "decoded a vector that must be rejected");
      if (!result.ok) assert.equal(result.error.path, vector.errorPath);
    }
  });
}
