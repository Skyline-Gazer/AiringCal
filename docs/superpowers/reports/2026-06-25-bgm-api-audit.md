# bgm.tv API 使用审计报告

## 范围

本报告审计项目中实际运行的 bgm.tv API 调用，以及 README、设计文档、计划文档中的 API 描述。运行缺陷和文档债分开分级，避免把历史记录误当成当前缺陷。

## 证据来源

- `docs/example/api/bgm-api.json`
- `packages/shared/src/bgm-client.ts`
- `packages/shared/src/platform/bgm.ts`
- `packages/shared/src/utils.ts`
- `packages/worker/src/cron.ts`
- `packages/worker/src/sync/compare.ts`
- `packages/worker/src/sync/apply.ts`
- `README.md`
- `docs/superpowers/specs/**`
- `docs/superpowers/plans/**`

## 运行 API 清单

| ID | 位置 | 运行用途 | Endpoint | 方法 | 认证 | Body/query | 解析 | 调用语义 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INV-001 | `packages/shared/src/bgm-client.ts` | `getCollections()` | `/v0/users/{username}/collections` | GET | `this.headers()` 可选 Bearer | `subject_type=2`, `limit`, `offset` | JSON | 拉取动画收藏，供 cron、账户对比和账户同步使用 |
| INV-002 | `packages/shared/src/bgm-client.ts` | `getSubject()` | `/v0/subjects/{subject_id}` | GET | `this.headers()` 可选 Bearer | path `subjectId` | JSON，404 -> `null` | 按需拉取条目详情 |
| INV-003 | `packages/shared/src/bgm-client.ts` | `getCalendar()` | `/calendar` | GET | `this.headers()` 可选 Bearer | 无 | JSON | 拉取每日放送日历写入快照 |
| INV-004 | `packages/shared/src/bgm-client.ts` | `downloadImage()` | bgm.tv 响应中的图片 URL | GET | 无 | API 响应里的 URL | `arrayBuffer()` | 缓存收藏和日历图片 |
| INV-005 | `packages/shared/src/bgm-client.ts` | `oauthAccessToken()` | `https://bgm.tv/oauth/access_token` | POST | JSON body 中的 client 凭据 | `authorization_code` grant | JSON | OAuth code 换 token |
| INV-006 | `packages/shared/src/bgm-client.ts` | `refreshAccessToken()` | `https://bgm.tv/oauth/access_token` | POST | JSON body 中的 client 凭据 | `refresh_token` grant | JSON | 刷新已保存 token |
| INV-007 | `packages/shared/src/bgm-client.ts` | `tokenStatus()` | `https://bgm.tv/oauth/token_status` | POST | form body 中的 token | `access_token` form 字段 | JSON + fallback 状态 | 探测 token 是否有效 |
| INV-008 | `packages/shared/src/bgm-client.ts` | `patchCollection()` | `/v0/users/-/collections/{subject_id}` | PATCH | 必须 Bearer | 调用方 body | shared `fetchJson()` | 修改目标账号已有收藏 |
| INV-009 | `packages/shared/src/bgm-client.ts` | `getMe()` | `/v0/me` | GET | 必须 Bearer | 无 | JSON | 解析 token 对应的当前用户 username/id |
| INV-010 | `packages/shared/src/bgm-client.ts` | `upsertCollection()` | `/v0/users/-/collections/{subject_id}` | POST | 必须 Bearer | 同步写入 body | shared `fetchJson()` | 为账户同步创建或更新目标账号收藏 |

## 问题清单

### P0 问题

#### BGM-API-001：`fetchJson()` 曾把 `204 No Content` 当成 JSON 解析

- **位置：** `packages/shared/src/bgm-client.ts:73`, `packages/shared/src/bgm-client.ts:98`, `packages/shared/src/bgm-client.ts:198`
- **原写法：** 写入类 endpoint 成功后进入 `fetchJson()`，最后无条件解析 JSON；第一轮修复只对 `204` 短路。
- **证据：** 本地 OpenAPI 中 `POST/PATCH /v0/users/-/collections/{subject_id}` 的成功响应是 `204`；实际兼容层仍需接受其他 2xx 空响应体，否则会抛 `Unexpected end of JSON input`。
- **影响：** 写入已经成功时仍可能被报告为 `Unexpected end of JSON input`。
- **建议修法：** 成功响应先读取文本；空 body 直接返回 `undefined`，非空 body 再解析 JSON。
- **验证方式：** 增加 shared 测试，模拟 `patchCollection()` 收到 `204` 和 `upsertCollection()` 收到 `200` 空 body 时都不抛错。
- **状态：** 已修复；shared 测试覆盖 `204` 和 2xx 空响应体。

#### BGM-API-002：账户同步曾用 PATCH 执行 upsert 语义

