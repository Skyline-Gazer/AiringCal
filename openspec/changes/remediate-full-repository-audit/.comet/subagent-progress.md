# Subagent Progress

- Plan: `docs/superpowers/plans/2026-07-14-full-repository-audit-remediation.md`
- Review mode: `thorough`
- TDD mode: `tdd`
- Worktree: `/Users/ian/Desktop/Projects/BangumiTV/.worktrees/remediate-full-repository-audit`

## Current Task

- Unique text: `Task 6: 24 小时 subject 404 tombstone`
- OpenSpec mappings:
  - `4.1 增加已有 detail 后刷新 404、TTL 内不重复请求的 RED 测试`
  - `4.2 定义 tombstone 类型、key/TTL 与保守 NSFW 投影，404 时停止返回旧 detail`
  - `4.3 验证 tombstone 到期后允许重新探测且 generation 协调语义不倒退`
- Brief: `.superpowers/sdd/task-6-brief.md`
- Stage: `extra-fix-authorized`
- Base commit: `bf171585902d63f32ebfffd8224167c5777cce69`
- Implementer: `/root/task6_tombstone`
- Implementation commits: `172192f`, report `8b42ba7`, fix `403cb6658bb3ca14ed688c0b5dd7bc367038f608`
- Changed files: media/read worker code and tests, domain/storage types/helpers and tests
- RED evidence: domain 26/27, storage 7/8, media 20/21, read 29/30 on missing TTL/stale deletion/read projection
- GREEN evidence: five packages 130/130, five typechecks, media/read/sync build:check and diff check passed
- Report: `.superpowers/sdd/task-6-report.md`
- Review package: `.superpowers/sdd/review-bf17158..403cb66.diff`
- Batch review round: `2/2`
- Passed review stages: sync/media/generation/timing boundaries approved
- Resolved feedback: sync residual-detail suppression, numeric snapshot field stripping, shared predicate, exact expiry, image-only suppression
- Unresolved feedback:
  - P1: Read active-tombstone projection must also remove snapshot-carried canonical detail fields `name`, `name_cn`, `summary`, and `date`, with collection/calendar regressions.
- Extra-round authorization: user explicitly authorized one additional focused fix round on 2026-07-16.
- Next action: add collection/calendar RED regressions for snapshot-carried canonical detail fields, apply the minimal projection fix, and obtain an independent final review.
- Accepted Minor findings carried to final review:
  - Task 2 Frontend CSP test could explicitly forbid script `'unsafe-inline'`.
  - Task 2 operation test could explicitly assert `default-src 'none'` and encoded entities.
