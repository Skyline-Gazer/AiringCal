# AiringCal v3 — 2026-11-25 Attachment Engineering Round (canonical receipt)

Archived: 2026-11-25 (D1 mission §2). Scope: **engineering only**. This file is
the frozen receipt of the accepted engineering baseline ending at
`81ff42145c5ab7985a32688152a7cab9373ff3d8`. Live acceptance evidence is
recorded separately in [`current-state.md`](./current-state.md) and must not be
merged into the facts below.

- Canonical baseline SHA (engineering close): `81ff4214`
- Canonical baseline SHA (round start): `0ec26a0a` (PR #182, prior round verdict)
- ADS pin: `178212c41cce8fbf9354d4066e0f77341f6f23c4` (v0.8.0), adopted via #184
- Tracking: [#67](https://github.com/Skyline-Gazer/AiringCal/issues/67) roadmap ·
  [#72](https://github.com/Skyline-Gazer/AiringCal/issues/72) architecture ·
  [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73) release gates ·
  [#147](https://github.com/Skyline-Gazer/AiringCal/issues/147) dev live acceptance ·
  [#183](https://github.com/Skyline-Gazer/AiringCal/issues/183) ADS adoption (closed)

## 1. Merged PR ledger (all CI-green, all merged into `dev`)

| PR | Merge SHA | Content |
| --- | --- | --- |
| #184 | `a7a9bb96` | ADS v0.8.0 adoption: gitlink `82c3404b` → `178212c4` (verified pure fast-forward), AGENTS.md pin line, lite-profile declaration, activation proof on this host |
| #185 | `9480cb7a` | Private-R2 Worker-origin public object interface (`public-object-routes.ts`), Worker CORS (`AIRINGCAL_CORS_ORIGINS`, OPTIONS 204/405), `deploy-env` worker/bucket-domain origin modes, post-deploy multi-variant probes, always-delete probe lifecycle, probe-residue-aware empty-bucket guard |
| #186 | `13a6996b` | Release-gate truth: GHA job-level `if` reduced to resolvable scopes, env-scoped step gates for dispatch jobs, `runSingleWriterTest` toggles the gate's own scope, docs corrected to real CLI surfaces (no `--env` flag; `staging` selector rejected), stale root `package-lock.json` removed (evidence-backed) |
| #187 | `b0a54410` | `v3-ship-verify --bucket` positive private-object proof (read-only S3 list+HEAD of a real checkpoint key, then anonymous GET/HEAD denial via reader origin), fail-closed without proof, explicit `--allow-unproven-isolation` |
| #189 | `d0c9d1da` | ADS closeout evidence `docs/v3/ads-adoption-closeout.md` (T0/T1/T2) + two consumer handoffs on ADS issue #133 (resubmission of the accidentally-closed #188, audit note retained) |
| #190 | `3511cd04` | current-state sync to merged reality |
| #191 | `bbf6bd2c` | ShipReview2 disposition (5 findings, see §3) |
| #192 | `81ff4214` | ShipReview disposition (4 still-alive findings, see §3) |

## 2. Phase acceptance (Owner attachment P0–P6)

| Phase | Delivered |
| --- | --- |
| P0 ADS adoption | #184; gitlink + governance docs + this-host activation; feature work branched only after merge |
| P1 workspace reconciliation | lockfile removal (#186), retained-evidence decisions, Project #7 hierarchy + 22-item status readback via native GraphQL |
| P2 architecture convergence (#72) | One Worker per environment serves Viewer routes + read APIs + image delivery + public object interface against PRIVATE R2; no anonymous bucket/WAF dependency; EdgeOne may consume the same controlled interface; Static Assets evaluated and rejected (parity across CF/Node/miniflare/bun runtimes) |
| P3 release-gate hardening (#73) | #186 (gate scopes, probe lifecycle, doc truth) + #191 (bootstrap no-interrupt) + #192 (sync required-var preflight, exit-code truth) |
| P4 verifier + CI | #187 (+ #191 pointer routes); full suites green at every merge |
| P5 ADS evidence + handoffs | #189 |
| P6 reporting | round report (this file) + live verdicts in `current-state.md` |

## 3. Delayed automated reviews — full disposition (15 findings)

**ShipReview2 (5 findings → #191):** static method guard asset-scoped so real
entries answer OPTIONS preflight; production clean-bootstrap image routing
`skipped-no-release` (recorded, not completed); 404-before-snapshot for
non-release paths (isolation probes no longer 503 on fresh readers); RFC
9110 `If-None-Match` (weak tokens, comma lists, `*`);
`AIRINGCAL_PRODUCTION_BARK_URL` added to the production variable allowlist.

**ShipReview (10 findings → 6 already fixed by #185/#186/#187/#191, 4 alive → #192):**
production `syncGithubEnvironment` refuses **before any gh write** when
`AIRINGCAL_USERS_JSON`/`AIRINGCAL_PRIMARY_USER_ID` are empty (the first Full
Sync validates the derived variables as required); deprecated-sync 410 moved
into the shared read handler so the EdgeOne runtime (no static stage) matches
every other runtime; docs corrected to real gate behavior (missing
`--i-am-sure-production` = exit 1 at argument resolution; the two env gates =
plan/pending + exit 2) and `.env.production.example` gate scopes; truthful
`mutationsExecuted` ledger (`MUTATING_STEP_IDS`) in apply result JSON.

Reviewer non-blocking notes were each assessed with disposition recorded in
PR #191/#192 and issue #183 comments; no further code was warranted.

## 4. Verification matrix (executed, not inferred)

| Check | Result at `81ff4214` |
| --- | --- |
| `node --test scripts/*.test.mjs` | 230/230 |
| v3-read | 62/62 |
| `pnpm -r test` | 12 packages × 0 failures (3 skipped = MinIO-only, historical) |
| `pnpm typecheck` / `pnpm build:check` | clean |
| Per-PR CI | #184–#187, #189–#192 all green (branch protection enforced) |
| CLI truth | every documented flag/exit path re-read from source (`parseDeployArgs`, `applyDevelopment`, production gate order) |

## 5. NOT_VERIFIED at engineering close (honest gaps)

- ADS activation on other hosts (proven on this host only).
- Worker-mode plan end-to-end against live Cloudflare (staging frozen; no
  copyFree rehearsal possible).
- `v3-ship-verify --bucket` against the real bucket (fully tested offline via
  mirror store; live run requires credentials — scheduled for D1 live phase).
- EdgeOne re-point at the Worker interface (live step, Owner scope).
- The three MinIO-dependent skipped tests.

## 6. Authorization boundaries held (zero violations)

No Cloudflare/EdgeOne/DNS mutation; no production writes; scheduled writer
remained disabled; staging untouched (FROZEN rollback source); single-flight /
CAS / credential isolation unchanged; no secret values in logs, argv, diffs,
or docs; `dev` → `main` not executed.

## 7. Owner live legs left open at close (now D1 scope)

1. Development Worker-mode redeploy + live verifier (D1 mission).
2. Production clean bootstrap (three gates) + first Full Sync + writer gate —
   requires explicit Owner authorization.
3. `dev` → `main` after production acceptance.
