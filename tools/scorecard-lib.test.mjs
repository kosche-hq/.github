import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applies,
  exceptionFor,
  judgeFor,
  regressions,
  table,
} from "./scorecard-lib.mjs";

const lint = { id: "lint-warnings", budget: 0 };
const lh = { id: "lighthouse", budget: 100 };

test("lower is better, except for scores and levels", () => {
  assert.equal(judgeFor(lint, 0), "pass");
  assert.equal(judgeFor(lint, 3), "fail");
  assert.equal(judgeFor(lh, 100), "pass");
  assert.equal(judgeFor(lh, 97), "fail");
  assert.equal(judgeFor(lint, null), "unmeasured");
});

test("an exception needs a reason and an unexpired date", () => {
  const ex = {
    gates: {
      a: { reason: "fonts", expires: "2026-12-01" },
      b: { reason: "", expires: "2026-12-01" },
      c: { reason: "x" },
      d: { reason: "x", expires: "2026-01-01" },
    },
  };
  assert.deepEqual(exceptionFor(ex, "a", "2026-10-23"), {
    waived: true,
    reason: "fonts",
    expires: "2026-12-01",
  });
  for (const id of ["b", "c", "d"]) {
    const r = exceptionFor(ex, id, "2026-10-23");
    assert.equal(r.waived, false);
    assert.match(r.problem, new RegExp(`^${id}:`));
  }
  assert.deepEqual(exceptionFor(ex, "zzz", "2026-10-23"), { waived: false });
  assert.deepEqual(exceptionFor(undefined, "a", "2026-10-23"), {
    waived: false,
  });
});

test("a regression is a pass that fails, or a number that got worse in its own direction", () => {
  const gates = [lint, lh, { id: "ci-wall-time", budget: 10 }];
  const baseline = {
    results: [
      { id: "lint-warnings", status: "pass", value: 0 },
      { id: "lighthouse", status: "fail", value: 90 },
      { id: "ci-wall-time", status: "fail", value: 20 },
    ],
  };
  const now = [
    { id: "lint-warnings", status: "fail", value: 2 },
    { id: "lighthouse", status: "fail", value: 85 },
    { id: "ci-wall-time", status: "fail", value: 15 },
  ];
  assert.deepEqual(regressions(baseline, now, gates), [
    "lint-warnings: passed, now fails (2)",
    "lighthouse: 90 -> 85",
  ]);
  assert.deepEqual(regressions(undefined, now, gates), []);
  assert.deepEqual(
    regressions(
      baseline,
      [{ id: "lint-warnings", status: "unmeasured", value: null }],
      gates,
    ),
    [],
  );
});

test("a gate applies by kind", () => {
  assert.equal(applies({ applies: "all" }, []), true);
  assert.equal(applies({ applies: "site" }, ["code"]), false);
  assert.equal(applies({ applies: "site" }, ["code", "site"]), true);
});

test("the table has a row per result", () => {
  assert.equal(
    table([{ id: "a", status: "pass", value: 0, budget: 0 }])
      .trim()
      .split("\n").length,
    3,
  );
});
