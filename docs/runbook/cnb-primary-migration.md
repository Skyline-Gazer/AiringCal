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

Prerequisite (one-time per clone):

```sh
git remote add cnb https://cnb.cool/KoolingMachine/AiringCal.git
git remote -v   # verify: origin = GitHub (read/reference), cnb = CNB (write origin)
```

```sh
git fetch cnb dev && git checkout -b feat/<topic> refs/remotes/cnb/dev
# work, commit...
git push cnb HEAD:refs/heads/feat/<topic>
cnb pulls post-pull --repo KoolingMachine/AiringCal \
  --base dev --head feat/<topic> --title '...' --body '...'
# AI review runs automatically on CNB PR (.cnb.yml on dev, advisory-only)
# NPC fix: comment @CodeBuddy on the PR; bounded, no GitHub credentials
# tests: CI pipeline on PR; owner reviews + merges (no auto-merge)
```

## Release (requires separate owner authorization)

1. CNB PR `dev` → `main`; owner review + merge (no auto-merge).
2. CNB tag `v<semver>` on the merged `main` commit (needs `repo-release:r`
   OWNER_ACTION if not yet granted).
3. GitHub publication — executed by the OWNER (or delegated agent after
   approval). **Option A is the active path** (no new permissions needed);
   **Option B is design-only** until the owner reviews and approves the
   dedicated release identity.

### Option A — release-candidate PR (no new permissions)

```sh
# 0. Prerequisite: cnb remote configured (see Daily development above).
# 1. Point GitHub release-candidate at the exact CNB main SHA.
#    release-candidate is a DISPOSABLE branch; deleting a stale one is part
#    of the flow (a stale branch makes the re-create a non-fast-forward).
git fetch cnb main
OLD_RC=$(git ls-remote origin refs/heads/release-candidate | cut -f1)
if [ -n "$OLD_RC" ]; then
  git push origin ":refs/heads/release-candidate"   # delete stale branch
fi
git push origin refs/remotes/cnb/main:refs/heads/release-candidate
# 2. Open GitHub PR release-candidate -> main; owner merges.
# 3. MANDATORY SHA gate — read back and compare (explicit object, no drift):
CNB_MAIN=$(git rev-parse refs/remotes/cnb/main)
GH_MAIN=$(git ls-remote origin refs/heads/main | cut -f1)
[ "$CNB_MAIN" = "$GH_MAIN" ] || { echo "DRIFT: $CNB_MAIN != $GH_MAIN"; exit 1; }
# If SHAs match: create an ANNOTATED tag on that exact object (annotated
# tags are the repo convention; use the same kind on CNB side) and push it.
git tag -a "v<semver>" "$CNB_MAIN" -m "release v<semver> from CNB main"
git push origin "refs/tags/v<semver>"
# If the gate failed: record drift in this runbook, DO NOT create the tag,
# STOP publication, reconcile per ADR drift procedure.
```

### Option B — trusted release publisher (exact mirror; needs owner setup)

Owner installs a dedicated GitHub App (contents:write, this repo only) with
a narrowly scoped `main` Ruleset bypass for fast-forward pushes only. The
publisher job: verifies CNB `main` is a descendant of GitHub `main`, refuses
non-fast-forward/unknown target history, never force-pushes, publishes tags
only after `main` SHA parity read-back, rejects tag rewrites/deletions,
never runs untrusted PR code, holds credentials separate from NPC/AI jobs.
Activation is a separate owner approval after design review (ADR §release).

Either option: if the SHA gate fails, stop, document drift, reconcile before
any tag publication. GitHub `main` must never silently diverge from CNB
`main`.

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
3. GitHub release identity: Option A (release-candidate PR) is the ACTIVE
   path and needs no new permissions; Option B (exact-mirror App) remains
   design-only until owner review/approval.

## M4 retirement audit (point-in-time snapshot 2026-10-26, pre-cutover)

> Re-verify every figure below at actual M4 execution time (run counts and
> timestamps change); this table is the audit *checklist*, not live data.

| Item | State | Action at retirement |
| --- | --- | --- |
| `CNB Mirror Pilot` workflow | active on `chore/cnb-sync-pilot` only (trigger: push to that branch); last run 2026-10-26T04:34Z; 895 total runs. Location: `.github/workflows/cnb-sync-pilot.yml` on branch `chore/cnb-sync-pilot` — NOT in the `dev` workflow tree; verify with `git show chore/cnb-sync-pilot:.github/workflows/cnb-sync-pilot.yml` | disable workflow after M2 acceptance + parity freeze; branch retained as evidence |
| `CNB_SYNC_TOKEN` (GitHub Actions secret) | used ONLY by `cnb-sync-pilot.yml` (grep-verified across all workflows) | revoke via owner after workflow disabled; verify zero runs for 7 days before revocation |
| `CLOUDFLARE_*` secrets | used by `ci.yml` (dev push deploy) + bootstrap/sizing | NOT touched by migration; production contract unchanged |
| OCR advisory workflow | already `disabled_manually` | unchanged |
| Old `airingcal-control` writeback prototype | local-only (`~/Desktop/Projects/airingcal-control`, 3 commits, 15/15 fixture tests), NOT deployed to CNB control repo (push rejected by its own protection rules — preserved state) | keep as historical evidence; do NOT deploy (superseded design, #134/#137 Not Planned) |
| CNB PRs #1/#2 | open, preserved | archive evidence, never merge |

## Rollback drill (reversible path)

1. GitHub `dev`/`main` SHAs unchanged by migration (verified: `72ebdcf4` / `a4b3b082`).
2. To resume GitHub-primary: push branches to `origin` as before; re-enable
   pilot workflow if CNB mirroring still needed.
3. No force-push or history rewrite occurred on either platform (CNB `main`
   was an empty-repo addition, not an overwrite).