- **位置：** `packages/shared/src/bgm-client.ts:198`, `packages/shared/src/platform/bgm.ts:43`, `packages/worker/src/sync/apply.ts:72`
- **原写法：** 同步写入调用 `patchCollection()`，请求为 `PATCH /v0/users/-/collections/{subject_id}`。
- **证据：** 本地 OpenAPI 描述 `POST /v0/users/-/collections/{subject_id}` 是“新增或修改”；同一条目的 `PATCH` 是修改已有收藏，404 语义包含“条目未收藏”。
- **影响：** 目标账号尚未收藏某条目时，同步可能 404。
- **建议修法：** 增加语义明确的 `upsertCollection()`，使用 `POST`，并由 `BgmPlatformClient.patchEntry()` 调用。
- **验证方式：** 增加测试确认 bgm 平台同步写入使用 `POST`。
- **状态：** 已在 批次 A 修复；`BgmPlatformClient.patchEntry()` 现在调用 `upsertCollection()`。

### P1 问题

#### BGM-API-003：账户同步只拉取动画收藏

- **位置：** `packages/shared/src/bgm-client.ts:101`, `packages/shared/src/platform/bgm.ts:30`, `packages/shared/src/utils.ts:6`
- **当前写法：** `getCollections()` 固定发送 `subject_type=2`。
- **证据：** 本地 OpenAPI `SubjectType` 说明 `2` 是动画；其他合法类型还有书籍、音乐、游戏、三次元。
- **影响：** 如果产品预期是全账户同步，书籍/音乐/游戏/三次元会被静默排除。
- **决策：** 批次 B 已明确产品口径：账户同步继续只同步动画收藏。
- **建议修法：** 不扩展全类型；把 README、首页同步视图、嵌入页和报告文案全部写成“动画同步”。
- **验证方式：** public 前端测试断言首页同步视图按动画同步口径发送请求。
- **状态：** 批次 B 已按动画同步口径推进。

#### BGM-API-004：OAuth token endpoint 不在本地 OpenAPI 文件中

- **位置：** `packages/shared/src/bgm-client.ts:135`, `packages/shared/src/bgm-client.ts:151`, `packages/shared/src/bgm-client.ts:171`
- **当前写法：** token refresh 和 token status 使用 `https://bgm.tv/oauth/...`；旧 `/manage` OAuth 授权与 exchange 路由已移除。
- **证据：** `jq '.paths | keys[]' docs/example/api/bgm-api.json | rg 'oauth|token_status|access_token'` 无匹配。`/calendar` 已由本地 OpenAPI 覆盖，OAuth 才是缺口。
- **影响：** 项目规则要求修改 API 调用前必须验证；后续改 OAuth 逻辑时需要额外权威证据。
- **建议修法：** 修改 refresh 或 token status 行为前，补充或引用 `access_token`、`token_status` 的本地证据来源。
- **验证方式：** 保留本地 OpenAPI 缺口查询命令，未来计划中单独处理。

#### BGM-API-005：`ep_status` 和 `vol_status` 不能作为非书籍写入字段

- **位置：** `packages/shared/src/platform/bgm.ts:46`；历史文档/计划仍可能把这些字段写进同步 body。
- **当前写法：** 当前 HEAD 的 `BgmPlatformClient.patchEntry()` 不再发送这两个字段。
- **证据：** 本地 OpenAPI `UserSubjectCollectionModifyPayload` 写明两个字段只能修改书籍进度。
- **影响：** 旧部署或过期文档若继续传这两个字段，动画、音乐、游戏、三次元条目会 400。
- **建议修法：** 保持当前动画同步不传这两个字段；修正仍把它们描述为通用同步字段的活跃文档。
- **验证方式：** 测试确认 bgm 平台写入 body 不含 `ep_status` 和 `vol_status`。
- **状态：** 运行逻辑已在 批次 A 覆盖；账户同步的“差异”口径只按当前可写入的动画字段 `type` 和 `rate` 判断，动画话数进度差异不再作为可同步差异。

#### BGM-API-006：账户同步曾发送会覆盖目标标签和评价的字段

- **位置：** `packages/shared/src/platform/bgm.ts:47`；历史设计文档中同步写回 body 曾包含 `tags` 和 `comment`。
- **原写法：** 动画同步写入 body 固定包含 `tags: []` 和 `comment: ''`。
- **证据：** 本地 OpenAPI `UserSubjectCollectionModifyPayload.tags` 写明“不传或者 `null` 都会被忽略，传 `[]` 则会删除所有 tag”；`comment` 是收藏评价字段。
- **影响：** 同步动画状态和评分时，会无意清空目标账号该条目的标签和评价。
- **建议修法：** 当前动画同步只发送 `type` 和 `rate`；除非产品明确支持标签/评价同步，否则不要发送 `tags` 或 `comment`。
- **验证方式：** 测试确认 bgm 平台写入 body 只包含动画同步需要的安全字段。
- **状态：** 已修复；`BgmPlatformClient.patchEntry()` 不再发送 `tags` 和 `comment`。

