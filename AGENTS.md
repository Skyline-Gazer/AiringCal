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

## Cursor Cloud specific instructions

CI uses Node 24 (`.github/workflows/ci.yml`) and pnpm `9.15.9` (root `packageManager`). This environment installs Node `24.22.2` into `/usr/local/bin`. Put `/usr/local/bin` first on `PATH` so that Node wins over any older `node` earlier in the default path.

Checks that match the CI validate job: `pnpm typecheck`, `pnpm test`, `pnpm build:check`. QingLong bundle: `pnpm -F @airing-cal/node-jobs build`.

`pnpm dev` starts `@airing-cal/web-worker` with `wrangler dev`. That process exits immediately because `apps/web-worker/src/index.ts` exports the string `appBoundary`, and local workerd only accepts a function or `ExportedHandler` for a named export. Serve the app by bundling with `wrangler deploy --dry-run`, removing the `appBoundary` name from the bundle's export list, then running `wrangler dev <bundle> --no-bundle --local --ip 0.0.0.0 --port 8787`. Set `CI=true` so Wrangler does not prompt to install Cloudflare skills. Local mode does not need Cloudflare credentials; the placeholder ids in `apps/web-worker/wrangler.toml` are local bindings. `POST /api/thumb-gen` returns 401 until `THUMB_GEN_BEARER` is set. With an empty local database, `GET /` renders the empty catalog and `GET /api/health` returns 200 with `degraded: true`.
