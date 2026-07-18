---
comet_change: remediate-full-repository-audit
role: technical-design
canonical_spec: openspec
---

# 全仓审计剩余问题修复技术设计

## 设计边界

本 change 处理已归档协调与部署修复之后仍然存在的公开界面安全、Read API 契约、bgm.tv 章节同步、subject 404 生命周期和 Widget 资产漂移问题。OpenSpec delta spec 是行为与验收标准的唯一事实源；本文只描述实现结构、数据流和交付方法。

不重新设计 Durable Object、snapshot generation、Workflow 发布顺序或不可变部署协议，不改变公开 endpoint 路径，也不增加外部数据库、付费服务或 Token 持久化机制。

## 总体结构

修复沿现有包边界完成，并把可独立验证的责任收拢到小型 helper：

- `packages/widget` 负责输出上下文编码、动态 URL 校验、DOM 事件绑定和页面内 Token 状态。
- `apps/frontend-worker` 负责 Widget 与 operation HTML 的安全响应头；operation JSON 响应保持现有结构。
- `apps/read-worker` 负责严格查询参数解析、零收藏 health 完整响应和 cache 分页字段。
- `packages/bgm-api` 负责经本地 OpenAPI fixture 验证的章节分页与有界 PATCH；`apps/sync-worker` 负责把认证及部分失败映射为稳定 HTTP 结果。
- `apps/media-worker`、共享领域类型与存储层共同负责 24 小时 not-found tombstone，以及读取和刷新时的屏蔽规则。
- Widget 资产只沿 `packages/widget/assets/theme` → 生成脚本 → `packages/widget/src/generated-assets.ts` 流动，构建检查禁止旧副本恢复。

这些边界保持现有 Worker 拓扑不变，避免把一次安全与契约修复扩大为架构迁移。

## 公开 HTML 与 Widget 安全

### 渲染模型

采用混合渲染方案。静态控件、状态切换和交互事件使用 DOM API 与 `addEventListener`，不再生成 inline event handler。批量收藏卡片允许保留受控模板字符串，以控制大型现有 Widget 的回归范围，但每个插值点必须先按上下文处理：

- 可见文本和嵌入 `<pre>` 的 JSON 使用 HTML 文本编码。
- HTML 属性使用属性编码；数值和有限枚举在进入模板前验证，失败时采用安全默认值或拒绝渲染。
- 动态 URL 仅允许预期的 `https:`、`http:` 或明确的站内相对路径；`javascript:`、`data:` 等危险协议不得仅靠转义后输出。
- 外部新窗口链接固定包含 `rel="noopener noreferrer"`。

编码 helper 保持纯函数，以恶意标题、用户名、weekday、错误消息、引号和结束标签进行表驱动测试。测试既检查 payload 被显示为文本，也检查输出中不存在可执行事件属性或危险 URL。

### Token 生命周期

Token 只存在页面闭包或等价的当前文档内存状态中。初始化时删除历史 `sessionStorage` 的 `sync-tokenA` 和 `sync-tokenB`，之后不再调用浏览器存储写入 Token。刷新或重新打开页面后输入框为空，用户必须重新输入。

### 响应策略

公开 HTML 响应统一设置与页面实际依赖相容的最小 CSP，并至少包含 `frame-ancestors 'none'` 和 `base-uri 'none'`；同时设置 `X-Content-Type-Options: nosniff`。移除 inline handler 后，CSP 不需要为事件属性放宽。

Operation check 的内容协商保持兼容：JSON 请求继续返回原 JSON；HTML 请求把完整序列化 JSON 编码后放入 `<pre>`，并使用 `default-src 'none'`。安全头测试直接断言响应头和生成 HTML，而不依赖浏览器是否执行 payload。

## Read API 契约

### 严格参数解析

`type`、`page`、`limit` 和 `cursor` 通过集中 parser 完整匹配输入字符串。整数只接受完整十进制正整数字符串并在允许范围内；枚举只接受已声明值；cursor 必须通过现有 cursor 编解码规则验证。`2junk`、未知 type、越界 limit 和畸形 cursor 返回统一 400，不再静默采用部分解析值或默认值。缺省参数仍使用现有合法默认值。

### Health 与 cache

`/api/health` 的状态组装与收藏总数解耦。即使 `_total` 为零，也返回 collections、cache、cron、workflow 和更新时间等完整 `data`，并沿用已归档 change 的 effective workflow status 语义。

`/api/cache` 用 `page_subjects` 表示当前页条目数，删除分页响应中误导性的 `total_subjects`。cursor 的编码和继续分页方式不变。README 在相应实现提交中同步说明字段变更、400 行为和兼容边界。

## bgm.tv 章节同步与认证错误

实现前必须从 `docs/example/api/bgm-api.json` 再次确认章节收藏 GET/PATCH 的路径、方法、参数、认证和 payload；代码与测试只采用 fixture 中存在的接口。

读取章节收藏时每页请求 `limit=1000`，从 offset 0 开始累积，直到累计条目数达到响应 `total`。每轮 offset 按实际返回数量推进；如果尚未达到 `total` 却得到空页，则返回明确的上游分页错误，避免无限循环或把截断数据视为成功。

