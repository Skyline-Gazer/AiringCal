# BangumiTV Subagent Constraints

**Doc entry (AI):** [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) → [`docs/README.md`](docs/README.md). node-jobs contract: [`apps/node-jobs/docs/operator-contract.md`](apps/node-jobs/docs/operator-contract.md).

## ADS (pinned submodule)

**Pin:** `.ads` @ `375fc71f977c40c2053140c34431cc60a6d42883` (tag `v0.4.2`).

Read [`.ads/STANDARD.md`](.ads/STANDARD.md), [`.ads/SAFETY.md`](.ads/SAFETY.md), [`.ads/QUALITY.md`](.ads/QUALITY.md) before structural changes; opt-in skills under [`.ads/skills/`](.ads/skills). Project-local rules below (§零, docs-sync, Comet guard) remain authoritative where they are stricter. Project-only read **and** write boundary applies: never list, search, hash or read paths outside this repository without explicit authorization (see [`.ads/docs/host-filesystem-boundary.md`](.ads/docs/host-filesystem-boundary.md)).

## Verify Before Writing (HIGHEST PRIORITY)

**Rule §零:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md#零修改前验证最高优先级)

Before writing any CLI flag, config key, or API call: run `--help`, check types, or grep source. Never guess. If you can't verify it exists, don't write it.

**bgm.tv API calls:** Check [`docs/example/api/bgm-api.json`](docs/example/api/bgm-api.json) before touching any bgm.tv API interaction.

## Documentation Sync

**Rule §一～四:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md)

Commit and push after every atomic change. Docs update with code. Release requires full doc audit — no speculative or unimplemented content in user-facing docs.

## Comet Phase Guard

**Rule:** [`.claude/rules/comet-phase-guard.md`](.claude/rules/comet-phase-guard.md)

Check phase state before any operation that could violate workflow boundaries.
