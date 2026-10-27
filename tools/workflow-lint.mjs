#!/usr/bin/env node
// Fail when a workflow lets renovate's or dependabot's code onto a
// self-hosted runner other than kosche-ci-ephemeral (the rule and how it is
// proved: tools/workflow-lint-lib.mjs).
//
//   node tools/workflow-lint.mjs [<repository root>]    # default: .
//
// Reads every .yml and .yaml in <root>/.github/workflows. Node has no YAML
// reader and this repository has no dependencies, so Ruby's (in every
// GitHub-hosted image and on macOS) turns each file into JSON first.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { lintWorkflow } from "./workflow-lint-lib.mjs";

const root = process.argv[2] ?? ".";

function read(path) {
  const json = execFileSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: true))", path],
    { encoding: "utf8" },
  );
  return JSON.parse(json);
}

// A local reusable workflow, by its path from the root; only one under
// .github/workflows, where GitHub looks for it.
function load(rel) {
  if (!/^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(rel)) return null;
  const path = join(root, rel);
  return existsSync(path) ? read(path) : null;
}
const dir = join(root, ".github", "workflows");
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => /\.ya?ml$/.test(f))
      .sort()
  : [];

let failed = 0;
for (const file of files) {
  const path = join(dir, file);
  const workflow = read(path);
  // YAML 1.1 reads the key `on` as the boolean true.
  const on = workflow?.on ?? workflow?.true;
  for (const problem of lintWorkflow(workflow, on, load)) {
    console.error(`${path}: ${problem}`);
    failed++;
  }
}
if (failed > 0) {
  console.error(
    `${failed} way(s) for a bot's code onto a self-hosted runner. A bot's job runs on GitHub's hosted runners or on kosche-ci-ephemeral (tools/workflow-lint-lib.mjs).`,
  );
  process.exit(1);
}
console.log(`workflow lint: ${files.length} workflow(s), no bot on a self-hosted runner`);
