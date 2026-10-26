# Migration Runbook — CNB-Primary (AiringCal, Issue #139)

Operational companion to `adr-0002-cnb-primary-migration.md`.

## Current-state snapshot (verified 2026-10-26)

| Ref | Platform | SHA | Verified via |
| --- | --- | --- | --- |
| `dev` | GitHub | `72ebdcf422e4f4e50dbb03dc9aef449a2cfcfc48` | `git ls-remote origin` |
| `dev` | CNB | `72ebdcf422e4f4e50dbb03dc9aef449a2cfcfc48` | `git ls-remote cnb` + API `get-branch` |
| `main` | GitHub | `a4b3b082d15943e11a2d5443077f9ab5f3c175dc` | `git ls-remote origin` |
| `main` | CNB | `a4b3b082d15943e11a2d5443077f9ab5f3c175dc` | pushed M1 + API read-back |
| tags | both | none | `git ls-remote --tags` (0), GH API `[]` |
| PRs | CNB | #1 (review pilot, open), #2 (NPC AutoFix, open) | API — preserve as evidence |
| default branch | CNB | `dev` | `git get-head` |
| protections | CNB AiringCal | none configured | `git-settings list` — needs repo-manage:rw |
| protections | CNB control repo | `main` PR-required | owner-configured |
| GitHub Ruleset | `protect-dev-main` | PR required on dev+main | active, unchanged |

`main` is an ancestor of `dev` on GitHub: 138 commits ahead (re-verified:
`git rev-list --count main..dev` = 138). CNB `dev` == GitHub `dev` exactly.

## Daily development (CNB-native)

```sh
git fetch cnb dev && git checkout -b feat/<topic> refs/remotes/cnb/dev
# work, commit...
git push cnb HEAD:refs/heads/feat/<topic>
cnb pulls post-pull --repo KoolingMachine/AiringCal \
  --base dev --head feat/<topic> --title '...' --body '...'
# AI review runs automatically on CNB PR (pilot config on dev)
# NPC fix: comment @CodeBuddy on the PR; bounded, no GitHub credentials
# tests: CI pipeline on PR; owner reviews + merges (no auto-merge)
```

## Release (requires separate owner authorization)

1. CNB PR `dev` → `main`; owner review + merge.
2. CNB tag `v<semver>` on the merged `main` commit.
3. GitHub publication per ADR §"GitHub release-only publication" — Option A
   or B; requires its own explicit owner approval.

## Rollback

Restore GitHub as write origin: `git push origin <branch>` from local
history; pilot sync workflow still on `chore/cnb-sync-pilot` until M4.
Nothing in migration rewrites history on either platform.

## Known permission gaps (OWNER_ACTION, one-time)

1. `repo-manage:rw` — CNB branch protections for CNB `dev`/`main` cannot be
   configured by the current agent token (403 repo-manage:rw). Needed
   before M2 merge gating is enforced server-side.
2. `repo-release:r` — CNB tag listing/creation blocked (403). Needed for
   release flow and tag parity verification.
3. GitHub release identity (ADR Option B) — design only until owner review.
