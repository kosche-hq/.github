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

test("an organisation variable can hold anything", () => {
  assert.match(lintWorkflow(job("${{ vars.CI_RUNNER || 'ubuntu-latest' }}"), pr)[0], /cannot work out/);
  // Finding 3: a variable in a comparison is no fixed string either.
  assert.equal(lintWorkflow(job("${{ vars.HOSTED == 'yes' && 'ubuntu-latest' || 'kosche-ci' }}"), pr).length, 2);
  assert.equal(lintWorkflow(job("kosche-ci", { if: "vars.BOTS_ALLOWED == 'yes'" }), pr).length, 2);
  assert.deepEqual(lintWorkflow(job(ROUTED), pr), []);
  // A push has no pull request author, and its actor may be a person who
  // clicked "Update branch" on a bot's pull request: the routing cannot tell.
  assert.equal(lintWorkflow(job(ROUTED), { push: { branches: ["**"] } }).length, 2);
});

test("a routing that forgets one bot is caught for that bot only", () => {
  const onlyDependabot =
    "${{ github.event.pull_request.user.login == 'dependabot[bot]' && 'ubuntu-latest' || vars.CI_RUNNER || 'ubuntu-latest' }}";
  const problems = lintWorkflow(job(onlyDependabot), pr);
  assert.deepEqual(problems, ["job check, pull_request by renovate[bot]: runs on a runner the lint cannot work out"]);
});

test("what the lint cannot work out fails", () => {
  assert.match(lintWorkflow(job("${{ matrix.os }}"), pr)[0], /cannot work out/);
  assert.match(lintWorkflow(job("${{ github.event.workflow_run.head_branch }}"), pr)[0], /cannot work out/);
  assert.match(lintWorkflow(job("kosche-${{ vars.X }}"), pr)[0], /cannot work out/);
  assert.match(lintWorkflow(job("${{ github.actor == }}"), pr)[0], /ends early/);
});

test("a job a bot cannot start is not a bot's job", () => {
  const notBots = "github.event.pull_request.user.login != 'dependabot[bot]' && github.event.pull_request.user.login != 'renovate[bot]'";
  assert.deepEqual(lintWorkflow(job("kosche-ci", { if: notBots }), pr), []);
  assert.deepEqual(lintWorkflow(job("kosche-ci", { if: "${{ github.event.pull_request.user.type != 'Bot' }}" }), pr), []);
  assert.equal(lintWorkflow(job("kosche-ci", { if: "github.event.pull_request.user.login != 'dependabot[bot]'" }), pr).length, 1);
  assert.equal(lintWorkflow(job("kosche-ci", { if: "contains(github.ref, 'x')" }), pr).length, 2);
});

test("a bot picks its branch, so a branch name proves nothing", () => {
  // Finding 2: renovate's branchPrefix and a bot's head_ref are the bot's choice.
  const byBranch = "${{ startsWith(github.head_ref, 'renovate/') && 'ubuntu-latest' || 'kosche-ci' }}";
  assert.equal(lintWorkflow(job(byBranch), pr).length, 2);
  const byRef = "${{ github.head_ref == 'renovate/x' && 'ubuntu-latest' || 'kosche-ci' }}";
  assert.equal(lintWorkflow(job(byRef), pr).length, 2);
  assert.equal(lintWorkflow(job("kosche-ci", { if: "github.ref_name == 'main'" }), { push: null }).length, 2);
  assert.equal(lintWorkflow(job("kosche-ci", { if: "github.event.pull_request.base.ref == 'x'" }), pr).length, 2);
});

test("GitHub's loose == is followed, and the fork flag is not known", () => {
  // Finding 5: fork == 0 is true for a non-fork, and fork is not the bot's.
  assert.equal(lintWorkflow(job("${{ github.event.pull_request.head.repo.fork == 0 && 'kosche-ci' || 'ubuntu-latest' }}"), pr).length, 2);
  const g = botContext("renovate[bot]", "push");
  assert.deepEqual(evaluate("github.event.pull_request == 0", g), [true]);
  assert.deepEqual(evaluate("true == 1", g), [true]);
  assert.deepEqual(evaluate("'' == false", g), [true]);
  assert.deepEqual(evaluate("'1' == 1", g), [true]);
  assert.deepEqual(evaluate("'a' == 0", g), [false]);
  assert.deepEqual(evaluate("null == false", g), [true]);
});

