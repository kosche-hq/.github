#!/usr/bin/env node
// Hold one kosche-hq repository to the standard in ../standard: its merge
// settings, Dependabot's security switches, and the two rulesets on main.
// Reads first and prints what differs; changes nothing without --apply. A
// second --apply prints "nothing to change", which is the test that it is
// idempotent. Also reports, without touching, which of the standard files
// the repository lacks: those arrive as a pull request, not through the API.
//
//   GH_TOKEN=... node tools/apply-repo.mjs kosche-hq/<repo>            # what would change
//   GH_TOKEN=... node tools/apply-repo.mjs kosche-hq/<repo> --apply    # change it
//
// The token is GH_TOKEN and nothing else. It needs Administration write on
// the repository. Never printed.
//
// Where a repository is deliberately not the standard, it says so itself, in
// .github/standard-exceptions.json on its default branch:
//
//   { "settings": { "<setting>": "why" }, "rulesets": { "<ruleset name>": "why" } }
//
// A setting or ruleset named there is reported with its reason and left
// alone. No file means no exceptions.
//
// No dependencies: fetch and node:fs.
import { readFileSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
const apply = args.includes("--apply");
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error("usage: apply-repo.mjs <owner/repo> [--apply]");
  process.exit(2);
}

const token = process.env.GH_TOKEN?.trim();
if (!token) {
  console.error("apply-repo.mjs: set GH_TOKEN to a GitHub token with Administration write on the repository");
  process.exit(2);
}
const standard = new URL("../standard/", import.meta.url);
const settings = JSON.parse(readFileSync(new URL("settings.json", standard), "utf8"));
const rulesets = readdirSync(new URL("rulesets/", standard))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(new URL(`rulesets/${f}`, standard), "utf8")));

