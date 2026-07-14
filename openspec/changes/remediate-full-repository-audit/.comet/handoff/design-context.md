# Comet Design Handoff

- Change: remediate-full-repository-audit
- Phase: design
- Mode: compact
- Context hash: 3719cf168cba611e881e0771f482da3c823992ef4897ff8dd5a6ef7e8c30e57a

Generated-by: comet-handoff.sh

OpenSpec remains the canonical capability spec. This handoff is a deterministic, source-traceable context pack, not an agent-authored summary.

## openspec/changes/remediate-full-repository-audit/proposal.md

- Source: openspec/changes/remediate-full-repository-audit/proposal.md
- Lines: 1-34
- SHA256: 955ca9cb79802f11483581337374913d3b32f57cd8dc5679514d3330c114a3a5

```md
## Why

Durable coordination、严格快照读取与不可变部署已经归档，但全仓审计仍确认 Widget/operation log 存在未统一转义与浏览器 Token 持久化风险，公开 API 仍有零收藏、分页参数、认证失败、章节同步和 404 缓存生命周期等契约缺口。需要在同一审计补救 change 中清除剩余问题，避免局部修复后继续暴露安全或数据一致性漏洞。

## What Changes

- Widget 与 operation log 的所有不可信文本和属性值统一安全渲染，移除 inline event handler 和 sessionStorage Token，增加严格 CSP、nosniff、frame/base 限制与外链隔离。
- 删除未部署且已漂移的 Widget 资产副本，固定 `assets/theme` 为源码、`generated-assets.ts` 为唯一生成产物。
- `/api/health` 在零收藏时仍返回完整状态；`/api/cache` 使用准确分页字段并严格验证 type/page/limit/cursor，畸形输入返回 400。
- bgm.tv 章节收藏完整分页，PATCH 每批最多 100 个 episode ID，并显式报告部分失败。
- subject detail 404 写有 TTL 的保守 tombstone，停止返回旧 detail；compare 认证失败返回明确非 200。
- 增加恶意 HTML/属性注入、零收藏、严格参数、1001+ 章节、部分 PATCH 失败、404 tombstone 和双账户认证失败回归测试。
- **BREAKING** `/api/cache` 分页计数字段改为 `page_subjects`，删除误导性的分页 `total_subjects`；非法查询参数不再静默默认。

## Capabilities

### New Capabilities

- `public-interface-security`: 定义公开 HTML/Widget/operation log 的输出编码、浏览器 Token 生命周期、安全响应头和唯一资产来源。
- `public-read-contracts`: 定义 health/cache 等公开读取接口在零数据、分页、严格输入和错误响应下的稳定契约。

### Modified Capabilities

- `cache-refresh-lifecycle`: 增加 subject 404 tombstone、旧 detail 停止服务和明确 TTL 语义。
- `sync-consistency`: 增加章节收藏完整分页、分批 PATCH/部分失败和 compare 认证失败语义。
- `project-quality-gates`: 增加恶意输入、安全响应头、资产唯一来源及剩余审计场景的自动检查和文档同步要求。

## Impact

- 前端与 Widget：`packages/widget`、`apps/frontend-worker`、`assets/theme`、生成资产脚本与旧副本目录。
- Worker/API：`apps/read-worker`、`apps/sync-worker`、`apps/media-worker`。
- bgm.tv 客户端与领域逻辑：`packages/bgm-api`、`packages/domain`、`packages/storage`。
- 公共接口：`/api/health`、`/api/cache`、`/api/sync/compare`、operation check HTML/JSON。
- 文档与质量门禁：README、OpenSpec、测试、typecheck、build check、diff check 与生产依赖审计。
```

## openspec/changes/remediate-full-repository-audit/design.md

- Source: openspec/changes/remediate-full-repository-audit/design.md
- Lines: 1-66
- SHA256: 44172c77b7bd38abd11332fe97f603d5514fbd53b68015b7cf705dfd2dd6a539

