---
lanes: [ci, deps, alerts, inbox]
autoMerge: green-minor
concurrency: 1
protect:
  - .github/
  - .yard/policy.md
---

# <repository>

What this repository is, in two sentences, for an agent that has never seen
it.

## Checks

The commands that must pass before anything lands.

## What to be careful with

The things a well-meaning change breaks.
