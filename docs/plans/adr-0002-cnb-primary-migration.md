# ADR 0002 — CNB-Primary Migration (source of truth, CI, release mirror)

- Status: Accepted (owner-approved, 2026-10-26, Issue #139)
- Supersedes: bidirectional sync designs in #134 / #137 (both closed, Not Planned)
- Scope: AiringCal ONLY. Never generalized to ADS or other projects.

## Decision

CNB (`KoolingMachine/AiringCal`) is the sole authoritative code-development
platform. GitHub (`Skyline-Gazer/AiringCal`) keeps Issues, Project #7, and a
release-only mirror of `main` + approved tags.

| Concern | Owner |
| --- | --- |
| dev baseline, feature/fix branches, PRs | CNB |
| AI Review, NPC AutoFix, cloud dev/build | CNB |
| Release PR (dev → main) | CNB (reviewed; no auto-merge) |
| Issues / Project #7 | GitHub |
| Approved release `main` + tags | GitHub (publication path per §5) |

Routine CNB feature/fix branches and `dev` are NEVER mirrored to GitHub.
GitHub development changes are NEVER synced back to CNB after cutover.

## Branch mapping

| GitHub (historical) | CNB (canonical) | Note |
| --- | --- | --- |
| `dev` `72ebdcf4` | `dev` `72ebdcf4` | identical SHA; CNB is now write origin |
| `main` `a4b3b082` | `main` `a4b3b082` | imported M1, exact SHA parity |
| (none) | `chore/cnb-sync-pilot`, `cnb-autofix/review-pilot-1` | historical pilot evidence, preserved |
| tags: none exist on either platform | — | release tags created on CNB after M2, mirrored per §5 |

## CI/CD responsibilities

- CNB: `.cnb.yml` pipelines — PR CI, AI review (advisory), bounded NPC fix,
  tests. Free tier only (build 160 core-h, dev 1600 core-h, AI 500 credits,
  org-shared).
- GitHub: existing workflows stay as-is during migration. `dev` push
  currently deploys Cloudflare Worker + D1 — production-capable; merging
  this ADR does NOT authorize any production deploy. CNB `dev` is never
  pushed to GitHub `dev`, so this trigger cannot fire from CNB work.

## Migration gates

1. M0: this ADR + runbook merged to CNB `dev` via PR.
2. M1: CNB `main` from GitHub `main` with exact SHA (`a4b3b082`), full
   history (3341 commits, tree-identical), no tags existed to import.
3. M2: one CNB-native lifecycle E2E (feature → PR → AI review → NPC fix →
   tests → merge authorization by owner).
4. M3: release-only GitHub publication design (documented here), gated on
   owner approval before any actual publication.
5. M4: retire GH→CNB pilot sync + `CNB_SYNC_TOKEN` audit/revoke.

## GitHub release-only publication (design, not activated)

Constraints: GitHub Ruleset `protect-dev-main` (PR required on dev/main, no
bypass) stays. Exact SHA mirroring of CNB `main` into GitHub `main` via an
ordinary PR merge is impossible (merge commit SHA ≠ CNB main). Two options:

- **Option A (fallback, zero new permissions):** create GitHub
  `release-candidate` branch exactly at CNB `main` SHA, open GitHub PR →
  `main`, owner merges with **Rebase/fast-forward strategy** — acceptable
  only if GitHub merge produces the identical CNB `main` SHA (proven per
  release by SHA read-back; if SHAs diverge, document the drift and treat
  GitHub `main` as a re-synced mirror with ancestry proof, NOT exact
  mirror).
- **Option B (exact mirror, requires owner action):** dedicated GitHub App
  installation scoped to this repo with `contents:write` ONLY, permitted
  Ruleset bypass for `main` limited to fast-forward pushes, credentials
  held by a trusted publisher job that (a) verifies CNB `main` SHA is a
  descendant of current GitHub `main`, (b) refuses non-fast-forward, never
  force-pushes, (c) publishes tags only after `main` parity read-back,
  (d) rejects tag rewrites/deletions, (e) is separate from all NPC/AI jobs
  and never executes PR-provided code. Activation is a separate owner
  approval AFTER this design review.

Publication order per release: CNB dev→main PR merged (owner) → CNB tag
`v*` on main commit → GitHub main fast-forward (A or B) → GitHub tag on the
same SHA → GitHub Release notes (references CNB provenance).

## Rollback

GitHub `main`/`dev` SHAs are snapshotted (§ baseline) and never rewritten by
migration. Rollback = resume GitHub as write origin: re-enable GH→CNB pilot
workflow (kept on `chore/cnb-sync-pilot`), keep `CNB_SYNC_TOKEN` until M4
audit completes. No history force-push on either platform at any point.

## Secrets and access scopes

- CNB agent identity: `cnb` CLI device-login token (short-lived, refreshable),
  scopes proven: repo-code:rw, repo-pr:rw, repo-cnb-trigger:rw,
  repo-cnb-history:r; MISSING (OWNER_ACTION): repo-manage:rw (branch
  protection), repo-release:r (tag listing).
- GitHub release identity: not yet created (Option B pending owner review).
- `CNB_SYNC_TOKEN` (GitHub Actions): retired at M4 after audit.
- NPC/AI jobs: never receive GitHub write credentials of any kind.