```md
## Context

上一 change 已解决 Workflow/Media 并发、严格 snapshot、health 状态来源和不可变部署。本 change 只处理审计剩余问题：公开 HTML 仍混用字符串拼接，Token 仍可能进入 sessionStorage；read/cache 输入与零数据行为不稳定；bgm.tv 章节同步未完整分页/分批；subject 404 会继续暴露旧 detail；compare 认证失败可能伪装为空成功；仓库存在未部署的资产副本。

## Goals / Non-Goals

**Goals:**

- 所有不可信 UI 数据按文本/属性上下文编码，浏览器 Token 只存在当前页面内存。
- 公开 HTML 使用严格安全头，operation JSON 契约保持兼容。
- health/cache 参数、分页与零数据响应稳定且可测试。
- 章节读取完整分页，写入有界分批并显式表达部分失败。
- 404 subject 使用保守 tombstone 阻止旧 detail 回流并抑制重复请求。
- 删除漂移资产副本并建立唯一生成链路。

**Non-Goals:**

- 不改变公开 endpoint 路径，不引入新付费服务或外部数据库。
- 不重做已归档的 Durable Object、snapshot generation 或部署 revision 协议。
- 不持久化用户 Token，也不增加服务端 Token 存储。

## Decisions

### 1. 安全渲染按输出上下文集中处理

共享 Widget 提供 `escapeHtml`、`escapeAttribute` 与有限数值/枚举验证；动态内容默认以 DOM text API 或编码后的模板输出。移除 inline handler，外链固定 `noopener noreferrer`。HTML 响应统一 CSP、nosniff、frame/base 限制；operation JSON 保持原结构，HTML pre 内容完整编码。选择集中 helper 而不是逐调用点临时替换，以便测试所有入口并减少遗漏。

### 2. Token 只保留在页面内存

页面初始化主动删除历史 `sync-tokenA`/`sync-tokenB` sessionStorage 项，之后不再写入任何浏览器存储。刷新要求重新输入，换取最小凭证驻留面。

### 3. Read API 使用严格解析和明确分页语义

`type/page/limit/cursor` 必须完整匹配允许格式；畸形值返回 400。cache 当前页数量改为 `page_subjects`，cursor 形态保持兼容。health 不以收藏总数为返回完整 data 的前置条件，零收藏仍报告 collection/cache/cron/workflow。

### 4. 章节同步读取完整、写入有界

章节收藏用 `limit=1000` 循环 offset 直至达到上游 `total`；PATCH 按最多 100 个 episode ID 分批。每批结果进入结构化汇总，任一批失败时返回 partial/error，而不是宣称整次成功。所有 API path、字段和限制以仓库 OpenAPI fixture 为准。

### 5. 404 使用保守 tombstone

subject detail 404 删除或屏蔽旧 detail，写 `exists: false`、`nsfw: true`、`reason: not_found` 和明确 TTL。TTL 内读取端不得返回旧 detail，刷新端不得重复请求；到期后允许重新探测。

### 6. 资产只有一个源码和一个生成产物

删除 `assets/public`、`theme/v1` 等未部署副本；`assets/theme` 是唯一手写源码，`generated-assets.ts` 是唯一生成产物。build check 比对生成结果并拒绝漂移。

## Risks / Trade-offs

- [严格参数校验会让旧客户端的宽松输入失败] → 保持 endpoint/cursor 兼容，README 明确 400 行为。
- [内存 Token 降低便利性] → UI 明确刷新后需重新输入，不以安全换持久化便利。
- [tombstone 可能短期隐藏重新出现的 subject] → 使用明确有限 TTL，到期重新探测。
- [章节部分失败增加响应复杂度] → 保留顶层状态并提供逐批错误摘要，测试 1001+ 条目。
- [删除副本影响未知脚本] → 先用 `rg` 和 build contract 证明无部署消费者，再通过 `git rm` 删除。

## Migration Plan

1. 先上线安全编码、Token 清理和响应头，运行恶意 payload 回归。
2. 上线 read/cache 严格契约与文档，再上线章节分页/分批和 compare 认证语义。
3. 上线 tombstone schema/TTL，确认旧 detail 不再返回。
4. 最后删除已证明无消费者的资产副本并启用生成一致性门禁。
5. 全量测试、typecheck、build、diff、audit、thorough review；按 dev 不可变 SHA 部署并验证公开响应。

## Open Questions

- 无。tombstone TTL 已确认采用 24 小时。
```

