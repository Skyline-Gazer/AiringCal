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
