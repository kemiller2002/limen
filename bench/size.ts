// Payload size of a consumer profile (kemiller2002/limen#19, LCP-033): the
// static import closure of the profile's entry modules in dist/, as a browser
// or bundler would load it. Raw bytes, the sum of each module gzipped (served
// one module per request), and the whole closure gzipped together (bundled).
//
// Reads files; computes nothing else. The budgets it is checked against live in
// bench/budgets.json and are enforced by test/bench-size.test.ts.

import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";

export type Profile = {
  readonly name: string;
  readonly doc: string;
  readonly entries: readonly string[];
  // Path fragments that must never appear in this profile's closure.
  readonly forbidden: readonly string[];
};

export type Closure = {
  readonly profile: string;
  readonly modules: readonly string[];
  readonly rawBytes: number;
  readonly gzipBytesPerModule: number;
  readonly gzipBytesBundled: number;
  readonly forbiddenPresent: readonly string[];
};

// Static and dynamic imports with a literal specifier. tsc has already erased
// type-only imports, so what remains is what loads.
const SPECIFIER = /(?:\bimport|\bexport)\s*(?:[\w*{}\s,$]+\s*from\s*)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

export const importsOf = (source: string): readonly string[] =>
  Array.from(source.matchAll(SPECIFIER), (match) => match[1] ?? match[2] ?? "").filter((specifier) => specifier.startsWith("."));

type Loaded = { readonly path: string; readonly source: string };

const walk = async (pending: readonly string[], seen: ReadonlyMap<string, Loaded>): Promise<ReadonlyMap<string, Loaded>> => {
  const [next, ...rest] = pending;
  if (next === undefined) return seen;
  if (seen.has(next)) return walk(rest, seen);
  const source = await readFile(next, "utf8");
  const dependencies = importsOf(source).map((specifier) => resolve(dirname(next), specifier));
  return walk([...rest, ...dependencies], new Map([...seen, [next, { path: next, source }]]));
};

export const measureProfile = async (root: string, profile: Profile): Promise<Closure> => {
  const loaded = await walk(profile.entries.map((entry) => join(root, entry)), new Map());
  const modules = Array.from(loaded.values()).sort((a, b) => a.path.localeCompare(b.path));
  const names = modules.map((module) => relative(root, module.path));
  const bytes = (text: string): number => Buffer.byteLength(text, "utf8");
  return {
    profile: profile.name,
    modules: names,
    rawBytes: modules.reduce((sum, module) => sum + bytes(module.source), 0),
    gzipBytesPerModule: modules.reduce((sum, module) => sum + gzipSync(module.source, { level: 9 }).length, 0),
    gzipBytesBundled: gzipSync(modules.map((module) => module.source).join("\n"), { level: 9 }).length,
    forbiddenPresent: names.filter((name) => profile.forbidden.some((fragment) => name.includes(fragment))),
  };
};

export type Budgets = {
  readonly doc: string;
  readonly profiles: readonly (Profile & {
    readonly baseline: { readonly rawBytes: number; readonly gzipBytesBundled: number };
    readonly budget: { readonly rawBytes: number; readonly gzipBytesBundled: number };
  })[];
};

export const readBudgets = async (root: string): Promise<Budgets> => JSON.parse(await readFile(join(root, "bench/budgets.json"), "utf8")) as Budgets;