## openspec/changes/remediate-full-repository-audit/tasks.md

- Source: openspec/changes/remediate-full-repository-audit/tasks.md
- Lines: 1-39
- SHA256: 27239c4557e914b912f775617f666202f5be5c68af250a14e2e4f83c66ea18d6

```md
## 1. 安全渲染与 Token 生命周期

- [ ] 1.1 为恶意标题、用户名、weekday、错误、属性值和 operation `</pre><script>` 增加 RED 回归测试
- [ ] 1.2 实现统一 HTML/属性编码与数值/枚举验证，移除 inline handler 并保护外链
- [ ] 1.3 删除 sessionStorage Token 持久化并在页面初始化清除历史 `sync-tokenA/B`
- [ ] 1.4 增加 CSP、nosniff、frame/base 限制并验证 JSON operation check 契约不变

## 2. Read API 严格契约

- [ ] 2.1 增加零收藏 health 仍返回完整 data 的 RED 测试并修复提前返回
- [ ] 2.2 增加 `page=2junk`、未知 type、非法 limit/cursor 的 RED 测试并实现完整字符串校验与 400
- [ ] 2.3 将 cache 当前页计数改为 `page_subjects`，保持 cursor 兼容并更新 README

## 3. bgm.tv 章节同步与认证错误

- [ ] 3.1 对照 `docs/example/api/bgm-api.json` 验证章节读取和 PATCH 接口字段、limit 与 payload
- [ ] 3.2 增加 1001+ 章节收藏分页 RED 测试并实现 `limit=1000` offset 循环
- [ ] 3.3 增加每批最多 100 ID 和第二批失败 RED 测试，实现分批 PATCH 与 partial/error 汇总
- [ ] 3.4 增加单/双账户无效 Token compare RED 测试，返回稳定非 200 认证错误

## 4. Subject 404 tombstone

- [ ] 4.1 增加已有 detail 后刷新 404、TTL 内不重复请求的 RED 测试
- [ ] 4.2 定义 tombstone 类型、key/TTL 与保守 NSFW 投影，404 时停止返回旧 detail
- [ ] 4.3 验证 tombstone 到期后允许重新探测且 generation 协调语义不倒退

## 5. Widget 资产唯一来源

- [ ] 5.1 使用 `rg` 与构建入口证明旧 `assets/public`、`theme/v1` 副本无部署消费者
- [ ] 5.2 删除旧副本并增加源码、生成产物、部署入口一致性测试
- [ ] 5.3 更新 README 与生成说明，明确 `assets/theme` 和 `generated-assets.ts` 唯一链路

## 6. 验证、审查与交付

- [ ] 6.1 运行相关包 RED→GREEN 测试、typecheck、Wrangler dry-run 与 diff check，并按安全/API/缓存边界原子 commit/push
- [ ] 6.2 运行全量 `pnpm test`、`pnpm typecheck`、`pnpm build:check`、OpenSpec strict、`git diff --check` 与 `pnpm audit --prod`
- [ ] 6.3 完成 thorough code review，修复全部 P0/P1/P2 并记录验证报告
- [ ] 6.4 以 dev 不可变 SHA 部署，验证公开安全头、恶意 payload、health/cache/compare/tombstone 行为与 footer SHA
- [ ] 6.5 创建 PR、等待检查、合并并归档 change
```

## openspec/changes/remediate-full-repository-audit/specs/cache-refresh-lifecycle/spec.md

- Source: openspec/changes/remediate-full-repository-audit/specs/cache-refresh-lifecycle/spec.md
- Lines: 1-16
- SHA256: b45e852dd9d0df50bc267601194e6234ce313fb2927717e7062a0f54ab5d685a

