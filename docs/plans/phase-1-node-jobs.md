# Phase 1 — node-jobs + QingLong bundle

**Status: closed (2026-10-13).** Write path = D1 + R2 (+ KV pointers). VPS abandoned — [abandoned-vps-route.md](./abandoned-vps-route.md).

## Delivered

| AC | Item |
| --- | --- |
| AC-1-01 | Package, CLI, `schema.sql`, bundle build |
| AC-1-02 | D1, lease, R2, env |
| AC-1-03 | Sync pipeline (fetch → media → publish) |
| AC-1-04 | Backup pipeline |
| AC-1-05 | [d1-schema.md](../../apps/node-jobs/docs/d1-schema.md) |
| AC-1-06 | Mock integration tests — [operator-contract.md § Integration tests](../../apps/node-jobs/docs/operator-contract.md#integration-tests-ac-1-06) |
| AC-1-07 | CI `qinglong-bundle` artifact |
| AC-1-08 | [operator-contract.md](../../apps/node-jobs/docs/operator-contract.md) |
| AC-3-01 | [no-cf-write-path.md](./no-cf-write-path.md) |
| AC-3-03 | [kv-binding-decision.md](./kv-binding-decision.md) |

## Commands

```bash
pnpm -F @airing-cal/node-jobs test
pnpm -F @airing-cal/node-jobs build
```

## QingLong

Thin scripts: [QINGLONG-REPO `ql`](https://github.com/Skyline-Gazer/QINGLONG-REPO/tree/ql/scripts). Joint milestone: [airingcal-qinglong.md](https://github.com/Skyline-Gazer/QINGLONG-REPO/blob/ql/docs/plans/airingcal-qinglong.md).

## M2 (ops, not Phase 1 code)

[../runbook/m2-read-surface.md](../runbook/m2-read-surface.md)
