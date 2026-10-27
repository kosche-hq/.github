import assert from "node:assert/strict";
import { test } from "node:test";
import { botContext, botEvents, evaluate, lintWorkflow } from "./workflow-lint-lib.mjs";

const job = (runsOn, extra = {}) => ({ jobs: { check: { "runs-on": runsOn, ...extra } } });
const pr = { pull_request: null };

// The template's and listentomac's expression: bots and forks go hosted.
const ROUTED =
  "${{ (github.event.pull_request.head.repo.fork == true || github.event.pull_request.user.type == 'Bot' || github.actor == 'dependabot[bot]' || github.actor == 'renovate[bot]') && 'ubuntu-latest' || vars.CI_RUNNER || 'ubuntu-latest' }}";

test("hosted and the ephemeral label are a bot's runners", () => {
  assert.deepEqual(lintWorkflow(job("ubuntu-latest"), pr), []);
  assert.deepEqual(lintWorkflow(job("kosche-ci-ephemeral"), pr), []);
  assert.deepEqual(lintWorkflow(job(["kosche-ci-ephemeral"]), pr), []);
});

test("any other self-hosted label is refused", () => {
  assert.equal(lintWorkflow(job("kosche-ci"), pr).length, 2);
  assert.match(lintWorkflow(job("kosche-ci-x64"), pr)[0], /"kosche-ci-x64"/);
  assert.equal(lintWorkflow(job(["self-hosted", "linux"]), pr).length, 2);
  assert.match(lintWorkflow(job({ group: "bays" }), pr)[0], /runner group "bays"/);
  assert.equal(lintWorkflow(job([]), pr).length, 2);
});

test("an organisation variable counts as set to a self-hosted label", () => {
  assert.match(lintWorkflow(job("${{ vars.CI_RUNNER || 'ubuntu-latest' }}"), pr)[0], /"vars.CI_RUNNER"/);
  assert.deepEqual(lintWorkflow(job(ROUTED), pr), []);
  assert.deepEqual(lintWorkflow(job(ROUTED), { push: { branches: ["**"] } }), []);
});

test("a routing that forgets one bot is caught for that bot only", () => {
  const onlyDependabot = "${{ github.actor == 'dependabot[bot]' && 'ubuntu-latest' || vars.CI_RUNNER || 'ubuntu-latest' }}";
  const problems = lintWorkflow(job(onlyDependabot), { push: null });
  assert.deepEqual(problems, ['job check, push by renovate[bot]: runs on "vars.CI_RUNNER"']);
});

test("what the lint cannot work out fails", () => {
  assert.match(lintWorkflow(job("${{ matrix.os }}"), pr)[0], /cannot work out/);
  assert.match(lintWorkflow(job("${{ github.event.workflow_run.head_branch }}"), pr)[0], /cannot work out/);
  assert.match(lintWorkflow(job("kosche-${{ vars.X }}"), pr)[0], /cannot work out/);
  assert.match(lintWorkflow(job("${{ github.actor == }}"), pr)[0], /ends early/);
});

test("a job a bot cannot start is not a bot's job", () => {
  assert.deepEqual(lintWorkflow(job("kosche-ci", { if: "github.actor != 'dependabot[bot]' && github.actor != 'renovate[bot]'" }), pr), []);
  assert.deepEqual(lintWorkflow(job("kosche-ci", { if: "${{ github.event.pull_request.user.type != 'Bot' }}" }), pr), []);
  assert.equal(lintWorkflow(job("kosche-ci", { if: "github.actor != 'dependabot[bot]'" }), pr).length, 1);
  assert.equal(lintWorkflow(job("kosche-ci", { if: "contains(github.ref, 'x')" }), pr).length, 2);
  assert.deepEqual(lintWorkflow({ jobs: { call: { uses: "o/r/.github/workflows/x.yml@main" } } }, pr), []);
});

test("only events that carry a bot's code are checked", () => {
  assert.deepEqual(botEvents("pull_request"), ["pull_request"]);
  assert.deepEqual(botEvents(["push", "schedule", "workflow_dispatch"]), ["push"]);
  assert.deepEqual(botEvents({ push: { branches: ["main"] }, schedule: [{ cron: "0 0 * * *" }] }), []);
  assert.deepEqual(botEvents({ push: { tags: ["v*"] } }), []);
  assert.deepEqual(botEvents({ push: { branches: ["main", "renovate/**"] } }), ["push"]);
  assert.deepEqual(botEvents({ workflow_run: { workflows: ["CI"], branches: ["main"] } }), []);
  assert.deepEqual(botEvents({ workflow_run: { workflows: ["CI"] } }), ["workflow_run"]);
  assert.deepEqual(botEvents({ pull_request_target: null, merge_group: null }), ["pull_request_target", "merge_group"]);
  assert.deepEqual(lintWorkflow(job("kosche-ci"), { push: { branches: ["main"] }, workflow_dispatch: null }), []);
});

test("expressions: GitHub's ||, &&, !, == and quoting", () => {
  const g = botContext("renovate[bot]", "pull_request");
  assert.deepEqual(evaluate("github.actor == 'RENOVATE[BOT]'", g), [true]);
  assert.deepEqual(evaluate("!(github.actor != 'renovate[bot]')", g), [true]);
  assert.deepEqual(evaluate("'' || 'a'", g), ["a"]);
  assert.deepEqual(evaluate("'it''s'", g), ["it's"]);
  assert.deepEqual(evaluate("null && 'a'", g), [null]);
  assert.deepEqual(evaluate("github.event.pull_request.head.repo.fork", g), [false]);
  assert.deepEqual(evaluate("github.event.pull_request.user.login", botContext("renovate[bot]", "push")), [null]);
  assert.deepEqual(evaluate("vars.R || 'b'", g), ["b", "vars.R"]);
});

test("a workflow_run carries a bot's code only when it reads the triggering head", () => {
  const run = { workflow_run: { workflows: ["CI"] } };
  assert.deepEqual(lintWorkflow(job("kosche-ci"), run), []);
  const checksOutHead = job("kosche-ci", {
    steps: [{ uses: "actions/checkout@v7", with: { ref: "${{ github.event.workflow_run.head_sha }}" } }],
  });
  assert.equal(lintWorkflow(checksOutHead, run).length, 2);
});