```md
## ADDED Requirements

### Requirement: subject 404 必须建立保守 tombstone
subject detail 返回 404 时，系统 MUST 停止返回旧 detail，并写入 TTL 为 24 小时的 `exists: false`、`nsfw: true`、`reason: not_found` tombstone。

#### Scenario: 已缓存 subject 后变成 404
- **WHEN** 刷新已缓存 subject 得到 404
- **THEN** 旧 detail 不再返回且读取端采用保守 NSFW 元数据

#### Scenario: tombstone TTL 内再次刷新
- **WHEN** 同一 subject 在 tombstone TTL 到期前再次进入刷新路径
- **THEN** 系统不重复请求 subject detail 上游

#### Scenario: 上游网络或服务错误
- **WHEN** subject detail 请求因网络、429 或 5xx 失败
- **THEN** 系统不得写 not_found tombstone，并继续使用既有 stale-on-error 语义
```

## openspec/changes/remediate-full-repository-audit/specs/project-quality-gates/spec.md

- Source: openspec/changes/remediate-full-repository-audit/specs/project-quality-gates/spec.md
- Lines: 1-21
- SHA256: 2e5b439c5570ddc3127b97d6e55f7cc4bf25f30d4d53d61637d3f918250a910a

```md
## MODIFIED Requirements

### Requirement: 高风险逻辑必须有自动检查
合并、primary 失败保护、管理鉴权、同步输入验证、Workflow 幂等发布、Queue 去重、部署业务解耦、公开输出编码、严格查询参数、章节分页/分批与 404 tombstone MUST 有可运行的自动测试。

#### Scenario: Workflow enqueue 被重放
- **WHEN** 测试重复执行相同 enqueue step
- **THEN** 测试验证相同 `job_id` 不会产生重复媒体副作用

#### Scenario: 恶意数据进入公开 HTML
- **WHEN** 测试注入脚本标签、事件属性和 pre 结束标签
- **THEN** 测试验证输出不可执行且安全响应头完整

## ADDED Requirements

### Requirement: 资产生成链路必须防止副本漂移
质量门禁 MUST 验证 Widget 主题源码、生成产物和部署入口一致，并拒绝已删除的手工副本重新出现。

#### Scenario: 旧 Widget 副本被重新加入
- **WHEN** `assets/public` 或 `theme/v1` 再次包含部署资产副本
- **THEN** 自动检查失败并指向唯一源码链路
```

## openspec/changes/remediate-full-repository-audit/specs/public-interface-security/spec.md

- Source: openspec/changes/remediate-full-repository-audit/specs/public-interface-security/spec.md
- Lines: 1-33
- SHA256: ec219c7443fc732c2f08d61b8cafe2e910de41a79161714456318652489afcae

```md
## ADDED Requirements

### Requirement: 公开 HTML 必须按上下文编码不可信数据
系统 MUST 对标题、用户名、weekday、错误、JSON 文本和属性值使用与输出上下文匹配的编码，禁止未经处理的数据形成可执行 HTML。

#### Scenario: 恶意标题与错误进入页面
- **WHEN** API 数据包含 `<img onerror>`、引号属性注入或 `</pre><script>`
- **THEN** 响应只显示文本且不得包含可执行 payload

#### Scenario: 动态 URL 使用危险协议
- **WHEN** API 数据或配置提供 `javascript:` 等非允许协议 URL
- **THEN** 系统拒绝该 URL 或回退安全值，不得仅做 HTML 编码后输出

### Requirement: 浏览器 Token 不得持久化
同步 Token MUST 仅保存在当前页面内存，页面初始化 MUST 清除历史 `sync-tokenA` 与 `sync-tokenB` sessionStorage 项。

#### Scenario: 页面刷新
- **WHEN** 用户刷新同步页面
- **THEN** 页面没有可恢复 Token 且要求重新输入

### Requirement: 公开 HTML 必须使用严格浏览器安全策略
HTML 响应 MUST 禁止 inline event handler，设置 CSP、`X-Content-Type-Options: nosniff`、frame/base 限制，并为外链设置 `rel="noopener noreferrer"`。

#### Scenario: 加载 Widget 或 operation 页面
- **WHEN** 浏览器请求公开 HTML
- **THEN** 响应头和链接属性阻止脚本注入、嗅探、嵌套与 opener 访问

### Requirement: Widget 资产必须有唯一来源
仓库 MUST 只以 `assets/theme` 作为手写 Widget 源码、`generated-assets.ts` 作为生成产物，不得保留未部署且手工同步的副本。

#### Scenario: 生成资产漂移
- **WHEN** 生成产物与主题源码不一致或旧副本重新出现
- **THEN** build check 失败
```