写入时将 episode ID 分成最多 100 个一批，顺序执行或沿用现有安全并发策略。每批记录范围、成功数量和标准化错误。所有批次成功才是完整成功；已有成功批次后发生失败时返回 partial/error 汇总，使调用方知道哪些写入已发生，不能通过重试整次操作而误认为零副作用。

Compare 在任一账户收到上游认证失败时返回稳定的非 200 认证错误。双账户均失败也不得落入空集合的成功比较。非认证的网络、限流和服务错误继续使用现有上游错误映射，避免把不同故障混为凭证问题。

## Subject 404 tombstone

仅确定的 subject detail 404 创建 tombstone。其公开投影为 `exists: false`、`nsfw: true`、`reason: not_found`，TTL 固定 24 小时。写 tombstone 时删除旧 detail 或确保所有读取路径优先识别 tombstone，从而不再向客户端返回已失效内容。

刷新入口在请求上游前检查有效 tombstone；TTL 内直接结束，不重复请求。TTL 到期后允许重新探测，恢复成功时用新 detail 替换 tombstone。网络异常、429 和 5xx 不创建 not-found tombstone，继续使用既有 stale-on-error 行为。

该逻辑保持现有 subject generation 协调：过期 generation 仍不得覆盖较新状态；tombstone 只是同一串行刷新路径中的一种结果，不绕过 coordinator 写入。

测试使用可控时钟覆盖写入前存在旧 detail、TTL 内读取与刷新、24 小时后恢复探测、404 后保守 NSFW，以及网络/429/5xx 不误写 tombstone。

### Implementation Divergence

实现将 tombstone 的读取语义收紧为持续 fail-closed：24 小时 TTL 只控制何时允许重新排队和探测，不代表到期后可以重新公开旧 detail、图片或快照字段。只要 metadata 仍是 confirmed-not-found，Read 和 Sync 都继续屏蔽旧数据；Media 只有在上游成功返回新 detail 并写入 `exists: true` 后才解除该状态。重复 404 会续写新的 24 小时 tombstone，401/403、其他终止错误和暂时性错误均不得回落到旧图片处理。

为兼容部署前已持久化的数据，旧 `reason: not_found_or_restricted` 且没有 `expires_at` 的 metadata 也按 confirmed-not-found 处理。它不参与 TTL 节流，而是立即安排一次安全重探测；在成功恢复或迁移为新 24 小时 tombstone 前仍保持 fail-closed。该偏差用于避免 TTL 边界、删除失败残留缓存和滚动部署期间重新暴露已确认失效的数据。

## Widget 资产生成链

在删除目录前，用 `rg`、构建入口和生成脚本证明 `packages/widget/assets/public` 与 `packages/widget/assets/theme/v1` 没有部署消费者。随后删除这些手工副本，只保留主题根目录中的手写文件和 `generated-assets.ts` 生成产物。

build check 重新生成或计算预期内容并与已提交产物比较，同时断言旧副本目录不存在。安全修复只编辑主题源码，再运行生成命令更新产物；不得直接维护多份 JS/HTML/CSS。

## 错误处理与兼容性

- 安全校验失败采用拒绝或安全降级，不把原始不可信值重新拼回错误 HTML。
- Read 参数错误返回 400 和稳定错误对象；合法缺省值及 endpoint 路径不变。
- 章节空页、批次失败和认证失败均是显式非完整成功，日志不得包含 Token。
- not-found tombstone 只代表确认的 404，暂时性故障继续允许旧缓存服务。
- `/api/cache` 的 `page_subjects` 是明确的 breaking response 字段；README 和回归测试与代码同时提交。

## 测试与交付

每个原子修复先增加失败测试，再实现到通过，并在提交前运行受影响包的测试、typecheck 和构建检查。核心回归矩阵包括：

- Widget、日历、compare 和 operation HTML 的脚本标签、事件属性、属性引号、危险 URL 与 `</pre><script>` payload。
- CSP、nosniff、frame/base、noopener，以及刷新后 Token 不可恢复。
- 零收藏 health、严格 query parser、cache 第二页 `page_subjects`。
- 1001+ 章节完整读取、未达 total 的空页、100 条 PATCH 分批和第二批失败。
- 单/双 Token 认证失败。
- 旧 detail 后 404、24 小时抑制、到期重探测和暂时性错误不写 tombstone。
- 生成资产一致性及旧目录禁止恢复。

完成定向验证后运行全量 `pnpm test`、`pnpm typecheck`、`pnpm build:check`、OpenSpec strict validation、`git diff --check` 与生产依赖审计，并进行 thorough code review。P0/P1/P2 均修复后，以已经进入 `dev` 历史的不可变 SHA 部署，验证公开响应、构建 SHA 和关键日志；再创建 PR、等待检查、合并并归档 change。

## 迁移与回滚

交付顺序为安全边界、Read 契约、章节/认证、tombstone、资产清理。每步是独立提交并立即推送，出现回归时可回退对应代码提交，同时保留已兼容的数据结构。

Tombstone 不需要持久化 schema migration；旧代码必须能够忽略新增字段。若 tombstone 行为需回滚，应停止新写入并恢复旧读取逻辑，但不得重新暴露已确认 404 的旧 detail，生产处置应优先清理对应缓存。资产目录删除仅在消费者证明与 build check 通过后执行，回滚时仍从唯一主题源码重新生成，不恢复手工副本。
