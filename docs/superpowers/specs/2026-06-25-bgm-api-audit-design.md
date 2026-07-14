# bgm.tv API 使用审计设计

## 目标

完整审计项目中 bgm.tv API 的实际调用和用户可见文档描述，找出当前错误、潜在错误和过期说明，形成一次性修复依据。

本阶段只产出审计报告设计，不修改运行代码。

## 范围

审计覆盖两类来源。

### 运行路径

- `packages/shared/src/bgm-client.ts`
- cron 同步与 token 刷新
- 首页动画同步视图调用的 compare/sync API
- cron token refresh 与 token status
- 图片下载与日历同步

每个调用点检查：

- endpoint
- HTTP method
- path/query 参数
- request body
- auth 方式
- 成功和失败状态码
- response body 解析
- 调用方业务语义

### 文档路径

- `README.md`
- `docs/superpowers/specs/**`
- `docs/superpowers/plans/**`

文档审计只标记会误导用户或后续开发的 API 事实错误。历史 archive/plan 不做机械重写；如内容已过期但不影响当前运行，在报告中标为文档债。

## 证据来源

优先级如下：

1. `docs/example/api/bgm-api.json`
2. 当前源码实际调用链
3. README、design、plan 中的 API 描述
4. 本地 OpenAPI 未覆盖的接口使用额外证据标注为“规范缺口”

本地 `bgm-api.json` 已覆盖 `GET /calendar`。OAuth `access_token`、OAuth `token_status` 不在本地 OpenAPI paths 中；审计时必须明确标注 OAuth 规范缺口，不得把未验证内容写成已由本地 OpenAPI 证明。

## 审计矩阵

报告中的每条记录使用以下字段：

| 字段 | 说明 |
| --- | --- |
| ID | 稳定编号，例如 `BGM-API-001` |
| 位置 | 文件路径和行号，或文档路径 |
| 当前写法 | 当前 endpoint/method/body/auth/解析方式 |
| 规范证据 | OpenAPI 或其他证据 |
| 判断 | 正确、错误、可能错误、文档过期、规范缺口 |
| 影响 | 运行失败、误判结果、数据写入风险、文档误导 |
| 建议修法 | 最小修复方向 |
| 优先级 | P0/P1/P2 |
| 验证方式 | 最小测试或命令 |

## 优先级

- `P0`: 当前运行会失败、误判成功/失败，或可能写错用户数据。
- `P1`: 当前可能失败，取决于账号收藏状态、token 类型或 bgm.tv 返回形态。
- `P2`: 文档错误、历史设计过期，当前运行不直接受影响但会误导后续开发。

## 已知候选项

这些候选项必须进入审计矩阵，但最终判断以证据为准。

- 账户同步写回曾使用 `PATCH /v0/users/-/collections/{subject_id}`；同步语义需要新增或修改时应使用 `POST`。
- bgm.tv 写回成功返回 `204 No Content` 时，统一 `res.json()` 会把成功误判为 `Unexpected end of JSON input`。
- `ep_status` 和 `vol_status` 只能用于书籍条目进度；动画、音乐、游戏、三次元写回时不能传。
- `getCollections()` 固定 `subject_type=2` 是否符合“账户同步”产品语义。
- `GET /calendar` 已在本地 OpenAPI 中覆盖；OAuth `access_token`、OAuth `token_status` 不在本地 OpenAPI paths 中，需要标注规范缺口。
- README/spec/plan 中仍可能存在 “PATCH 写回同步” 或过期 body 字段说明。

## 报告结构

审计报告分为两部分。

### Findings

按 P0/P1/P2 排序。每条 finding 必须包含证据、影响、建议修法和验证方式。没有证据的猜测不得进入 findings。

### Fix Batch Proposal

报告末尾给出最小修复批次建议：

- 批次 A：P0 运行缺陷。
- 批次 B：P1 语义和边界。
- 批次 C：P2 用户文档与设计文档同步。

修复批次只是建议，报告阶段不修改实现代码。

## 非目标

- 不通过浏览器直接打开带 `-` 的 URL 判断写接口是否存在。
- 不引入新依赖做 OpenAPI 校验。
- 不重构平台抽象。
- 不批量重写历史 archive。
- 不在审计报告阶段修改代码。

## 验证要求

后续实现阶段的最小验证应覆盖：

- `packages/shared/src/bgm-client.test.ts`：响应解析、204、method/body/auth。
- shared 平台层或 sync apply 测试：账户同步写回语义。
- `pnpm -r test`。
- 必要时 `pnpm -r typecheck`。
