// The lifecycle CLI, exercised through the Node bootstrap that npm installs.
//
// These tests run the real binary against real temporary repositories. They do
// not import the F# core or reimplement any of its rules, because the thing
// being checked here is the boundary between npm and the tool: argument
// forwarding, exit codes, stdout/stderr discipline, and JSON validity.
//
// `npm run test:cli` covers the F# core itself; this file covers the surface a
// consumer touches. If the CLI has not been built, every test reports as
// skipped rather than passing — a test that did not run must never look like
// one that did.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const bootstrap = join(process.cwd(), "bin", "limen.js");

const runtimeForHost = (): string => {
  const map: Record<string, string> = {
    "linux:x64": "linux-x64",
    "linux:arm64": "linux-arm64",
    "win32:x64": "win-x64",
    "darwin:x64": "osx-x64",
    "darwin:arm64": "osx-arm64",
  };
  return map[`${process.platform}:${process.arch}`] ?? "";
};

const binary = join(
  process.cwd(),
  "runtimes",
  runtimeForHost(),
  process.platform === "win32" ? "limen.exe" : "limen",
);

const built = runtimeForHost() !== "" && existsSync(binary);

// Skipping a whole `describe` removes its subtests from the run entirely, which
// reports as "0 tests" — indistinguishable from a file that passed. A single
// always-registered test that reports as skipped keeps the gap visible in the
// summary instead.
if (!built) {
  test("the packaged CLI was not exercised", { skip: `no binary at ${binary} — run \`npm run build:cli\`` }, () => {});
}

type Run = { readonly status: number; readonly stdout: string; readonly stderr: string };

