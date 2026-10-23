# The code standard

Status: design, for review before any tooling is written. Owner: hygiene.
Source: Daniel, 2026-10-23, permanent: no throwaway code in any product.

Final code is industry-standard in structure, follows each language's and
framework's best practice, is maintainable by a person, is documented, clean,
secure, current and tested in every way that pays, and every part of it is
fast. This file turns that into gates that are measured, so a repository is
either at the bar or shows exactly how far it is.

The prototype rig (concepts) is a separate private repository and is never
imported by a product.

## How it works

1. **`standard/gates.json`** is the machine-readable list: each gate has an
   id, what applies it, the metric, the budget, the tool, its cost and its
   area. This file is the single source; the prose below explains the why.
2. **A scorecard per repository.** A reusable workflow (`scorecard.yml`, in
   this repository, called from each repo's CI) measures every gate that
   applies and writes `scorecard.json` (an artefact and a file on a
   `scorecard` branch) and a page: one row per gate, measured value, budget,
   gap, trend. It starts **measuring without blocking**.
3. **Regressions block, from the first run.** The first run writes the
   repository's baseline. From then a gate may not get worse than its
   baseline, and a gate that reaches its budget is **enforced** from then
   on. A gate is switched from reporting to enforcing one at a time, cheapest
   first (the `cost` field), so a new repository is never red on day one and
   the gate is never switched off to get work done.
4. **Exceptions** use the mechanism this repository already has: the
   repository's own `.github/standard-exceptions.json`, with a reason for each
   gate and an expiry date. An exception without a reason or past its expiry
   fails the scorecard. A budget that needs a per-app number (bundle, p95,
   memory, test time) is set in the repository's `.github/scorecard.json`,
   reviewed like code.
5. **Order of the gap pull requests**, per repository: security, then
   correctness, then speed, then polish (the `area` field). Small pull
   requests, one gate each.

## The gates, and why

- **Correctness.** Zero lint warnings and strict types: a warning that is
  tolerated is a warning nobody reads. Mutation testing on the merge-deciding
  code only (the loop, the planner, the shots comparison), nightly: it is
  slow, and it is the one measure of whether the tests would notice a wrong
  decision. Accessibility (axe, WCAG 2.2 AA, zero violations) is correctness,
  not polish.
- **Security.** No known high or critical vulnerability, no open secret
  alert (push protection on), CodeQL and Semgrep clean, dependencies current
  (nothing more than one minor behind without a written reason; Renovate does
  the work), runtimes on the current LTS, licences inside an allowed list. For
  sites: Mozilla Observatory A+, a strict CSP without `unsafe-inline`, SSL Labs
  A+, HSTS preload. For releases: an SBOM and signed artefacts with
  provenance. SLSA level 3 is the target; self-hosted runners reach level 2, so
  level 3 is reached where a release can be built by a hardened reusable
  workflow on a hosted builder, and the scorecard says which level it
  measured.
- **Speed.** CI under 10 minutes wall on a pull request; a time budget for each
  repository's unit suite; bundle and API latency (p95) and memory budgets per
  app; Core Web Vitals on a mid phone (LCP under 1.2 s, INP under 100 ms, CLS
  under 0.05). Tests are as fast as they can be, because a slow suite is
  skipped in spirit.
- **Polish.** Lighthouse 100 in all four categories on every public page, on
  mobile and on desktop; docs build without broken links; a README per package
  and an ADR for each decision that was a choice.

## What is measured where

| Where                                     | What                                                                                                                            | How often                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Pull request, required                    | lint, types, tests, vulnerabilities, secrets, licences, bundle size, CI wall time                                               | every push                     |
| Pull request, informational then required | axe and Lighthouse on the preview deploy                                                                                        | every push that touches a page |
| Nightly                                   | CodeQL/Semgrep deep scan, mutation score, Observatory and SSL Labs on production, p95 and memory from OTLP, dependency currency | daily                          |
| Release                                   | SBOM, provenance, signature verification                                                                                        | every release                  |

Observatory and SSL Labs are third-party services that receive the site's
hostname: they are run only against public production pages.

## Rollout (each step a small pull request)

1. This design, reviewed blind.
2. `scorecard.yml` and `tools/scorecard.mjs`, measuring the cheap gates only
   (lint, types, CI time, secrets, vulnerabilities, dependency currency),
   reporting, on yard first; then every repository.
3. Gates become blockers one at a time, cheapest first: zero lint warnings,
   strict types, CI wall time, secret scanning, Renovate currency.
4. axe and Lighthouse, with polish's design loop; headers and TLS with house
   and platform; SBOM and provenance with the release workflow.
5. atlas' shared-rules drift check carries this standard into every
   repository's agent rules.

## Decisions (lead, 2026-10-23 12:06, within Daniel's words; he may overrule)

- **Third-party scanners.** Mozilla Observatory and SSL Labs run against public
  production pages only, never gated or staging hosts.
- **Latency and memory data.** ClickHouse (read-only user) for the bench, OTLP
  for everything else. The internals track owns the dashboards (the Brain and
  Internals rooms); atlas reads them for the brain baseline.
- **Lighthouse 100 in four categories.** The page changes (subset and preload
  fonts, motion that respects reduced motion, kit fixes). A written exception
  needs Daniel's yes per page and an expiry, never by default.
- **SLSA.** Level 2 now, everywhere. Release builds move to GitHub-hosted
  runners (in the release workflow) so releases reach level 3; self-hosted
  runners stay for CI.
- **CI under 10 minutes** is wall clock, not runner minutes, and is met with
  more shards (5 to 6 for yard's `shots`), never with fewer pictures.
