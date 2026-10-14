// Playwright reporter: records each finished test's annotations and outcome,
// then writes test-results/evidence.json via buildEvidence.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEvidence, totals } from "./evidence.mjs";

const OUTPUT = fileURLToPath(new URL("./test-results/evidence.json", import.meta.url));

const revision = () => process.env.UI_CONFORMANCE_REVISION
  || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

export default class EvidenceReporter {
  results = [];

  onTestEnd(test, result) {
    this.results = [...this.results, {
      title: test.titlePath().slice(1).join(" > "),
      location: `${relative(process.cwd(), test.location.file)}:${test.location.line}`,
      status: result.status,
      annotations: test.annotations.filter(annotation => annotation.type.startsWith("uli-"))
    }];
  }

  onEnd() {
    const evidence = buildEvidence({ results: this.results, revision: revision(), repository: "kemiller2002/limen" });
    mkdirSync(dirname(OUTPUT), { recursive: true });
    writeFileSync(OUTPUT, `${JSON.stringify(evidence, null, 2)}\n`);
    process.stdout.write(`UI conformance evidence: ${relative(process.cwd(), OUTPUT)} ${JSON.stringify(totals(evidence))}\n`);
  }
}
