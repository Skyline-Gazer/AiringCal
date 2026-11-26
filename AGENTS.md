# AiringCal Agent & Contributor Constraints

**AiringCal `v3.0.0` Architecture:** GitHub is the single development origin (`dev` → `main`). The **GitHub Actions Portable Writer** (`.github/workflows/portable-writer.yml`) is the sole writer, persisting a private SQLite checkpoint (`checkpoints/builder.sqlite` + `checkpoints/lease.json`) and an immutable content-addressed public release (`public/current-release.json`, `snapshots/v1/*`, `images/*`) in a single **Private Cloudflare R2 Bucket** per environment (`airingcal-production` or `airingcal-development`, `r2.dev` disabled). The **Cloudflare Reader Worker** (`apps/v3-read-worker`) is the sole supported reader in `v3.0.0`. Additional reader platforms (EdgeOne [#210](https://github.com/Skyline-Gazer/AiringCal/issues/210), Vercel [#211](https://github.com/Skyline-Gazer/AiringCal/issues/211), Netlify [#212](https://github.com/Skyline-Gazer/AiringCal/issues/212)) are tracked as post-`v3.0.0` backlog items.

**Documentation Entry (AI & Operators):** [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) → [`docs/README.md`](docs/README.md).
- Deployment, update & recovery: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | [`docs/DEPLOYMENT.zh-CN.md`](docs/DEPLOYMENT.zh-CN.md)
- HTTP Read API & Widget integration: [`docs/API_AND_WIDGET.md`](docs/API_AND_WIDGET.md) | [`docs/API_AND_WIDGET.zh-CN.md`](docs/API_AND_WIDGET.zh-CN.md)
- Architecture & security model: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Portable Writer operator contract: [`apps/node-jobs/docs/operator-contract.md`](apps/node-jobs/docs/operator-contract.md)
- Release acceptance & legacy recoverability evidence: [`docs/v3/release-acceptance-evidence.md`](docs/v3/release-acceptance-evidence.md)

**Project Skills:** Installed under [`.agents/skills/`](.agents/skills) with upstream provenance and SHA-256 content hashes locked in [`skills-lock.json`](skills-lock.json):
- `cloudflare` & `workers-best-practices` (`cloudflare/skills` @ `ff191de7d903788eceaf516a514ae7d3b56b924a`)
- `ponytail`, `ponytail-review`, `ponytail-audit` (`DietrichGebert/ponytail` @ `ebd8654c2c627f721eb8f9c0d1bd4090a29f9e10`, Full mode)

## ADS (Pinned Submodule)

**Pin:** `.ads` @ `178212c41cce8fbf9354d4066e0f77341f6f23c4` — ADS **v0.8.0** (Lite profile; consumer evidence in [`docs/v3/release-acceptance-evidence.md`](docs/v3/release-acceptance-evidence.md)).

Read [`.ads/STANDARD.md`](.ads/STANDARD.md), [`.ads/SAFETY.md`](.ads/SAFETY.md), and [`.ads/QUALITY.md`](.ads/QUALITY.md) before structural changes. Project-local rules below (§零 Verify Before Writing, Documentation Sync) remain authoritative where stricter. Project-only read and write boundary applies: never list, search, hash, or read paths outside this repository without explicit authorization (see [`.ads/docs/host-filesystem-boundary.md`](.ads/docs/host-filesystem-boundary.md)).

## Verify Before Writing (HIGHEST PRIORITY)

**Rule §零:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md#零修改前验证最高优先级)

Before writing any CLI flag, config key, or API call: run `--help`, check types, or grep source. Never guess. If you cannot verify it exists, do not write it.

**bgm.tv API calls:** Check [`docs/example/api/bgm-api.json`](docs/example/api/bgm-api.json) before touching any bgm.tv API interaction.

## Documentation Sync & Commit Discipline

**Rule §一～四:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md)

Every non-merge commit must include a structured commit body (`Business context`, `Expected behavior`, `Acceptance criteria`, `Constraints and edge cases`, `Verification`). Docs update with code. No speculative or unimplemented content in user-facing docs.
