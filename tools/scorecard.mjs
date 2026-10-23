#!/usr/bin/env node
// The scorecard of one kosche-hq repository against standard/gates.json:
// measures what can be measured from the GitHub API today, marks every other
// gate "unmeasured" (never a pass), and compares with a baseline. It reports
// and never blocks unless --enforce is given, and then only on regressions.
//
//   GH_TOKEN=... node tools/scorecard.mjs kosche-hq/<repo> [--kinds code,site]
//                  [--baseline scorecard.baseline.json] [--out scorecard.json] [--enforce]
//
// Exceptions come from .github/standard-exceptions.json in the repository
// ({ "gates": { "<id>": { "reason": "...", "expires": "YYYY-MM-DD" } } }).
// The token is GH_TOKEN and is never printed. No dependencies.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import {
  applies,
  exceptionFor,
  judgeFor,
  regressions,
  table,
} from "./scorecard-lib.mjs";

const args = process.argv.slice(2);
const repo = args.find((a) => /^[\w.-]+\/[\w.-]+$/.test(a));
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!repo) {
  console.error(
    "usage: scorecard.mjs <owner/repo> [--kinds code,site] [--baseline file] [--out file] [--enforce]",
  );
  process.exit(2);
}
const kinds = (flag("--kinds") ?? "code").split(",");
const token = process.env.GH_TOKEN;
if (!token) {
  console.error("GH_TOKEN is not set");
  process.exit(2);
}
const gates = JSON.parse(
  readFileSync(new URL("../standard/gates.json", import.meta.url), "utf8"),
).gates;

async function api(path) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (res.status === 404 || res.status === 403 || res.status === 451)
    return { unavailable: res.status };
  if (!res.ok) throw new Error(`${path}: HTTP ${String(res.status)}`);
  return res.json();
}
const exists = async (path) => !(await api(`/contents/${path}`)).unavailable;
const read = async (path) => {
  const f = await api(`/contents/${path}`);
  return f.unavailable
    ? null
    : JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
};

const info = await api("");
const exceptions = await read(".github/standard-exceptions.json");
const today = new Date().toISOString().slice(0, 10);
const measured = new Map();

// Each measurer returns { value, note } or null for "cannot know here".
const measurers = {
  async "secret-scanning"() {
    const on =
      info.security_and_analysis?.secret_scanning?.status === "enabled" &&
      info.security_and_analysis?.secret_scanning_push_protection?.status ===
        "enabled";
    if (!on)
      return { value: 1, note: "secret scanning or push protection is off" };
    const alerts = await api("/secret-scanning/alerts?state=open&per_page=100");
    return alerts.unavailable ? null : { value: alerts.length };
  },
  async vulns() {
    const alerts = await api("/dependabot/alerts?state=open&per_page=100");
    if (alerts.unavailable) return null;
    return {
      value: alerts.filter((a) =>
        ["high", "critical"].includes(a.security_advisory?.severity),
      ).length,
    };
  },
  async "code-scanning"() {
    const alerts = await api("/code-scanning/alerts?state=open&per_page=100");
    return alerts.unavailable
      ? { value: 1, note: "code scanning is not available or not set up" }
      : { value: alerts.length };
  },
  async "deps-current"() {
    const has =
      (await exists("renovate.json")) ||
      (await exists(".github/renovate.json")) ||
      (await exists(".github/renovate.json5"));
    return {
      value: has ? 0 : 1,
      note: has
        ? "Renovate configured (currency itself is not measured yet)"
        : "no Renovate configuration",
    };
  },
  async "runtime-lts"() {
    const has = await exists(".nvmrc");
    return {
      value: has ? 0 : 1,
      note: has ? ".nvmrc present (LTS check not measured yet)" : "no .nvmrc",
    };
  },
  async "ci-wall-time"() {
    const runs =
      (
        await api(
          `/actions/runs?branch=${info.default_branch}&status=success&per_page=30`,
        )
      ).workflow_runs ?? [];
    const mins = runs
      .filter((r) => r.event !== "schedule")
      .map((r) => (new Date(r.updated_at) - new Date(r.run_started_at)) / 60000)
      .sort((a, b) => a - b);
    return mins.length
      ? {
          value: Number(mins[Math.floor(mins.length / 2)].toFixed(1)),
          note: "p50 of whole successful runs on the default branch",
        }
      : null;
  },
  async "readme-adr"() {
    return {
      value: (await exists("README.md")) ? 0 : 1,
      note: "README presence only",
    };
  },
};

const results = [];
const problems = [];
for (const gate of gates.filter((g) => applies(g, kinds))) {
  const ex = exceptionFor(exceptions, gate.id, today);
  if (ex.problem) problems.push(ex.problem);
  const m = measurers[gate.id] ? await measurers[gate.id]() : null;
  const value = m?.value ?? null;
  const status = ex.waived ? "waived" : judgeFor(gate, value);
  results.push({
    id: gate.id,
    status,
    value,
    budget: gate.budget,
    note: ex.waived
      ? `waived until ${ex.expires}: ${ex.reason}`
      : (m?.note ?? (measurers[gate.id] ? "" : "not measured yet")),
  });
}

const baselinePath = flag("--baseline");
const baseline = baselinePath
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : undefined;
const regressed = regressions(baseline, results, gates);
const card = {
  repo,
  at: new Date().toISOString(),
  kinds,
  results,
  problems,
  regressions: regressed,
};
writeFileSync(
  flag("--out") ?? "scorecard.json",
  JSON.stringify(card, null, 2) + "\n",
);

const counts = results.reduce(
  (c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }),
  {},
);
const md = `## Scorecard: ${repo}\n\n${Object.entries(counts)
  .map(([k, v]) => `${k} ${String(v)}`)
  .join(
    ", ",
  )}\n\n${table(results)}\n${problems.length ? `Exception problems:\n${problems.map((p) => `- ${p}`).join("\n")}\n\n` : ""}${regressed.length ? `Regressions:\n${regressed.map((p) => `- ${p}`).join("\n")}\n` : "No regressions against the baseline.\n"}`;
process.stdout.write(md);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
if (args.includes("--enforce") && (regressed.length || problems.length))
  process.exit(1);
