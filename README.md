# kosche-hq/.github

The standard every kosche-hq repository is held to, the script that holds it
there, and the organisation's default community files.

| Part                                              | What                                                                                                                                                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `standard/settings.json`                          | repository settings: private, squash merges only and titled by the pull request, auto-merge, update branch, delete the branch on merge, no wiki or projects                                                 |
| `STANDARD.md`, `standard/gates.json`              | the code standard: every measured gate, its budget, tool and cost, how the per-repository scorecard works, and how a gate becomes a blocker                                                                 |
| `standard/rulesets/`                              | `main is append-only` (no deletion, no force push; held once by the organisation for every repository) and `main takes signed commits only` (per repository; organisation and repository admins can bypass) |
| `tools/apply-repo.mjs`                            | reads a repository, prints what differs from the above and which standard files it lacks; `--apply` changes it                                                                                              |
| `template/`                                       | the files a new repository starts from: CI, Dependabot and Renovate on disjoint managers, CODEOWNERS, the pull request template, SECURITY.md, `.yard/policy.md`, `.nvmrc`                                   |
| `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md` | the organisation's defaults: GitHub shows them in every kosche-hq repository that has none of its own                                                                                                       |

## Running the tool

It needs Node (the version in `.nvmrc`) and nothing else: no install, no
dependencies. The token comes from `GH_TOKEN` only and needs Administration
write on the repository; the tool never prints it.

```sh
GH_TOKEN=... node tools/apply-repo.mjs kosche-hq/<repo>           # what would change
GH_TOKEN=... node tools/apply-repo.mjs kosche-hq/<repo> --apply   # change it
```

A dry run changes nothing. After `--apply`, a second run prints "nothing to
change"; that is the test that the tool is idempotent. The standard files a
repository lacks are reported, never written: they arrive as a pull request.

## Exceptions

A repository that differs from the standard on purpose says so itself, in
`.github/standard-exceptions.json` on its default branch, with a reason for
each difference:

```json
{
  "settings": { "squash_merge_commit_message": "why this repository differs" },
  "rulesets": {
    "main takes signed commits only": "why this repository differs"
  }
}
```

The tool prints each one as `keep`, with its reason, and leaves that setting
or ruleset alone. No file means no exceptions; a file that does not have this
shape stops the run rather than being ignored. Because the exception lives in
the repository it excuses, it is versioned with that repository and changing
it is a pull request like any other.

This repository is its own example: the standard says private, and it is
public, because GitHub reads an organisation's default community files only
from a public repository named `.github`. Its CI runs on GitHub's hosted
runners only.

## A new repository

1. Create it private in kosche-hq.
2. Copy `template/` in, fill in `.yard/policy.md` and the CI's commands, and
   uncomment the Docker block in `dependabot.yml` if it builds an image.
3. Push the first commit, signed.
4. `GH_TOKEN=... node tools/apply-repo.mjs kosche-hq/<repo> --apply`.
5. Register it with yard, the automation that works on kosche-hq
   repositories.

## Why these rules and not more

`main` is append-only, so the history of every default branch stays as it
was pushed. It takes signed commits only, so a commit on it carries a
verified signature: its author's, or GitHub's when GitHub squash-merged a
pull request. Admins can bypass that rule when they have to. Squash merges
titled by the pull request give one commit per change, named for what it
does.

Required reviews, linear history and required status checks are not in the
standard. kosche-hq has one maintainer, and yard merges its own green minor
updates, so a rule that needs a second person would stop everything. Human
review is asked for where it matters instead: CODEOWNERS, and the `protect:`
list in each repository's `.yard/policy.md`, whose paths yard will not land
without the maintainer seeing the change. Revisit when there is a second
maintainer.

Dependabot and Renovate run side by side with a closed list each:
Dependabot takes the ecosystems it knows (npm, github-actions, docker);
Renovate takes only what no Dependabot ecosystem reads (`.nvmrc`, a
`node-version:` in a workflow, a pinned tool version), so the two never open
the same bump. Renovate keeps no Dependency Dashboard (`"dependencyDashboard":
false`, since 2026-10-16): it is an issue that never closes, so it read as
work left open in every repository that had one, and the schedule and the
pull requests are the record of what is pending.
