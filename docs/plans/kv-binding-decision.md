# KV binding decision (AC-3-03)

**Decision (2026-10-13):** **Keep** Workers KV binding on `web-worker` and **require** `AIRING_CAL_KV_NAMESPACE_ID` for sync publish.

## Why not remove KV now

| Key | Writer | Reader |
| --- | --- | --- |
| `public:current` | node-jobs sync | web-worker read bootstrap |
| `public:read-mode` | node-jobs sync (R2 mode) | web-worker chooses R2 vs legacy |

Removing the binding would break read bootstrap until an alternative pointer store exists. Full R2-only reads are optional ops ([`../runbook/migrate-public-reads.md`](../runbook/migrate-public-reads.md)).

## Future

Re-evaluate when legacy KV snapshot is unused in production **and** read-mode is stably `r2` with no KV fallback requirement.
