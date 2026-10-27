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

> Until `repo-manage:rw` is granted and CNB `dev`/`main` protections are
> configured (Known permission gaps #1), CNB `dev` has NO server-side merge
> gate: owner review is manual only. Never enable auto-merge.

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
#    GitHub PR MUST be merged with **Rebase and merge** (or fast-forward).
#    A merge commit is NOT acceptable — it guarantees SHA divergence from
#    canonical CNB main. Note: the GitHub PR will run required checks from
#    ci.yml (pull_request trigger under the protect-dev-main ruleset).
# 3. MANDATORY SHA gate — BOTH sides read live from remotes (no stale
#    local remote-tracking refs), SHAs printed as publication evidence:
CNB_MAIN=$(git ls-remote cnb refs/heads/main | cut -f1)
GH_MAIN=$(git ls-remote origin refs/heads/main | cut -f1)
echo "CNB_MAIN=$CNB_MAIN"
echo "GH_MAIN=$GH_MAIN"
SEMVER=x.y.z   # set the real version here, e.g. SEMVER=3.0.1
if [ "$CNB_MAIN" != "$GH_MAIN" ]; then
  echo "DRIFT: CNB main $CNB_MAIN != GitHub main $GH_MAIN"
  echo "GitHub main now contains a merge commit or unrelated history."
  echo "Disposition: register GitHub main as a RE-SYNCED MIRROR (ADR drift"
  echo "procedure), reconcile ancestry proof, then STOP — do not tag."
  exit 1
fi
# Gate passed: create an ANNOTATED tag on that exact object (annotated tags
# are the repo convention; use the same kind on the CNB side), then push.
git tag -a "v${SEMVER}" "$CNB_MAIN" -m "release v${SEMVER} from CNB main"
git push origin "refs/tags/v${SEMVER}"
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

## Rollback (drill-ready)

Preconditions preserved by this migration: GitHub `dev`/`main` SHAs are
unchanged (`72ebdcf4` / `a4b3b082`); nothing on either platform was
force-pushed or history-rewritten (CNB `main` was an empty-repo addition).

If CNB becomes unusable as write origin:

1. Freeze CNB writes; note the last CNB `dev` SHA (`git ls-remote cnb dev`).
2. Re-anchor GitHub: fetch CNB objects into a local clone
   (`git fetch cnb '+refs/heads/*:refs/cnb/*'`), then recreate GitHub
   branches explicitly from verified CNB SHAs
   (`git push origin refs/cnb/dev:refs/heads/dev` etc.). If the CNB `dev`
   SHA is a strict descendant of GitHub `dev`, this is a fast-forward; if
   not, stop and reconcile — never force-push.
3. Pilot sync workflow (`chore/cnb-sync-pilot` branch) and `CNB_SYNC_TOKEN`
   remain available until M4 completes; re-enable if GitHub→CNB mirroring
   is still required during the transition.
4. Record the rollback decision + SHAs in this runbook and issue #139.

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

**M4 EXECUTED 2026-10-27** (per ADR 0002 Amendment — GitHub-primary):
`CNB_SYNC_TOKEN` deleted from GitHub Actions secrets (remaining:
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` only); `CNB Mirror Pilot`
workflow disabled via API (`state: disabled_manually`, last run
2026-10-26T04:34Z success — zero runs since token deletion);
`chore/cnb-sync-pilot` branch preserved on both platforms as evidence.

| Item | State | Action at retirement |
| --- | --- | --- |
| `CNB Mirror Pilot` workflow | active on `chore/cnb-sync-pilot` only (trigger: push to that branch); last run 2026-10-26T04:34Z; 895 total runs. Location: `.github/workflows/cnb-sync-pilot.yml` on branch `chore/cnb-sync-pilot` — NOT in the `dev` workflow tree; verify with `git show chore/cnb-sync-pilot:.github/workflows/cnb-sync-pilot.yml` | disable workflow after M2 acceptance + parity freeze; branch retained as evidence |
| `CNB_SYNC_TOKEN` (GitHub Actions secret) | used ONLY by `cnb-sync-pilot.yml` (grep-verified across all workflows) | revoke via owner after workflow disabled; verify zero runs for 7 days before revocation |
| `CLOUDFLARE_*` secrets | used by `ci.yml` (dev push deploy) + bootstrap/sizing | NOT touched by migration; production contract unchanged |
| OCR advisory workflow | already `disabled_manually` | unchanged |
| Old `airingcal-control` writeback prototype | local-only (`~/Desktop/Projects/airingcal-control`, 3 commits, 15/15 fixture tests), NOT deployed to CNB control repo (push rejected by its own protection rules — preserved state) | keep as historical evidence; do NOT deploy (superseded design, #134/#137 Not Planned) |
| CNB PRs #1/#2 | open, preserved | archive evidence, never merge |