const limen = (args: readonly string[]): Run => {
  const result = spawnSync(process.execPath, [bootstrap, ...args], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

/** A throwaway repository with both sides of a boundary in it. */
const newRepository = (): string => {
  const root = mkdtempSync(join(tmpdir(), "limen-pack-"));
  mkdirSync(join(root, "src", "engine"), { recursive: true });
  mkdirSync(join(root, "src", "kernel"), { recursive: true });
  writeFileSync(join(root, "src", "engine", "domain.ts"), "export const add = (a: number, b: number) => a + b;\n");
  writeFileSync(join(root, "src", "kernel", "bridge.ts"), "export const mount = () => document.body;\n");
  return root;
};

/** A stable fingerprint of every file in a tree, for proving nothing changed. */
const fingerprint = (root: string): string => {
  const walk = (directory: string): string[] =>
    readdirSync(directory).flatMap((entry) => {
      const full = join(directory, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  return walk(root)
    .sort()
    .map((file) => `${relative(root, file)}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`)
    .join("\n");
};

const cleanup = (root: string): void => rmSync(root, { recursive: true, force: true });

describe("the packaged CLI", { skip: built ? false : "the CLI has not been built" }, () => {
  test("--version reports the published package version", () => {
    const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;
    const result = limen(["--version"]);

    assert.equal(result.status, 0);
    // The CLI version and the npm release version must never drift: an agent
    // that reads one and reasons about the other has to be right.
    assert.equal(result.stdout.trim(), `limen ${packageVersion}`);
  });

  test("--help documents the commands and exits 0", () => {
    const result = limen(["--help"]);

    assert.equal(result.status, 0);
    for (const command of ["init", "status", "verify", "upgrade", "doctor"]) {
      assert.ok(result.stdout.includes(command), `help should mention ${command}`);
    }
  });

  test("every command has its own help", () => {
    for (const command of ["init", "status", "verify", "upgrade", "doctor"]) {
      const result = limen([command, "--help"]);
      assert.equal(result.status, 0, `${command} --help should exit 0`);
      assert.ok(result.stdout.includes(`limen ${command}`), `${command} --help should document ${command}`);
    }
  });

  test("an unknown command exits 2 and says so on stderr", () => {
    const result = limen(["frobnicate"]);

    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("unknown command"));
    assert.equal(result.stdout, "", "errors belong on stderr");
  });

  test("an unknown flag is rejected rather than ignored", () => {
    assert.equal(limen(["init", "--not-a-flag"]).status, 2);
  });

  test("status on an uninitialized repository exits 4", () => {
    const root = newRepository();
    try {
      assert.equal(limen(["status", "--root", root]).status, 4);
    } finally {
      cleanup(root);
    }
  });

  test("init installs, and a second init changes nothing", () => {
    const root = newRepository();
    try {
      assert.equal(limen(["init", "--root", root]).status, 0);
      assert.ok(existsSync(join(root, ".echelon", "limen.json")));
      assert.ok(existsSync(join(root, "limen.config.json")));
      assert.ok(existsSync(join(root, ".github", "workflows", "limen-verify.yml")));

      const after = fingerprint(root);
      const second = limen(["init", "--root", root]);

      assert.equal(second.status, 0);
      assert.equal(fingerprint(root), after, "a second init must not change anything");
    } finally {
      cleanup(root);
    }
  });

  test("init --dry-run writes nothing", () => {
    const root = newRepository();
    try {
      const before = fingerprint(root);
      const result = limen(["init", "--root", root, "--dry-run"]);

      assert.equal(result.status, 0);
      assert.equal(fingerprint(root), before);
      assert.ok(!existsSync(join(root, ".echelon", "limen.json")));
    } finally {
      cleanup(root);
    }
  });

  test("init --check fails on an uninitialized repository and still writes nothing", () => {
    const root = newRepository();
    try {
      const before = fingerprint(root);
      const result = limen(["init", "--root", root, "--check"]);

      assert.equal(result.status, 3, "--check should fail when work is outstanding");
      assert.equal(fingerprint(root), before);
    } finally {
      cleanup(root);
    }
  });

  test("init --check passes once the repository is initialized", () => {
    const root = newRepository();
    try {
      limen(["init", "--root", root]);
      assert.equal(limen(["init", "--root", root, "--check"]).status, 0);
    } finally {
      cleanup(root);
    }
  });

  test("verify and verify --strict pass on a fresh installation", () => {
    const root = newRepository();
    try {
      limen(["init", "--root", root]);
      assert.equal(limen(["verify", "--root", root]).status, 0);
      assert.equal(limen(["verify", "--root", root, "--strict"]).status, 0);
    } finally {
      cleanup(root);
    }
  });

  test("verify fails when engine code reaches for the browser", () => {
    const root = newRepository();
    try {
      limen(["init", "--root", root]);
      writeFileSync(join(root, "src", "engine", "leak.ts"), "export const t = () => document.title;\n");

      const result = limen(["verify", "--root", root]);

      assert.equal(result.status, 3);
      assert.ok(result.stdout.includes("leak.ts"), "the failing file should be named");
    } finally {
      cleanup(root);
    }
  });

  test("doctor explains a damaged installation and exits 3", () => {
    const root = newRepository();
    try {
      limen(["init", "--root", root]);
      writeFileSync(join(root, ".echelon", "limen.json"), "{ not json");

      const result = limen(["doctor", "--root", root]);

      assert.equal(result.status, 3);
      assert.ok(result.stdout.includes("LIMEN002"));
      assert.ok(result.stdout.includes("fix:"), "doctor should say how to fix it");
    } finally {
      cleanup(root);
    }
  });

  test("upgrade refuses to run where nothing is installed", () => {
    const root = newRepository();
    try {
      assert.equal(limen(["upgrade", "--root", root]).status, 4);
    } finally {
      cleanup(root);
    }
  });

  test("a user-owned configuration survives upgrade", () => {
    const root = newRepository();
    try {
      limen(["init", "--root", root]);
      const custom = '{"configurationVersion":1,"boundary":{"engine":["app/core"],"kernel":["app/web"]}}';
      writeFileSync(join(root, "limen.config.json"), custom);

      assert.equal(limen(["upgrade", "--root", root]).status, 0);
      assert.equal(readFileSync(join(root, "limen.config.json"), "utf8"), custom);
    } finally {
      cleanup(root);
    }
  });

  describe("machine-readable output", () => {
    const assertCleanJson = (result: Run): unknown => {
      assert.doesNotThrow(() => JSON.parse(result.stdout), `stdout was not valid JSON:\n${result.stdout}`);
      return JSON.parse(result.stdout);
    };

    test("status --json emits JSON and nothing else", () => {
      const root = newRepository();
      try {
        limen(["init", "--root", root]);
        const payload = assertCleanJson(limen(["status", "--root", root, "--json"])) as Record<string, unknown>;

        assert.equal(payload.schemaVersion, 1);
        assert.equal(payload.tool, "limen");
        assert.equal(payload.state, "installed");
      } finally {
        cleanup(root);
      }
    });

    test("verify --json reports problems as structured data", () => {
      const root = newRepository();
      try {
        limen(["init", "--root", root]);
        writeFileSync(join(root, "src", "engine", "leak.ts"), "export const t = () => document.title;\n");

        const result = limen(["verify", "--root", root, "--json"]);
        const payload = assertCleanJson(result) as { ok: boolean; problems: { code: string; path: string }[] };

        assert.equal(result.status, 3);
        assert.equal(payload.ok, false);
        assert.ok(payload.problems.some((problem) => problem.code === "LIMEN009"));
        assert.ok(payload.problems.some((problem) => problem.path.endsWith("leak.ts")));
      } finally {
        cleanup(root);
      }
    });

    test("doctor --json and init --dry-run --json are valid JSON", () => {
      const root = newRepository();
      try {
        assertCleanJson(limen(["init", "--root", root, "--dry-run", "--json"]));
        limen(["init", "--root", root]);
        assertCleanJson(limen(["doctor", "--root", root, "--json"]));
        assertCleanJson(limen(["upgrade", "--root", root, "--dry-run", "--json"]));
      } finally {
        cleanup(root);
      }
    });

    test("a failing command still emits parseable JSON, with the message on stderr", () => {
      const root = newRepository();
      try {
        const result = limen(["status", "--root", root, "--json"]);
        assertCleanJson(result);
        assert.equal(result.status, 4);
      } finally {
        cleanup(root);
      }
    });
  });

  test("no command waits for input", () => {
    // An agent running these must never hang on a prompt.
    const root = newRepository();
    try {
      for (const args of [["init"], ["status"], ["verify"], ["doctor"], ["upgrade"]]) {
        const result = spawnSync(process.execPath, [bootstrap, ...args, "--root", root], {
          encoding: "utf8",
          input: "",
          timeout: 30_000,
        });
        assert.notEqual(result.signal, "SIGTERM", `${args[0]} appears to have hung`);
      }
    } finally {
      cleanup(root);
    }
  });
});