#### BGM-API-007：完整同步曾信任前端传入的源用户名

- **位置：** `packages/worker/src/sync/apply.ts:60`；已删除的旧 `packages/worker/src/manage/index.html` 曾有同类问题
- **原写法：** 前端完整同步请求把 `from` 组装为 `Account A` / `Account B` 等展示文本，后端 full 模式再用该字段调用 `fetchCollections()` 拉源账号收藏。
- **证据：** `BgmPlatformClient.fetchCollections()` 需要真实 bgm.tv username；`getMe(token)` 已能从 token 解析真实 username。
- **影响：** 完整同步可能没有按真实源账号的全部动画收藏执行，表现为只同步少量条目，而不是对比页显示的几百条源账号独有收藏。
- **建议修法：** 后端同步时用源 token 调用 `getMe()`，以 token owner username 拉源收藏；前端传入的 `from/to` 只作为兼容字段，不作为数据源身份。
- **验证方式：** worker 同步测试模拟 `from: "Account A"`，断言 full 模式仍使用 `real-source-user` 拉取源收藏，并同步所有源条目。
- **状态：** 已修复；`executeSync()` full/partial 目标集合均来自 token owner username。

#### BGM-API-008：公开同步页曾向同步 API 发送 `A` / `B` 占位用户名

- **位置：** `public/src/bangumi.js:547`
- **原写法：** 黄色公开同步页调用同步 API 时，把 `from/to` 写成 `A` / `B`，而不是 compare 阶段返回的真实 bgm.tv username。
- **证据：** 截图中的 UI 来自 `public/src/bangumi.js` / `public/src/bangumi.css`，不是 `packages/worker/src/manage/index.html`；后端旧版本会使用 `from` 拉源收藏。
- **影响：** 当前端或后端任一侧仍在旧版本时，完整同步可能只执行少量条目，和对比页显示的几百条源账号收藏不一致。
- **建议修法：** 公开同步页从 `syncState.data.userA.name/userB.name` 读取真实用户名发给 `/api/sync/apply`；同步结果同时显示预计项数和后端返回项数，便于区分前端发错、后端执行少、或部署缓存问题。
- **验证方式：** public 前端静态测试断言同步请求使用 compare 返回的用户名，并显示 `results.length` 诊断信息。
- **状态：** 已修复；`public/src/bangumi.js` 不再发送 `A` / `B` 作为同步用户名。

#### BGM-API-009：旧 `/manage` 页面和管理 OAuth 流会误导当前同步入口

- **位置：** `packages/worker/src/index.ts`；旧 `packages/worker/src/manage/index.html`、`packages/worker/src/manage/oauth.ts`、`/api/manage/oauth-url`、`/api/manage/exchange`
- **原写法：** Worker 暴露 `/manage` 和 `/manage/callback` 页面路由，同时保留管理 OAuth URL/exchange API。
- **证据：** 当前产品入口已经是 Worker 首页的「动画同步」视图，用户直接粘贴两个 bgm.tv developer access token；截图和当前前端代码均来自 `public/src/bangumi.js`。
- **影响：** 旧页面和旧 OAuth 入口会让排查方向偏到已废弃 UI，且继续产生 `/manage/callback` 这类无效 URI。
- **建议修法：** 删除 `/manage`、`/manage/callback`、管理 OAuth API、未挂载旧 HTML 和孤立 OAuth helper；首页同步视图改用同步语义 API：`POST /api/sync/compare`、`POST /api/sync/apply`。
- **验证方式：** worker security 测试断言旧页面/OAuth 路由和 helper 不存在，同时同步 API 仍存在。
- **状态：** 已修复。

### P2 问题

#### BGM-API-101：审计设计/计划曾误把 `/calendar` 列成本地 OpenAPI 缺口

- **位置：** `docs/superpowers/specs/2026-06-25-bgm-api-audit-design.md:49`, `docs/superpowers/specs/2026-06-25-bgm-api-audit-design.md:81`, `docs/superpowers/plans/2026-06-25-bgm-api-audit.md:205`, `docs/superpowers/plans/2026-06-25-bgm-api-audit.md:208`
- **原文本：** 把 `/calendar` 与 OAuth `access_token`、`token_status` 一起列为本地 OpenAPI 未覆盖。
- **证据：** 本地 OpenAPI 包含 `GET /calendar`，operationId 为 `getCalendar`。真正缺口是 OAuth 路径。
- **影响：** 后续审计或修复可能误以为 `/calendar` 缺少规范证据。
- **处理结果：** 已更新活跃审计设计/计划，说明 `/calendar` 已覆盖，OAuth endpoint 才未覆盖。
- **验证方式：** `jq '.paths["/calendar"]' docs/example/api/bgm-api.json`。

