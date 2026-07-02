# bgm.tv API Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a complete bgm.tv API usage audit report that compares runtime code and user-facing docs against verified API evidence.

**Architecture:** Keep the audit as one report artifact and do not modify runtime code during this plan. Build a traceable evidence matrix from source scans, local OpenAPI lookups, and documentation scans, then summarize findings by P0/P1/P2.

**Tech Stack:** TypeScript source inspection, `rg`, `jq`, local `docs/example/api/bgm-api.json`, Markdown report.

## Global Constraints

- Before writing any CLI flag, config key, or API call, verify it exists with `--help`, source, or local API reference.
- Check `docs/example/api/bgm-api.json` before judging any bgm.tv v0 API interaction.
- Do not modify implementation code in this audit plan.
- Include README and historical design/plan docs in the audit.
- Separate runtime defects from documentation debt with P0/P1/P2 priority.
- Commit and push after every atomic change.

---

## File Structure

- Create: `docs/superpowers/reports/2026-06-25-bgm-api-audit.md`
  - Owns the final audit report, evidence matrix, findings, and fix batch proposal.
- Read: `docs/superpowers/specs/2026-06-25-bgm-api-audit-design.md`
  - Source of scope, priority rules, and non-goals.
- Read: `docs/example/api/bgm-api.json`
  - Local OpenAPI evidence for bgm.tv v0 endpoints.
- Read: `packages/shared/src/bgm-client.ts`
  - Central runtime bgm.tv API wrapper.
- Read: `packages/shared/src/platform/bgm.ts`
  - Platform write semantics for account sync.
- Read: `packages/shared/src/utils.ts`
  - Pagination behavior for collections.
- Read: `packages/worker/src/cron.ts`
  - Scheduled sync, token refresh, calendar fetch, image download use.
- Read: `packages/worker/src/manage/oauth.ts`
  - OAuth authorize URL and code exchange use.
- Read: `packages/worker/src/manage/compare.ts`
  - Account compare call semantics.
- Read: `packages/worker/src/manage/sync-write.ts`
  - Account sync write orchestration.
- Read: `README.md`, `docs/superpowers/specs/**`, `docs/superpowers/plans/**`
  - User-facing and design documentation API claims.

---

### Task 1: Build Runtime API Inventory

**Files:**
- Create: `docs/superpowers/reports/2026-06-25-bgm-api-audit.md`
- Read: `packages/shared/src/bgm-client.ts`
- Read: `packages/shared/src/platform/bgm.ts`
- Read: `packages/shared/src/utils.ts`
- Read: `packages/worker/src/cron.ts`
- Read: `packages/worker/src/manage/oauth.ts`
- Read: `packages/worker/src/manage/compare.ts`
- Read: `packages/worker/src/manage/sync-write.ts`

**Interfaces:**
- Consumes: current source files and `docs/superpowers/specs/2026-06-25-bgm-api-audit-design.md`.
- Produces: report section `Runtime API Inventory` with one row per actual bgm.tv network use.

- [ ] **Step 1: Verify audit design**

Run:

```bash
sed -n '1,220p' docs/superpowers/specs/2026-06-25-bgm-api-audit-design.md
```

Expected: the design includes runtime paths, documentation paths, evidence sources, P0/P1/P2 rules, and non-goals.

- [ ] **Step 2: Find runtime bgm.tv network calls**

Run:

```bash
rg -n "https?://(api\\.)?bgm\\.tv|/v0/|oauth/access_token|oauth/token_status|/calendar|Authorization|Bearer|fetch\\(" packages/shared/src packages/worker/src
```

Expected: matches in `packages/shared/src/bgm-client.ts`, `packages/shared/src/platform/bgm.ts`, `packages/shared/src/utils.ts`, `packages/worker/src/cron.ts`, `packages/worker/src/manage/oauth.ts`, `packages/worker/src/manage/compare.ts`, and `packages/worker/src/manage/sync-write.ts`.

- [ ] **Step 3: Read central wrapper and callers**

Run:

