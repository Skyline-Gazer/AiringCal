# BangumiTV Development Constraints

## Verify Before Writing (HIGHEST PRIORITY)

**Rule §零:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md#零修改前验证最高优先级)

Before writing any CLI flag, config key, or API call: run `--help`, check types, or grep source. Never guess. If you can't verify it exists, don't write it.

**bgm.tv API calls:** Check [`docs/example/api/bgm-api.json`](docs/example/api/bgm-api.json) before touching any bgm.tv API interaction.

## Documentation Sync

**Rule §一～四:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md)

Every fix/refactor/feat must be committed and pushed immediately. Documentation updates ship in the same or immediately following commit. Before release, a full documentation audit is required — no forward-looking or unimplemented content allowed in docs.

## Comet Phase Guard

**Rule:** [`.claude/rules/comet-phase-guard.md`](.claude/rules/comet-phase-guard.md)

Phase-aware workflow enforcement. When a `.comet.yaml` exists, the current phase determines which operations are permitted.
