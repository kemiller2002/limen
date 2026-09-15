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
/// It pins no version deliberately: a repository that wants to pin one edits
/// the file, and the ownership rules then treat it as locally modified and stop
/// overwriting it.
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

      - name: Verify the Limen boundary
        run: npx --yes @echelon-foundry/typescript-wasm-kernel verify --strict
"""

/// Every tool-owned asset, as (path, content, ownership).
///
/// `init` and `upgrade` both plan from this list, so the two cannot drift.
let managed =
    [ Paths.workflow, workflow, Types.ToolOwned ]