```bash
sed -n '1,240p' packages/shared/src/bgm-client.ts
sed -n '1,120p' packages/shared/src/platform/bgm.ts
sed -n '1,120p' packages/shared/src/utils.ts
sed -n '1,140p' packages/worker/src/manage/oauth.ts
sed -n '1,120p' packages/worker/src/manage/compare.ts
sed -n '1,120p' packages/worker/src/manage/sync-write.ts
sed -n '1,360p' packages/worker/src/cron.ts
```

Expected: enough context to map each API call to its endpoint, method, body, auth, response parsing, and caller semantics.

- [ ] **Step 4: Create report with runtime inventory**

Create `docs/superpowers/reports/2026-06-25-bgm-api-audit.md` with this structure:

```markdown
# bgm.tv API Usage Audit

## Scope

This report audits runtime bgm.tv API calls and API claims in README/design/plan docs. Runtime findings are prioritized separately from documentation debt.

## Evidence Sources

- `docs/example/api/bgm-api.json`
- `packages/shared/src/bgm-client.ts`
- `packages/shared/src/platform/bgm.ts`
- `packages/shared/src/utils.ts`
- `packages/worker/src/cron.ts`
- `packages/worker/src/manage/oauth.ts`
- `packages/worker/src/manage/compare.ts`
- `packages/worker/src/manage/sync-write.ts`
- `README.md`
- `docs/superpowers/specs/**`
- `docs/superpowers/plans/**`

## Runtime API Inventory

| ID | Location | Runtime use | Endpoint | Method | Auth | Body/query | Parser | Caller semantics |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INV-001 | `packages/shared/src/bgm-client.ts` | `getCollections()` | `/v0/users/{username}/collections` | GET | Optional Bearer via `this.headers()` | `subject_type=2`, `limit`, `offset` | JSON | Fetch anime collections for cron and account compare/sync |
| INV-002 | `packages/shared/src/bgm-client.ts` | `getSubject()` | `/v0/subjects/{subject_id}` | GET | Optional Bearer via `this.headers()` | path `subjectId` | JSON, 404 -> `null` | Fetch subject detail when needed |
| INV-003 | `packages/shared/src/bgm-client.ts` | `getCalendar()` | `/calendar` | GET | Optional Bearer via `this.headers()` | none | JSON | Fetch broadcast calendar for snapshots |
| INV-004 | `packages/shared/src/bgm-client.ts` | `downloadImage()` | arbitrary image URL from bgm.tv response | GET | none | URL from API response | `arrayBuffer()` | Cache subject/calendar images |
| INV-005 | `packages/shared/src/bgm-client.ts` | `oauthAccessToken()` | `https://bgm.tv/oauth/access_token` | POST | client credentials in JSON body | `authorization_code` grant | JSON | Exchange OAuth code |
| INV-006 | `packages/shared/src/bgm-client.ts` | `refreshAccessToken()` | `https://bgm.tv/oauth/access_token` | POST | client credentials in JSON body | `refresh_token` grant | JSON | Refresh stored token |
| INV-007 | `packages/shared/src/bgm-client.ts` | `tokenStatus()` | `https://bgm.tv/oauth/token_status` | POST | token in form body | `access_token` form field | JSON with fallback states | Probe token validity |
| INV-008 | `packages/shared/src/bgm-client.ts` | `patchCollection()` | `/v0/users/-/collections/{subject_id}` | PATCH | Bearer required | sync write body | shared `fetchJson()` | Write target account collection entry |
| INV-009 | `packages/shared/src/bgm-client.ts` | `getMe()` | `/v0/me` | GET | Bearer required | none | JSON | Resolve token owner username/id |

## Findings

Findings are added in Tasks 2 and 3 after spec and documentation comparison.

## Fix Batch Proposal

The final batch proposal is added in Task 4.
```

- [ ] **Step 5: Commit runtime inventory report**

Run:

```bash
git add docs/superpowers/reports/2026-06-25-bgm-api-audit.md
git commit -m "docs: inventory bgm api runtime usage"
git push
```

Expected: commit succeeds and remote branch receives the report inventory. If HTTPS push fails with transport errors, retry a one-off SSH-over-443 push:

```bash
git push ssh://git@ssh.github.com:443/markd3ng/BangumiTV.git HEAD:dev
```

### Task 2: Compare Runtime Calls Against API Evidence

**Files:**
- Modify: `docs/superpowers/reports/2026-06-25-bgm-api-audit.md`
- Read: `docs/example/api/bgm-api.json`
- Read: runtime files from Task 1

**Interfaces:**
- Consumes: `Runtime API Inventory` from Task 1.
- Produces: P0/P1 runtime findings with local OpenAPI evidence or explicit “规范缺口”.

- [ ] **Step 1: Query OpenAPI evidence for v0 endpoints**

Run:

```bash
jq '.paths["/v0/users/{username}/collections"]' docs/example/api/bgm-api.json
jq '.paths["/v0/subjects/{subject_id}"]' docs/example/api/bgm-api.json
jq '.paths["/v0/me"]' docs/example/api/bgm-api.json
jq '.paths["/v0/users/-/collections/{subject_id}"]' docs/example/api/bgm-api.json
jq '.components.schemas.UserSubjectCollectionModifyPayload' docs/example/api/bgm-api.json
jq '.components.parameters.default_query_limit' docs/example/api/bgm-api.json
jq '.components.schemas.SubjectType' docs/example/api/bgm-api.json
jq '.components.schemas.SubjectCollectionType' docs/example/api/bgm-api.json
```

Expected:

- collections GET has optional bearer, `subject_type`, `type`, `limit`, `offset`.
- default `limit` maximum is 50.
- `/v0/me` requires HTTPBearer.
- `/v0/users/-/collections/{subject_id}` supports POST and PATCH.
- POST/PATCH success response is 204.
- `ep_status` and `vol_status` say they are only for book progress.

- [x] **Step 2: Check local OpenAPI gaps**

Run:

```bash
jq '.paths | keys[]' docs/example/api/bgm-api.json | rg 'calendar|oauth|token_status|access_token' || true
```

Result: local OpenAPI includes `GET /calendar`; OAuth `access_token` and OAuth `token_status` are not covered by local paths. Mark OAuth endpoints as “规范缺口” unless another authoritative local reference is added.

- [ ] **Step 3: Add runtime findings**

Append or update `## Findings` in `docs/superpowers/reports/2026-06-25-bgm-api-audit.md` with these evidence-backed entries if confirmed by Steps 1-2:

```markdown
### P0 Findings

#### BGM-API-001: `fetchJson()` treats `204 No Content` as JSON

- **Location:** `packages/shared/src/bgm-client.ts`
- **Current use:** successful write endpoints flow through `fetchJson()` and end with `res.json()`.
- **Evidence:** local OpenAPI for `POST/PATCH /v0/users/-/collections/{subject_id}` lists `204` as successful response.
- **Impact:** successful writes can be reported as `Unexpected end of JSON input`.
- **Suggested fix:** return `undefined` or `null` for status `204`, before `res.json()`.
- **Verification:** add a shared test where `patchCollection()` receives `204` and does not throw.

#### BGM-API-002: account sync uses PATCH for upsert semantics

- **Location:** `packages/shared/src/bgm-client.ts`, `packages/shared/src/platform/bgm.ts`, `packages/worker/src/manage/sync-write.ts`
- **Current use:** sync writes call `patchCollection()` with `PATCH /v0/users/-/collections/{subject_id}`.
- **Evidence:** local OpenAPI describes `POST` as create-or-modify and `PATCH` as modify collection. PATCH 404 response says user does not exist or item is not collected.
- **Impact:** syncing an item that target account has not collected can fail with 404.
- **Suggested fix:** use POST for account sync write, or add a clearly named `upsertCollection()` method using POST and call that from `BgmPlatformClient.patchEntry()`.
- **Verification:** add a test that bgm platform sync writes use POST.
```

Add this P1 entry if confirmed:

```markdown
### P1 Findings

#### BGM-API-003: account sync only fetches anime collections

- **Location:** `packages/shared/src/bgm-client.ts`, `packages/shared/src/platform/bgm.ts`
- **Current use:** `getCollections()` always sends `subject_type=2`.
- **Evidence:** local OpenAPI `SubjectType` says `2` is anime; other valid subject types are book, music, game, and real.
- **Impact:** if product intent is full-account sync, non-anime collections are silently excluded. If product intent is anime-only, the current implementation is correct but docs/UI must say so.
- **Suggested fix:** decide product scope. Either rename/document as anime-only, or parameterize subject type and update UI/report copy.
- **Verification:** add a test or source assertion for intended query construction after scope decision.
```

Add this already-mitigated runtime/documentation bridge entry:

```markdown
#### BGM-API-004: `ep_status` and `vol_status` are invalid for non-book write bodies

- **Location:** `packages/shared/src/platform/bgm.ts`; historical docs/plans may still mention these fields for sync writes.
- **Current use:** current HEAD does not send these fields from `BgmPlatformClient.patchEntry()`.
- **Evidence:** local OpenAPI `UserSubjectCollectionModifyPayload` says both fields can only modify book progress.
- **Impact:** old deployments or docs that include these fields can trigger 400 on anime/movie/music/game/real subjects.
- **Suggested fix:** keep current runtime omission for anime sync; update active docs that imply these fields are general-purpose write fields.
- **Verification:** add a test that bgm platform write body excludes `ep_status` and `vol_status`.
```

- [ ] **Step 4: Commit runtime findings**

Run:

```bash
git add docs/superpowers/reports/2026-06-25-bgm-api-audit.md
git commit -m "docs: compare bgm runtime api usage"
git push
```

Expected: commit and push succeed, with SSH-over-443 fallback if HTTPS fails.

### Task 3: Audit README and Historical Docs

**Files:**
- Modify: `docs/superpowers/reports/2026-06-25-bgm-api-audit.md`
- Read: `README.md`
- Read: `docs/superpowers/specs/**`
- Read: `docs/superpowers/plans/**`

**Interfaces:**
- Consumes: report findings from Task 2.
- Produces: P2 documentation findings and a scoped list of docs to fix later.

- [ ] **Step 1: Search documentation API claims**

Run:

```bash
rg -n "PATCH /v0/users/-/collections|POST /v0/users/-/collections|ep_status|vol_status|/calendar|/v0/subjects/\\{subject_id\\}|oauth/access_token|token_status|subject_type=2|GET /calendar|GET /v0/users|Bearer|OptionalBearer" README.md docs/superpowers/specs docs/superpowers/plans
```

Expected: matches in README and historical design/plan docs. Treat archive-like historical plans as evidence of stale guidance, not automatically as files that must be rewritten.

- [ ] **Step 2: Classify documentation claims**

For each matched claim, classify it using these exact rules:

```text
P2-doc-active: README or current non-archive spec gives a wrong or misleading API fact.
P2-doc-historical: old design/plan contains stale API facts but represents implementation history.
No finding: docs accurately describe current intentional behavior or do not make an API fact claim.
```

- [ ] **Step 3: Add documentation findings**

Append `### P2 Findings` to the report. Include entries with this shape:

```markdown
### P2 Findings

#### BGM-API-101: active docs may describe sync write as PATCH

- **Location:** list exact README/spec paths and line numbers from `rg`.
- **Current text:** quote only the short API phrase, such as `PATCH /v0/users/-/collections/{subject_id}`.
- **Evidence:** runtime finding BGM-API-002 and local OpenAPI POST/PATCH semantics.
- **Impact:** future fixes may preserve update-only behavior by following stale docs.
- **Suggested fix:** update active docs to say account sync uses create-or-modify write semantics. Keep historical archive content unchanged unless it is presented as current guidance.
- **Verification:** `rg -n "PATCH /v0/users/-/collections" README.md docs/superpowers/specs`.

#### BGM-API-102: docs may imply `ep_status`/`vol_status` are general sync fields

- **Location:** list exact README/spec/plan paths and line numbers from `rg`.
- **Current text:** quote only short field names or short API phrase.
- **Evidence:** runtime finding BGM-API-004 and local OpenAPI field descriptions.
- **Impact:** future write-body changes can reintroduce 400s for non-book subjects.
- **Suggested fix:** active docs should say these fields are book-only and are not sent by anime account sync.
- **Verification:** `rg -n "ep_status|vol_status" README.md docs/superpowers/specs`.

#### BGM-API-103: docs mention API paths not covered by local OpenAPI

- **Location:** list exact paths and line numbers for OAuth `access_token` and OAuth `token_status`; `GET /calendar` is covered by local OpenAPI and should not be reported as a gap.
- **Current text:** quote the short API path.
- **Evidence:** `jq '.paths | keys[]' docs/example/api/bgm-api.json` does not include these paths.
- **Impact:** project rules require verification before writing API calls; these paths need an explicit evidence source before future edits.
- **Suggested fix:** add an evidence note or local reference for non-v0/OpenAPI-missing bgm.tv endpoints before changing their code.
- **Verification:** local OpenAPI gap command from Task 2.
```

- [ ] **Step 4: Commit documentation findings**

Run:

```bash
git add docs/superpowers/reports/2026-06-25-bgm-api-audit.md
git commit -m "docs: audit bgm api documentation claims"
git push
```

Expected: commit and push succeed, with SSH-over-443 fallback if HTTPS fails.

### Task 4: Finalize Fix Batch Proposal and Self-Review

**Files:**
- Modify: `docs/superpowers/reports/2026-06-25-bgm-api-audit.md`

**Interfaces:**
- Consumes: runtime and documentation findings from Tasks 2-3.
- Produces: complete audit report ready to drive a later fix plan.

- [ ] **Step 1: Add fix batch proposal**

Update `## Fix Batch Proposal` in the report:

```markdown
## Fix Batch Proposal

### Batch A: P0 runtime fixes

- Handle `204 No Content` before JSON parsing in the shared bgm client.
- Add an upsert write method using `POST /v0/users/-/collections/{subject_id}` for account sync.
- Keep `ep_status` and `vol_status` out of non-book sync write bodies.
- Add focused tests for `204`, write method, and write body.

### Batch B: P1 product semantics

- Decide whether account sync is anime-only or all-subject.
- If anime-only, make README/UI/report copy explicit.
- If all-subject, parameterize collection fetch by subject type and define merge behavior across subject classes before implementation.

### Batch C: P2 documentation sync

- Update README and active specs that describe current API behavior.
- Leave historical archive/plan files unchanged unless they are used as current guidance.
- Add a note for bgm.tv endpoints not covered by `docs/example/api/bgm-api.json`.
```

- [ ] **Step 2: Run placeholder and contradiction scan**

Run:

```bash
rg -n "T[B]D|T[O]DO|F[I]XME|待[定]|占[位]|implement l[a]ter|f[i]ll in" docs/superpowers/reports/2026-06-25-bgm-api-audit.md
rg -n "PATCH /v0/users/-/collections|204 No Content|subject_type=2|ep_status|vol_status|规范缺口" docs/superpowers/reports/2026-06-25-bgm-api-audit.md
```

Expected: first command returns no matches. Second command returns the intended findings and batch proposal references.

- [ ] **Step 3: Verify git diff**

Run:

```bash
git diff --check
git diff --stat
git diff -- docs/superpowers/reports/2026-06-25-bgm-api-audit.md
```

Expected: whitespace check passes and only the audit report has changed in this task.

- [ ] **Step 4: Commit final audit report**

Run:

```bash
git add docs/superpowers/reports/2026-06-25-bgm-api-audit.md
git commit -m "docs: finalize bgm api audit report"
git push
```

Expected: commit and push succeed, with SSH-over-443 fallback if HTTPS fails.

- [ ] **Step 5: Report completion to user**

Final response includes:

```text
Audit report complete: docs/superpowers/reports/2026-06-25-bgm-api-audit.md
Top runtime issues: 204 parsing, PATCH vs POST upsert semantics, book-only progress fields.
Next step: approve Batch A/B/C repair plan.
```
