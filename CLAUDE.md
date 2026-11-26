# AiringCal Development Constraints

See [`AGENTS.md`](AGENTS.md) and [`START_HERE_FOR_AI.md`](START_HERE_FOR_AI.md) for the complete architecture, governance, and project skill constraints.

## Verify Before Writing (HIGHEST PRIORITY)

**Rule §零:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md#零修改前验证最高优先级)

Before writing any CLI flag, config key, or API call: run `--help`, check types, or grep source. Never guess. If you can't verify it exists, don't write it.

**bgm.tv API calls:** Check [`docs/example/api/bgm-api.json`](docs/example/api/bgm-api.json) before touching any bgm.tv API interaction.

## Documentation Sync

**Rule §一～四:** [`docs/rules/docs-sync.md`](docs/rules/docs-sync.md)

Every non-merge commit must include a structured commit body (`Business context`, `Expected behavior`, `Acceptance criteria`, `Constraints and edge cases`, `Verification`). Documentation updates ship with code changes.
