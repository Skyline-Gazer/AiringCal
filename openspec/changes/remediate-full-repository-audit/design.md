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

- tombstone 的最终 TTL 在实施时依据现有 refresh 常量与测试时钟选择，必须短于常规 6～8 天刷新窗口并写入公开类型。