## openspec/changes/remediate-full-repository-audit/specs/public-read-contracts/spec.md

- Source: openspec/changes/remediate-full-repository-audit/specs/public-read-contracts/spec.md
- Lines: 1-22
- SHA256: e2d4737edaa2179ae887812b5a9199fb12912de1b934d5331d52e28dcba006cd

```md
## ADDED Requirements

### Requirement: health 在零收藏时必须返回完整状态
`/api/health` MUST 在收藏总数为零时仍返回 collections、cache、cron 与 workflow 数据。

#### Scenario: 新账户没有收藏
- **WHEN** snapshot summary 的总数为零
- **THEN** health 返回 200 和完整 `data`，不得提前返回空结构

### Requirement: cache 分页字段必须表达当前页数量
`/api/cache` MUST 使用 `page_subjects` 表达当前页数量，不得把分页结果标记为全局 `total_subjects`；cursor MUST 保持兼容。

#### Scenario: cache 返回第二页
- **WHEN** 客户端使用 cursor 请求下一页
- **THEN** `page_subjects` 等于当前页条目数且 next cursor 可继续使用

### Requirement: 公开读取参数必须严格验证
系统 MUST 完整验证 `type`、`page`、`limit` 与 `cursor` 字符串；未知枚举、尾随字符或畸形 cursor MUST 返回 400。

#### Scenario: page 含尾随字符
- **WHEN** 客户端请求 `page=2junk`
- **THEN** 系统返回 400 且不静默采用 page 2 或默认值
```

## openspec/changes/remediate-full-repository-audit/specs/sync-consistency/spec.md

- Source: openspec/changes/remediate-full-repository-audit/specs/sync-consistency/spec.md
- Lines: 1-26
- SHA256: 0c5ff1f3f268a02d07f213114ba38a6033b1f1aa041cd0936844cf27dec88201

```md
## ADDED Requirements

### Requirement: 章节收藏同步必须完整分页
系统 MUST 以 bgm.tv 允许的 `limit=1000` 循环 offset 读取章节收藏，直到已读取数量达到响应 `total`。

#### Scenario: 账户有超过一千个章节收藏
- **WHEN** 上游报告 1001 个章节收藏
- **THEN** compare/apply 使用全部 1001 个结果而不是只使用第一页

#### Scenario: 未达到 total 时上游返回空页
- **WHEN** 已累计结果少于 `total` 且下一页 `data` 为空
- **THEN** 系统以明确上游分页错误终止，不得无限循环或返回截断成功结果

### Requirement: 章节写入必须分批并报告部分失败
系统 MUST 将 episode ID 按每批最多 100 个执行 PATCH，并在任一批失败时报告 partial/error 与失败批次，不得宣称静默成功。

#### Scenario: 第二批 PATCH 失败
- **WHEN** 第一批成功而第二批返回错误
- **THEN** 响应明确报告已成功与失败批次并且整体不为完整成功

### Requirement: compare 认证失败不得返回空成功结果
任一账户认证失败时 compare MUST 返回明确非 200 认证错误；双账户失败不得返回空的成功比较。

#### Scenario: 两个 Token 都无效
- **WHEN** compare 的源和目标账户均返回认证失败
- **THEN** endpoint 返回非 200 且包含稳定认证错误码
```
