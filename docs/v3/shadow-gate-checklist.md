# One-shot Production parity checklist (#73)

Operator checklist for **Production Acceptance gate 5** (data integrity one-shot compare). Authoritative order: [`production-acceptance.md`](./production-acceptance.md).

> **OWNER_ACTION:** live Production credentials, Writer dispatch, and traffic switch wait on Owner authorization. This checklist does not enable `AIRINGCAL_WRITER_ENABLED` or run Production Apply.

## Preconditions

- [ ] Production preflight dry-run PASS ([`production-acceptance.md`](./production-acceptance.md) gate 1)
- [ ] Production resources exist / isolation probe PASS when in Owner Apply phase (gates 2–3)
- [ ] Candidate Release exists from Bangumi Full Sync into the Production checkpoint (gate 4), **or** a scoped compare input Owner approved for prep/smoke
- [ ] `AIRINGCAL_WRITER_ENABLED` remains unset/`false` on Production until Owner GO for Writer use
- [ ] Fresh checkpoint backup available if comparing against a mutable builder SQLite (`portable-checkpoint-backup`)

## One-shot compare (single PASS — not a streak)

- [ ] Normalize inputs if needed:
      `tsx apps/node-jobs/src/cli/portable-v2-public-normalize.ts <public.json> [hydrated.json]`
- [ ] Run one-shot shadow gate:
      `tsx apps/node-jobs/src/cli/portable-shadow-gate.ts --sqlite <path> --legacy <legacy.json> --candidate <public-snapshot.json>` → exit **0**, `equal: true`, `diff_count: 0`
- [ ] Or pure compare: `tsx apps/node-jobs/src/cli/portable-snapshot-compare.ts <left.json> <right.json>` → exit **0**
- [ ] Record equal/mismatch evidence on [#73](https://github.com/Skyline-Gazer/AiringCal/issues/73); mismatch is FAIL for gate 5 (re-run after fix — no “day N of 7”)
- [ ] Core fields covered: collections, subject ids, calendar (and agreed image/NSFW fields)

## Adjacent gates (do not confuse with streak)

- [ ] Gate 6: R2 CAS / image completeness / MIME — separate from this compare
- [ ] Gate 7–8: Reader / CDN / WAF — see [`reader-delivery-cutover.md`](./reader-delivery-cutover.md) patterns
- [ ] Gate 9: rollback drill — [`cutover-rollback.md`](./cutover-rollback.md)
- [ ] Gate 10: Owner GO/NO-GO before traffic switch

## Historical decision

Retired: “7 consecutive daily matches” and “any miss resets the streak.” Active rule is one successful one-shot equal compare as gate 5 inside the ten-gate Production Acceptance list.