test("bracket access reads the same context as a dot", () => {
  // Finding 4: github['event']['workflow_run'] is no way around the lint.
  const run = { workflow_run: { workflows: ["CI"] } };
  assert.equal(lintWorkflow(job("kosche-ci", { if: "github.event['workflow_run']['head_sha'] != ''" }), run).length, 2);
  assert.deepEqual(evaluate("github['event_name']", botContext("renovate[bot]", "push")), ["push"]);
  assert.equal(lintWorkflow(job("${{ github.event.labels[0] && 'ubuntu-latest' || 'kosche-ci' }}"), pr).length, 2);
});

test("a reusable workflow is its jobs", () => {
  // Finding 1: a call hid a self-hosted callee.
  const caller = { jobs: { call: { uses: "./.github/workflows/build.yml" } } };
  const callee = { on: { workflow_call: null }, jobs: { build: { "runs-on": "kosche-ci" } } };
  const load = (rel) => (rel === ".github/workflows/build.yml" ? callee : null);
  assert.deepEqual(lintWorkflow(caller, pr, load), [
    'job call > ./.github/workflows/build.yml job build, pull_request by dependabot[bot]: runs on "kosche-ci"',
    'job call > ./.github/workflows/build.yml job build, pull_request by renovate[bot]: runs on "kosche-ci"',
  ]);
  assert.match(lintWorkflow({ jobs: { call: { uses: "./.github/workflows/x.yml" } } }, pr)[0], /cannot read the called workflow/);
  // Another repository's workflow cannot be seen; this repository's own is linted here.
  assert.equal(lintWorkflow({ jobs: { call: { uses: "o/r/.github/workflows/x.yml@main" } } }, pr).length, 2);
  assert.equal(lintWorkflow({ jobs: { call: { uses: "kosche-hq/.github/.github/workflows/x.yml@v1" } } }, pr).length, 2);
  assert.deepEqual(lintWorkflow({ jobs: { call: { uses: "kosche-hq/.github/.github/workflows/workflow-lint.yml@main" } } }, pr), []);
  // A workflow others call is checked as if a bot's run called it.
  assert.equal(lintWorkflow(callee, callee.on).length, 10);
  const loop = { jobs: { again: { uses: "./.github/workflows/loop.yml" } } };
  assert.deepEqual(lintWorkflow(loop, pr, () => loop), []);
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
  assert.deepEqual(evaluate("github.event.pull_request.user.login == 'RENOVATE[BOT]'", g), [true]);
  assert.deepEqual(evaluate("!(github.event.pull_request.user.login != 'renovate[bot]')", g), [true]);
  assert.deepEqual(evaluate("'' || 'a'", g), ["a"]);
  assert.deepEqual(evaluate("'it''s'", g), ["it's"]);
  assert.deepEqual(evaluate("null && 'a'", g), [null]);
  assert.deepEqual(evaluate("github.event.pull_request.head.repo.fork", g).length, 1);
  assert.equal(typeof evaluate("github.event.pull_request.head.repo.fork", g)[0], "symbol");
  assert.deepEqual(evaluate("github.event.pull_request.user.login", botContext("renovate[bot]", "push")), [null]);
  assert.equal(evaluate("vars.R || 'b'", g).length, 2);
});

test("a workflow_run a bot's run can trigger is a bot's", () => {
  assert.equal(lintWorkflow(job("kosche-ci"), { workflow_run: { workflows: ["CI"] } }).length, 2);
  assert.deepEqual(lintWorkflow(job("kosche-ci"), { workflow_run: { workflows: ["CI"], branches: ["main"] } }), []);
});

test("a reusable workflow is checked under every event a caller can have", () => {
  // .github#3 at 0cdc859: the callee keeps its caller's event, whichever it is.
  for (const event of ["pull_request", "pull_request_target", "merge_group", "push", "workflow_run"]) {
    const callee = { on: { workflow_call: null }, jobs: { build: { if: `github.event_name == '${event}'`, "runs-on": "kosche-ci" } } };
    assert.equal(lintWorkflow(callee, callee.on).length, 2, event);
  }
});

test("the actor is whoever set the run off, not whose code it carries", () => {
  // A person labels, reopens or enqueues a bot's pull request: the run has
  // the bot's code and that person as its actor.
  const notBots = "github.actor != 'dependabot[bot]' && github.actor != 'renovate[bot]'";
  for (const on of [pr, { pull_request_target: null }, { merge_group: null }, { push: null }, { workflow_run: { workflows: ["CI"] } }]) {
    assert.equal(lintWorkflow(job("kosche-ci", { if: notBots }), on).length, 2, Object.keys(on)[0]);
  }
});
