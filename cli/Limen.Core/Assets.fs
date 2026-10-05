/// The exact content of every file Limen installs.
///
/// These are held as data, not written inline at the point of use, for two
/// reasons: the planner needs the content in order to hash it before deciding
/// whether anything would change, and a test can assert on the bytes without
/// running an installation.
///
/// Nothing here embeds the CLI version. If it did, every release would mark
/// every installed file as changed and turn a routine upgrade into a diff.
module Limen.Core.Assets

/// The CI integration `init` registers.
///
/// It runs the CLI pinned to the version the repository records in its
/// installation manifest (`installedVersion` in `.echelon/limen.json`), read at
/// run time. An unpinned `npx` would float to whatever was published last, and
/// `--strict` would then fail every repository whose installation lags the
/// newest release (LIMEN011) for no change of its own. Reading the pin at run
/// time keeps the version out of this file's content, so a release does not
/// mark every installed copy as changed; `limen upgrade` moves the pin.
let workflow =
    """# Installed and maintained by Limen (@echelon-foundry/typescript-wasm-kernel).
# Edit freely — once changed, `limen upgrade` will stop rewriting it and will
# tell you what the current tool-owned version would have been.
name: Limen verify

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  limen-verify:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Read the Limen version this repository records
        id: limen
        run: echo "version=$(node -p "require('./.echelon/limen.json').installedVersion")" >> "$GITHUB_OUTPUT"

      - name: Verify the Limen boundary with that version
        run: npx --yes "@echelon-foundry/typescript-wasm-kernel@${{ steps.limen.outputs.version }}" verify --strict
"""

/// Every tool-owned asset, as (path, content, ownership).
///
/// `init` and `upgrade` both plan from this list, so the two cannot drift.
let managed =
    [ Paths.workflow, workflow, Types.ToolOwned ]
