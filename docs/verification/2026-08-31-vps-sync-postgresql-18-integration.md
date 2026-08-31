# VPS sync PostgreSQL 18 integration evidence

**Recorded:** 2026-08-31
**Scope:** approved documentation baseline update for PostgreSQL 18; this record reuses an already completed real-server run and does not rerun the database.

## Accepted baseline

- Supported server major: PostgreSQL 18, kept on a maintained `18.x` patch release.
- Tested server: `server_version` `18.6`; `server_version_num` `180006`.
- Future PostgreSQL majors require explicit review and a fresh real-server integration run; PostgreSQL 17 compatibility is unverified and is not an acceptance gate for this baseline.
- Connection: direct TLS PostgreSQL connection. No provider SDK or provider control-plane API was used. A direct/session-preserving endpoint is required because the implementation holds session advisory locks across connections; transaction pooling is unsuitable for that requirement.

## Command and result

```text
pnpm -F @airing-cal/vps-sync test:integration
```

The configured Node `pg` test process exited `0` on 2026-08-31:

- `9` pass, `0` fail, `0` skipped
- duration: `25756.220958 ms`
- tested source commit: `05e70bf11a75b7938c876a5de3fd3ec8281c7894`
- the PostgreSQL source and test tree at that commit was verified unchanged from dev commit `fb659fa4c5c910fb10825a846391040404489996`.

The run covered eight nested subtests:

1. Empty-schema concurrent cold-start migrations.
2. Immutable `0001` to current migration and checksum/current-schema gates.
3. PostgreSQL session advisory lock behavior across two connections.
4. Calendar-only subject foreign key and complete-state transaction rollback.
5. Observation-time deletion, restoration, and unchanged-write behavior.
6. Stale media fence plus publication claim/cleanup compare-and-swap behavior.
7. Persistence-marker rejection.
8. Scan of all persisted text and JSON columns.

The suite confirmed before and after execution that `new_remaining_test_schemas=[]`. It created only random isolated schemas and dropped them during cleanup.

## Evidence boundaries and pending work

This is real PostgreSQL server evidence for the implemented Node `pg` migration and repository path. It does not establish any of the following:

- Docker engine/image execution, Compose configuration, or CI PostgreSQL service validation.
- `psql --help` or a `psql`-based API preflight. `psql` is not used by the implemented Node `pg` migration path.
- `pg_dump`/`pg_restore` CLI contract validation, a PostgreSQL 18 client image, backup upload, or a real backup/restore drill.

The official Docker metadata confirms the `postgres:18-alpine` tag exists, but this project has not used it for the pending container validation. The planned PostgreSQL 18 `pg_dump`/`pg_restore` work remains pending and must use a direct/session-preserving connection.

No secrets, connection URL, hostname, username, database name, or provider credential is recorded here.

## References

- PostgreSQL 18 release notes: <https://www.postgresql.org/docs/18/release-18.html>
- PostgreSQL 18 `pg_dump` documentation: <https://www.postgresql.org/docs/18/app-pgdump.html>
- Neon connection pooling guidance: <https://neon.com/docs/connect/connection-pooling>
- Official PostgreSQL Docker image tags: <https://hub.docker.com/_/postgres?tab=tags>