async function gh(method, path, body) {
  const response = await fetch(`https://api.github.com/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

async function must(method, path, body) {
  const result = await gh(method, path, body);
  if (result.status >= 400) {
    throw new Error(`${method} ${path}: ${result.status} ${result.data?.message ?? ""}`);
  }
  return result.data;
}

const changes = [];
const step = async (label, fn) => {
  changes.push(label);
  console.log(`${apply ? "change" : "would "} ${label}`);
  if (apply) await fn();
};

// Settings

const current = await must("GET", `repos/${repo}`);
if (current.archived) {
  console.log(`${repo} is archived; the standard does not apply`);
  process.exit(0);
}

// The repository's own exceptions, read from its default branch. A file that
// is there but malformed stops the run: silently ignoring it would undo the
// exception it meant to keep.
const exceptionsFile = ".github/standard-exceptions.json";
const exceptions = await (async () => {
  const found = await gh("GET", `repos/${repo}/contents/${exceptionsFile}`);
  if (found.status === 404) return {};
  if (found.status >= 400) throw new Error(`GET ${exceptionsFile}: ${found.status} ${found.data?.message ?? ""}`);
  if (found.data?.encoding !== "base64") throw new Error(`${repo}: ${exceptionsFile} is not a file the contents API returns inline`);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(found.data.content, "base64").toString("utf8"));
  } catch (error) {
    throw new Error(`${repo}: ${exceptionsFile} is not valid JSON: ${error.message}`);
  }
  const reasons = (v) => v === undefined || (v !== null && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((why) => typeof why === "string" && why.trim() !== ""));
  const shaped =
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    Object.keys(parsed).every((k) => k === "settings" || k === "rulesets") &&
    reasons(parsed.settings) &&
    reasons(parsed.rulesets);
  if (!shaped) throw new Error(`${repo}: ${exceptionsFile} must be { "settings": { name: why }, "rulesets": { name: why } }, every why a non-empty string`);
  return parsed;
})();

const patch = {};
for (const [key, want] of Object.entries(settings)) {
  if (current[key] === want) continue;
  const why = exceptions.settings?.[key];
  if (why) console.log(`keep   ${key} ${JSON.stringify(current[key])}: ${why}`);
  else patch[key] = want;
}
if (Object.keys(patch).length > 0) {
  const what = Object.entries(patch)
    .map(([k, v]) => `${k} ${JSON.stringify(current[k])} -> ${JSON.stringify(v)}`)
    .join(", ");
  await step(`settings: ${what}`, () => must("PATCH", `repos/${repo}`, patch));
}

// Dependabot: the alerts, then the security pull requests (which need them).

const alerts = await gh("GET", `repos/${repo}/vulnerability-alerts`);
if (alerts.status !== 204) {
  await step("vulnerability alerts: off -> on", () => must("PUT", `repos/${repo}/vulnerability-alerts`));
}
const fixes = await gh("GET", `repos/${repo}/automated-security-fixes`);
if (fixes.data?.enabled !== true) {
  await step("Dependabot security updates: off -> on", () => must("PUT", `repos/${repo}/automated-security-fixes`));
}

// Rulesets, matched by exact name. Rulesets the standard does not name are
// left alone: a repository may hold more than the standard. A ruleset the
// organisation already holds under that name ("main is append-only" is one,
// since 2026-09) covers every repository and is not copied into this one.

const normal = (r) =>
  JSON.stringify({
    target: r.target,
    enforcement: r.enforcement,
    conditions: { ref_name: { include: r.conditions?.ref_name?.include ?? [], exclude: r.conditions?.ref_name?.exclude ?? [] } },
    rules: (r.rules ?? []).map((rule) => ({ type: rule.type, parameters: rule.parameters ?? null })).sort((a, b) => a.type.localeCompare(b.type)),
    bypass: (r.bypass_actors ?? [])
      .map((a) => `${a.actor_type}:${a.actor_type === "OrganizationAdmin" ? "" : a.actor_id}:${a.bypass_mode}`)
      .sort(),
  });

const existing = await must("GET", `repos/${repo}/rulesets?includes_parents=true`);
for (const want of rulesets) {
  if (existing.some((r) => r.name === want.name && r.source_type === "Organization")) continue;
  const matches = existing.filter((r) => r.name === want.name);
  if (matches.length > 1) throw new Error(`${repo} has ${matches.length} rulesets named "${want.name}"; fix by hand`);
  if (matches.length === 0) {
    await step(`ruleset "${want.name}": create`, () => must("POST", `repos/${repo}/rulesets`, want));
    continue;
  }
  const have = await must("GET", `repos/${repo}/rulesets/${matches[0].id}`);
  const why = exceptions.rulesets?.[want.name];
  if (normal(have) !== normal(want) && why) console.log(`keep   ruleset "${want.name}": ${why}`);
  else if (normal(have) !== normal(want)) {
    await step(`ruleset "${want.name}": update`, () => must("PUT", `repos/${repo}/rulesets/${matches[0].id}`, want));
  }
}

// The files, reported only.

const files = [
  ".github/dependabot.yml",
  ".github/renovate.json",
  ".github/CODEOWNERS",
  ".github/PULL_REQUEST_TEMPLATE.md",
  ".yard/policy.md",
  "SECURITY.md",
  "README.md",
];
// Every other place GitHub or Renovate reads the same file from. Any one
// counts, and a second copy would be worse than none: a .github/CODEOWNERS
// silently overrides a root one.
const alternatives = {
  ".github/renovate.json": ["renovate.json", ".renovaterc.json"],
  ".github/CODEOWNERS": ["CODEOWNERS", "docs/CODEOWNERS"],
  ".github/PULL_REQUEST_TEMPLATE.md": [".github/pull_request_template.md", "pull_request_template.md", "docs/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE"],
  "SECURITY.md": [".github/SECURITY.md", "docs/SECURITY.md"],
};
const missing = [];
for (const file of files) {
  let found = false;
  for (const candidate of [file, ...(alternatives[file] ?? [])]) {
    if ((await gh("GET", `repos/${repo}/contents/${candidate}`)).status !== 404) {
      found = true;
      break;
    }
  }
  if (!found) missing.push(file);
}
const workflows = await gh("GET", `repos/${repo}/contents/.github/workflows`);
if (workflows.status === 404 || !Array.isArray(workflows.data) || workflows.data.length === 0) missing.push(".github/workflows/");

if (changes.length === 0) console.log(`${repo}: nothing to change`);
else if (!apply) console.log(`${repo}: ${changes.length} to change; run again with --apply`);
if (missing.length > 0) console.log(`${repo}: files the standard expects and the repository lacks: ${missing.join(", ")}`);