#### BGM-API-102：历史 Cloudflare 设计仍写着 PATCH + 书籍专用字段

- **位置：** `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:285`, `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:286`, `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:452`
- **原文本：** 同步写回使用 `PATCH /v0/users/-/collections/{subject_id}`，body 包含 `{ ep_status, vol_status, type, rate, tags, comment }`。
- **证据：** BGM-API-002、BGM-API-005 和 BGM-API-006；本地 OpenAPI 说明 POST 是新增或修改，`ep_status`/`vol_status` 只能用于书籍，`tags: []` 会删除目标条目所有 tag。
- **影响：** 该文件位于活跃 `docs/superpowers/specs` 下，后续实现可能复制过期语义。
- **处理结果：** 已在历史设计中加入更正说明，并把相关同步步骤/API checklist 更新为 POST upsert；动画同步只发送 `type` 和 `rate`，不传书籍专用字段，也不清空目标标签或评价。
- **验证方式：** `rg -n "PATCH /v0/users/-/collections|请求体：.*tags|请求体：.*comment" docs/superpowers/specs`。

#### BGM-API-103：部分同步文档曾暗示全账户同步，但运行逻辑只同步动画

- **位置：** `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:272`, `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:274`, `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:235`
- **原文本：** “完整同步”写作同步源账户全部收藏状态，同时 API 流程使用 `subject_type=2`。
- **证据：** BGM-API-003；本地 OpenAPI `SubjectType` 说明 `2` 是动画。
- **影响：** 用户或后续实现者可能误以为书籍/音乐/游戏/三次元也会同步。
- **决策：** 批次 B 已定为“继续只同步动画收藏”。
- **处理结果：** README、首页同步视图、嵌入页和当前仍可能作为指导的设计文档已统一使用“动画同步”措辞。
- **验证方式：** `rg -n "全部收藏|subject_type=2|多账户同步" README.md docs/superpowers/specs docs/superpowers/plans`。

#### BGM-API-104：OAuth 路径需要额外非 OpenAPI 证据

- **位置：** `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:265`, `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:266`, `docs/superpowers/specs/2026-06-16-cloudflare-migration-design.md:454`, `docs/superpowers/plans/2026-06-22-stabilize-sync-consistency.md:206`
- **当前文本：** 文档提到 `https://bgm.tv/oauth/authorize`、`https://bgm.tv/oauth/access_token`、`https://bgm.tv/oauth/token_status`。
- **证据：** BGM-API-004；本地 OpenAPI 没有 OAuth paths。
- **影响：** 未来修改 OAuth 调用时可能违反“修改 API 前先验证”的项目规则。
- **建议修法：** 修改这些调用前，增加本地 OAuth reference 或引用权威来源。
- **验证方式：** `jq '.paths | keys[]' docs/example/api/bgm-api.json | rg 'oauth|token_status|access_token' || true`。

## 修复批次建议

### 批次 A：P0 运行修复

状态：已实现。

- 在 shared bgm client 中，2xx 空响应体直接视为成功，不再解析 JSON。
- 账户同步写回新增 `POST /v0/users/-/collections/{subject_id}` 的 upsert 方法。
- 非书籍同步写入 body 不包含 `ep_status` 和 `vol_status`。
- 动画同步写入 body 不包含会覆盖目标账号标签/评价的 `tags` 和 `comment`。
- 已增加针对 `204`、2xx 空响应体、写入方法、写入 body 的聚焦测试。

### 批次 B：P1 产品语义

状态：已完成。

- 账户同步继续只使用 `subject_type=2`。
- README、首页同步视图、嵌入页和报告文案统一写成“动画同步”。
- 不扩展书籍/音乐/游戏/三次元同步。
- 旧 `/manage` OAuth 授权入口已移除；cron token 继续通过部署环境变量配置。
- 旧 `/api/manage/*` 同步 API 已由 `/api/sync/*` 替代；当前产品入口以首页动画同步视图为准，不保留旧管理 API 兼容别名。

### 批次 C：P2 文档同步

状态：已处理。

- 已更新活跃审计设计/计划，移除 `/calendar` 是本地 OpenAPI 缺口的错误说法。
- 已更新当前仍可能作为指导的 Cloudflare 迁移设计，将账户同步说明改为动画同步、POST upsert，且只写 `type` 和 `rate`。
- 已移除运行代码中的旧 `/manage` 页面、`/manage/callback`、管理 OAuth exchange 流和旧 `/api/manage/*` 同步/诊断 API，并同步 README/审计报告。
- 旧实施计划保持历史记录，除非它被当作当前指导文档使用。
- 已为 `docs/example/api/bgm-api.json` 未覆盖的 OAuth endpoint 保留说明。
