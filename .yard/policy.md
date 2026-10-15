---
lanes: [ci, deps, alerts, inbox]
autoMerge: green-minor
concurrency: 1
protect:
  - standard/
  - tools/
  - template/.github/
  - .github/
  - .yard/policy.md
  - SECURITY.md
  - README.md
---

# kosche-hq/.github

The settings, rulesets and template files every kosche-hq repository is held
to, and the organisation's default community files (SECURITY.md and the pull
request template, which GitHub shows in every repository without its own).
A change to `standard/` or `tools/` changes what protects every repository,
and a change to SECURITY.md or the pull request template changes every
repository's defaults, so they wait for Daniel.

## Checks

`node --check tools/apply-repo.mjs`; every JSON file parses; every
`.github/standard-exceptions.json` has the shape the tool reads; no em
dashes; and a dry run of `tools/apply-repo.mjs` (token in `GH_TOKEN`)
against kosche-hq/kosche and kosche-hq/mime-inspector prints "nothing to
change" (they are the reference).

## What to be careful with

This repository is public: whatever lands here is published. No token, key
or path to one, no machine-specific path, no name of an internal secret, and
no exception that belongs to another repository. A repository's exceptions
live in that repository's own `.github/standard-exceptions.json`.
