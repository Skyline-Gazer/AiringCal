# Issue #73 — in-repo governance draft (do not auto-post)

**Purpose:** Exact text for Owner / agent with GitHub issue write access to post **after** this prep change set merges. This file is **not** authorization to close #73, enable Writer, run Production Apply, or merge to `main`.

**Tracking:** [Issue #73](https://github.com/Skyline-Gazer/AiringCal/issues/73) · [Project #7](https://github.com/orgs/Skyline-Gazer/projects/7)

**In-repo source of truth Project #7 should link:**

- [`docs/v3/current-state.md`](../current-state.md) — live delivery status (Production row: NOT AUTHORIZED)
- [`docs/v3/production-acceptance.md`](../production-acceptance.md) — authoritative 10-gate Full Clean Deploy GO/NO-GO checklist
- Machine-readable skeleton: [`production-acceptance-checklist.json`](./production-acceptance-checklist.json)

## Project #7 Status (document only — do not mutate board from this prep)

Project #7 Status for #73 remains **Todo / In Progress** until Owner Apply evidence exists on the Production Acceptance gates. Do **not** mark Done from this prep PR alone.

## Comment body (CURRENT STATUS — post verbatim)

```markdown
CURRENT STATUS — Production Full Clean Deploy prep: day-timed Shadow/Observation hard gates retired in code+docs; Production remains NOT AUTHORIZED for Apply / main / Writer enable. Acceptance = clean init → Bangumi Full Sync → one-shot v2 core diff → CAS/MIME → CF/EO parity → WAF/cache → rollback drill → Owner GO/NO-GO.
```

## Suggested DoD rewrite (replace day/run hard gates)

Definition of Done for #73 (Full Clean Deploy), not satisfied by prep merge alone:

1. Production Preflight dry-run PASS (`deploy-env --dry-run`, bucket `airingcal-production`, no copy steps, Writer disabled).
2. Owner-authorized create of empty `airingcal-production`, GitHub Environment `production`, Production CF Worker, EdgeOne overseas project (distinct names).
3. Isolation probe PASS (anonymous checkpoint GET/HEAD 403 on Production public host).
4. Bangumi first Full Sync (`workflow_dispatch` target=`production` `force_mode=full`) into empty checkpoint — not Development/Staging/v2 object copy.
5. One-shot v2 core-field / collections / calendar compare PASS (`portable-shadow-gate` or `portable-snapshot-compare`; exit 0 / `equal: true`).
6. R2 checkpoint/release CAS + image completeness + MIME verification PASS.
7. Cloudflare / EdgeOne Reader API + generation + image 302 parity PASS.
8. CDN / WAF checkpoint deny + cache correctness PASS.
9. Rollback + roll-forward drill PASS (`portable-release-rollback` receipt flow).
10. Owner explicit GO/NO-GO recorded on #73 before traffic switch; old system retained as rollback until Owner says otherwise.

**Retired as hard gates:** 7 consecutive Shadow matches; 14-day post-cutover observation before cleanup (cleanup is `--owner-approved` only).

**Still forbidden until separate Owner authorization:** Production `--apply`, `AIRINGCAL_WRITER_ENABLED=true`, `main` cutover.
